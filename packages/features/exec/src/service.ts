import {
  createAgentClients,
  type AgentClient,
  type AgentEvent,
  type AgentRequest,
  type AgentSession,
  type OperationOptions,
} from '@wrenyard/clients';
import type {
  ExecEventEnvelope,
  ExecFeatureId,
  ExecId,
  ExecSnapshot,
  ExecStatus,
} from '@wrenyard/protocol';
import { ExecReplayBuffer } from './replay.ts';
import type { ExecutionFeature, McpServer } from '@wrenyard/agent-client';

export type { ExecutionFeature, McpServer } from '@wrenyard/agent-client';

/**
 * Bounded wait for a client `result` after its event stream already ended. The
 * agent client's own session contract emits a terminal `exit` frame, so this
 * window only covers a transport that closed without one; it must not grow,
 * because disposal waits on the same drain loop.
 */
const RESULT_SETTLE_GRACE_MS = 1_000;

/** Bounded wait for each live drain loop to observe its terminal frame on close. */
const CLOSE_DRAIN_GRACE_MS = 5_000;

/**
 * Service-level defaults for bounded replay and completed-run retention.
 */
export interface ExecServiceOptions {
  /** Agent clients by id. Defaults to the composed `@wrenyard/clients` map. */
  readonly clients?: ReadonlyMap<string, AgentClient>;
  /** Configured execution features by id. */
  readonly features?: ReadonlyMap<string, ExecutionFeature>;
  /** Configured feature ids to activate when a request names none. */
  readonly defaultFeatures?: readonly ExecFeatureId[];
  /** Maximum retained event records per execution. Defaults to 2 000. */
  readonly maxRetainedEvents?: number;
  /** Maximum retained event bytes per execution. Defaults to 4 MiB. */
  readonly maxRetainedBytes?: number;
  /** Maximum terminal executions retained for later `get`/`events`. Defaults to 200. */
  readonly maxCompletedRuns?: number;
}

/** Acceptance record for a started execution; extends the neutral agent session. */
export interface ExecHandle extends AgentSession {
  readonly id: ExecId;
  /** Snapshot at acceptance; still `running` in the ordinary case. */
  readonly snapshot: ExecSnapshot;
}

/** A request to start one raw prompt execution. */
export interface ExecRequest extends AgentRequest {
  /** Agent client id to run. */
  readonly client: string;
  /** Configured execution-feature ids to activate for this run. */
  readonly features?: readonly ExecFeatureId[];
}

interface ExecEntry {
  readonly id: ExecId;
  readonly client: string;
  readonly replay: ExecReplayBuffer;
  readonly createdAt: number;
  consumer: Promise<void>;
  readonly waiters: Set<() => void>;
  status: ExecStatus;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  exitCodeSeen: boolean;
  /** Set by `cancel()`/`close()`; the drain loop turns it into a cancelled run. */
  cancelRequested: boolean;
  session?: AgentSession;
  terminal: boolean;
}

interface ObservedFacts {
  exitCode?: number | null;
  error?: string;
}

interface PreparedRun {
  readonly entry: ExecEntry;
  readonly request: AgentRequest;
}

/**
 * Raw prompt execution.
 *
 * `ExecService` starts exactly one resolved agent client per request and owns
 * that run's lifecycle: it drains the client's event stream ONCE into a bounded
 * replay buffer, records terminal facts from what it observes, and exposes
 * snapshots, replay reads, and cooperative cancellation.
 *
 * Boundaries this class deliberately does NOT cross:
 *
 * - It never resolves a provider, canonical model, mode, thinking level or
 *   working directory. The caller supplies all of them.
 * - It never touches the task graph, the database or the provider catalog.
 * - It never retries, backs off or opens a circuit: one request starts one run.
 *
 * The single pass over `session.events` is the reason this class exists.
 * Returning the client's iterable as-is to a caller would let whoever iterates
 * first steal events from every later consumer; instead the drain loop is the
 * one reader and every consumer reads the same history through `events(id, n)`.
 */
export class ExecService {
  readonly #clients: ReadonlyMap<string, AgentClient>;
  readonly #features: ReadonlyMap<string, ExecutionFeature>;
  readonly #defaultFeatures: readonly ExecFeatureId[];
  readonly #maxRetainedEvents: number;
  readonly #maxRetainedBytes: number;
  readonly #maxCompletedRuns: number;
  readonly #runs = new Map<ExecId, ExecEntry>();
  #sequence = 0;
  #closed = false;
  readonly #shutdown = new AbortController();

  constructor(options: ExecServiceOptions = {}) {
    this.#clients = options.clients ?? createAgentClients();
    this.#features = options.features ?? new Map();
    this.#defaultFeatures = options.defaultFeatures ?? [];
    this.#maxRetainedEvents = options.maxRetainedEvents ?? 2_000;
    this.#maxRetainedBytes = options.maxRetainedBytes ?? 4 * 1024 * 1024;
    this.#maxCompletedRuns = Math.max(1, Math.trunc(options.maxCompletedRuns ?? 200));
  }

  /**
   * Start one execution and return its handle.
   *
   * Everything that can fail before a child exists — an unknown client, an
   * unknown feature id, a collision between two selected features' MCP servers
   * — rejects here without starting anything, so a rejected `start` never
   * leaves a half-configured run behind.
   */
  async start(request: ExecRequest, options?: OperationOptions): Promise<ExecHandle> {
    if (this.#closed) throw new Error('ExecService is closed');
    const prepared = this.#prepare(request);
    const client = this.#clients.get(prepared.entry.client)!;
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.#shutdown.signal])
      : this.#shutdown.signal;
    const session = await client.start(prepared.request, { ...options, signal });
    if (this.#closed) {
      await session.cancel();
      throw new Error('ExecService is closed');
    }
    const handle = this.#bind(prepared.entry, session);
    void this.#pruneCompleted();
    return handle;
  }

  /** Snapshot of a live or retained execution, or `undefined` when unknown. */
  get(id: ExecId): ExecSnapshot | undefined {
    const entry = this.#runs.get(id);
    return entry ? snapshotOf(entry) : undefined;
  }

  /**
   * Read retained events after `afterSeq` (exclusive), ascending.
   *
   * An unknown execution, a cursor ahead of everything recorded, and a cursor
   * that retention has trimmed past all yield an empty array: this accessor has
   * no result channel for a gap. Callers that must distinguish a real gap use
   * the protocol `exec.events` method, whose adapter reports
   * `exec_cursor_expired` from {@link ExecService.eventsWithGap} instead.
   */
  events(id: ExecId, afterSeq = 0): readonly ExecEventEnvelope[] {
    const entry = this.#runs.get(id);
    if (!entry) throw new Error(`Unknown execution '${id}'`);
    const replay = entry.replay.read(afterSeq);
    if (replay.kind !== 'events') throw new Error('exec_cursor_expired');
    return replay.events;
  }

  /**
   * Read retained events plus the exact gap verdict for a cursor.
   *
   * `oldestRetainedSeq` is present only when the requested cursor is older
   * than retained history, which is the one case a consumer must resynchronise
   * instead of treating the page as complete.
   */
  eventsWithGap(id: ExecId, afterSeq = 0):
    | { readonly events: readonly ExecEventEnvelope[]; readonly nextSeq: number }
    | { readonly oldestRetainedSeq: number } {
    const entry = this.#runs.get(id);
    if (!entry) return { oldestRetainedSeq: 0 };
    const replay = entry.replay.read(afterSeq);
    if (replay.kind === 'cursor-expired') return { oldestRetainedSeq: replay.oldestRetainedSeq };
    return { events: replay.events, nextSeq: replay.nextSeq };
  }

  /**
   * Cooperative cancellation.
   *
   * Cancelling an unknown execution throws; cancelling an already-terminal one
   * is a no-op, because the caller's intent is already satisfied.
   *
   * The caller awaits the CLIENT's own settlement, not our drain loop: a client
   * whose `result` only settles once `cancel()` is observed would deadlock if
   * the drain loop were waiting on that same promise. Flagging the cancel
   * before awaiting guarantees the drain loop records `cancelled` whichever
   * terminal frame arrives first.
   */
  async cancel(id: ExecId): Promise<void> {
    const entry = this.#runs.get(id);
    if (!entry) throw new Error(`Unknown execution '${id}'`);
    if (entry.terminal) return;
    entry.cancelRequested = true;
    const session = entry.session;
    if (!session) return;
    await session.cancel();
  }

  /**
   * Stop accepting new runs and settle every live one.
   *
   * Disposal CANCELS in-flight executions rather than abandoning their
   * children: an agent process must not outlive the service that owns it.
   * Already-terminal runs are untouched, and repeated calls are safe. Each
   * live run is given a short bounded window to observe its terminal frame, so
   * disposal cannot hang on a client that never closes.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort();
    const live = [...this.#runs.values()].filter((entry) => !entry.terminal);
    for (const entry of live) entry.cancelRequested = true;
    await Promise.allSettled(live.map((entry) => entry.session?.cancel() ?? Promise.resolve()));
    await Promise.allSettled(live.map((entry) => withTimeout(entry.consumer, CLOSE_DRAIN_GRACE_MS)));
    // A drain loop that never observed a terminal frame must still surface a
    // terminal state, or `close()` would leave the run reporting `running`.
    for (const entry of live) this.#settle(entry, {});
  }

  /** Resolve the client, activate features, and compose the child request. */
  #prepare(request: ExecRequest): PreparedRun {
    const clientId = request.client.trim();
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Unknown agent client '${clientId}'`);
    if (!client.capabilities.run) throw new Error(`Agent client '${clientId}' cannot start executions`);

    const selected = this.#selectFeatures(request.features ?? this.#defaultFeatures);
    const entry: ExecEntry = {
      id: `exec_${(this.#sequence += 1).toString(36)}_${Date.now().toString(36)}`,
      client: clientId,
      replay: new ExecReplayBuffer({
        maxEvents: this.#maxRetainedEvents,
        maxBytes: this.#maxRetainedBytes,
      }),
      createdAt: Date.now(),
      consumer: Promise.resolve(),
      waiters: new Set(),
      status: 'running',
      exitCodeSeen: false,
      cancelRequested: false,
      terminal: false,
    };

    const { mcpServers, instructions } = mergeFeatures(selected);
    for (const [name, server] of Object.entries(request.mcpServers ?? {})) {
      if (name in mcpServers) throw new Error(`Duplicate MCP server '${name}'`);
      mcpServers[name] = server;
    }
    const { client: _client, features: _features, ...nativeRequest } = request;
    const agentRequest: AgentRequest = {
      ...nativeRequest,
      model: request.mode === 'gateway' && request.provider && request.canonicalModel
        ? `${request.provider}/${request.canonicalModel}` : request.model,
      prompt: composePrompt(request.prompt, instructions),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };
    return { entry, request: agentRequest };
  }

  #selectFeatures(ids: readonly ExecFeatureId[]): readonly ExecutionFeature[] {
    const unknown = ids.filter((id) => !this.#features.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown execution feature${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    }
    return ids.map((id) => this.#features.get(id)!);
  }

  /**
   * Attach the drain loop and publish the handle.
   *
   * The entry is registered BEFORE the consumer is started, and the consumer
   * promise is stored on the entry immediately, so a `close()` racing the first
   * `start()` still finds a live entry and a consumer that exists.
   */
  #bind(entry: ExecEntry, session: AgentSession): ExecHandle {
    entry.session = session;
    this.#runs.set(entry.id, entry);
    entry.consumer = this.#consume(entry, session).catch(() => undefined);
    return {
      id: entry.id,
      snapshot: snapshotOf(entry),
      events: {
        [Symbol.asyncIterator]: async function* (this: ExecService) {
          let cursor = 0;
          for (;;) {
            const batch = this.events(entry.id, cursor);
            for (const envelope of batch) {
              cursor = envelope.seq;
              yield agentEventOf(envelope);
            }
            const current = this.get(entry.id);
            if (!current || current.status !== 'running') {
              const remaining = this.events(entry.id, cursor);
              for (const envelope of remaining) {
                cursor = envelope.seq;
                yield agentEventOf(envelope);
              }
              return;
            }
            await new Promise<void>((resolve) => { entry.waiters.add(resolve); });
          }
        }.bind(this),
      },
      result: entry.consumer.then(() => session.result).then((result) => ({ exitCode: result.exitCode })),
      cancel: () => this.cancel(entry.id),
      diagnostics: session.diagnostics,
    };
  }

  /**
   * Drain the client's event stream exactly once.
   *
   * Every frame is appended to the replay buffer in arrival order and the
   * terminal facts it carries are folded into the entry. Once the stream ends
   * the run is settled from what was observed; `result` is only consulted, for
   * a bounded window, when the stream ended without an exit frame and without
   * an error. That keeps a silently-failing transport from leaving the run
   * `running` forever without ever awaiting a promise that `cancel()` owns.
   */
  async #consume(entry: ExecEntry, session: AgentSession): Promise<void> {
    const observed: ObservedFacts = {};
    try {
      for await (const event of session.events) {
        this.#record(entry, event, observed);
      }
      if (!entry.exitCodeSeen && observed.error === undefined) {
        const result = await withTimeout(session.result, RESULT_SETTLE_GRACE_MS);
        if (result) observed.exitCode = result.exitCode;
      }
    } catch (error) {
      observed.error = error instanceof Error ? error.message : 'execution failed';
      await session.cancel().catch(() => undefined);
    } finally {
      this.#settle(entry, observed);
    }
  }

  #record(entry: ExecEntry, event: AgentEvent, observed: ObservedFacts): void {
    // Wake replay readers after this synchronous append finishes.
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
    if (event.type === 'output') {
      if (event.record.type === 'run_finished' && (event.record.is_error === true || event.record.status === 'failed')) {
        observed.error = typeof event.record.error === 'string' ? event.record.error : 'Agent turn failed';
      }
      entry.replay.append(entry.id, event.record);
      return;
    }
    if (event.type === 'stderr') {
      entry.replay.append(entry.id, { type: 'stderr', text: event.text });
      return;
    }
    if (event.type === 'error') {
      observed.error = event.message;
      entry.replay.append(entry.id, { type: 'error', message: event.message });
      return;
    }
    observed.exitCode = event.exitCode;
    entry.exitCodeSeen = true;
    entry.replay.append(entry.id, {
      type: 'exit',
      exitCode: event.exitCode,
      signal: event.signal,
    });
  }

  #settle(entry: ExecEntry, observed: ObservedFacts): void {
    if (entry.terminal) return;
    entry.terminal = true;
    entry.finishedAt = Date.now();
    if (observed.exitCode !== undefined || entry.exitCodeSeen) {
      entry.exitCode = observed.exitCode ?? entry.exitCode ?? null;
    }

    if (entry.cancelRequested) {
      entry.status = 'cancelled';
      entry.error = 'cancelled';
    } else if (observed.error !== undefined) {
      entry.status = 'failed';
      entry.error = observed.error;
    } else if (entry.exitCode === 0) {
      entry.status = 'completed';
      entry.error = undefined;
    } else {
      entry.status = 'failed';
      entry.error = entry.exitCode === undefined
        ? 'execution ended before reporting an exit code'
        : `execution exited with code ${entry.exitCode}`;
    }
    entry.session = undefined;
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
    void this.#pruneCompleted();
  }

  /** Keep only the newest `maxCompletedRuns` terminal executions. */
  async #pruneCompleted(): Promise<void> {
    const completed = [...this.#runs.values()].filter((entry) => entry.terminal);
    if (completed.length <= this.#maxCompletedRuns) return;
    completed.sort((left, right) => (left.finishedAt ?? left.createdAt) - (right.finishedAt ?? right.createdAt));
    for (const entry of completed.slice(0, completed.length - this.#maxCompletedRuns)) {
      this.#runs.delete(entry.id);
    }
  }
}

function snapshotOf(entry: ExecEntry): ExecSnapshot {
  return {
    id: entry.id,
    client: entry.client,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    ...(entry.terminal ? { exitCode: entry.exitCode ?? null } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
}

/** Rebuild one agent event from a retained envelope for handle consumers. */
function agentEventOf(envelope: ExecEventEnvelope): AgentEvent {
  const record = envelope.event;
  if (record.type === 'stderr' && typeof record.text === 'string') {
    return { type: 'stderr', text: record.text };
  }
  if (record.type === 'error' && typeof record.message === 'string') {
    return { type: 'error', message: record.message };
  }
  if (record.type === 'exit') {
    return {
      type: 'exit',
      exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
      signal: (record.signal as NodeJS.Signals | null | undefined) ?? null,
    };
  }
  return { type: 'output', record };
}

/**
 * Fold the selected features' MCP servers and instructions.
 *
 * Two selected features that both declare the same MCP server name are a
 * configuration conflict, not a merge: silently preferring one would send the
 * model a tool surface neither feature asked for.
 */
function mergeFeatures(features: readonly ExecutionFeature[]): {
  mcpServers: Record<string, McpServer>;
  instructions: string[];
} {
  const mcpServers: Record<string, McpServer> = {};
  const instructions: string[] = [];
  for (const feature of features) {
    for (const [name, server] of Object.entries(feature.mcpServers ?? {})) {
      if (name in mcpServers) {
        throw new Error(`Execution features declare the same MCP server '${name}'`);
      }
      mcpServers[name] = server;
    }
    if (feature.instructions) instructions.push(feature.instructions);
  }
  return { mcpServers, instructions };
}

/** Append selected feature instructions to the raw prompt, in selection order. */
function composePrompt(prompt: string, instructions: readonly string[]): string {
  if (instructions.length === 0) return prompt;
  const sections = instructions.map((text, index) => `# Instruction ${index + 1}\n${text}`);
  return `${prompt}\n\n${sections.join('\n\n')}`;
}

/** Resolve with the promise's value, or `undefined` once `ms` elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}
