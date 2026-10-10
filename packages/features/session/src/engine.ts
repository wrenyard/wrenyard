/**
 * session engine: the session lifecycle and composition of the turn loop.
 *
 * The engine owns session creation, recovery, deletion, media and the
 * observability reads; every work turn runs in {@link TurnRunner}. `index.ts`
 * is the only composition root: it builds the ports and hands them to
 * {@link createEngine}. There is no compatibility mechanism and no legacy role.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectSessionFiles,
  type LedgerEvent,
  type SessionSummary,
  type WorkspaceSnapshot,
} from './ledger.ts';
import { ModelCallError, resolveModelMetadata, type CallRole } from './calls.ts';
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import { ContextInspector, findCreated, type ContextInspectRequest, type ContextInspection } from './context-inspect.ts';
import { type ToolCall } from './driver.ts';
import { isInside, type AttachmentInput, type FileStore } from './media.ts';
import { messageOf } from './errors.ts';
import { ActionRunner } from './actions/index.ts';
import { LiveCalls } from './live.ts';
import type {
  BuiltView,
  EnginePorts,
  InvokedCall,
  LedgerPort,
  LiveCall,
  Session,
  SessionCallHost,
  SessionHost,
} from './ports.ts';
import { ReplyWriter } from './actions/secondary/reply.ts';
import { TurnRunner } from './turn.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';
import { buildSnapshot } from './snapshot.ts';

// ─── Engine ────────────────────────────────────────────────────────────────

export function createEngine(host: SessionHost, ports: EnginePorts): Session {
  return new Engine(host, ports);
}

class Engine implements Session, SessionCallHost {
  readonly host: SessionHost;
  readonly ports: EnginePorts;
  private readonly inspector: ContextInspector;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly live = new LiveCalls();
  private readonly replies: ReplyWriter;
  private readonly turnRunner: TurnRunner;
  private readonly ensuring = new Map<string, Promise<SessionRuntime>>();
  private readonly recoveringTurns = new Set<string>();
  /**
   * Per-session count of in-flight attachment imports/admissions. A plain Set
   * was wrong: two concurrent imports of the same session would let the first
   * `finally` drop the flag while the second was still copying bytes, so a
   * concurrent delete could remove the files directory out from under it.
   */
  private readonly pendingAdmissions = new Map<string, number>();
  /** Sessions deleted in this process; a stale send must not resurrect one. */
  private readonly deletedSessions = new Set<string>();
  private readonly pipeline = new Set<Promise<unknown>>();
  private ready: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(host: SessionHost, ports: EnginePorts) {
    this.host = host;
    this.ports = ports;
    this.replies = new ReplyWriter(this, host.deviceName);
    this.inspector = new ContextInspector({
      workspaceRoot: host.workspaceRoot,
      deviceName: host.deviceName,
      ledger: ports.ledger,
      now: () => this.now(),
      createSnapshot: () => buildSnapshot(this.host),
    });
    for (const summary of ports.ledger.listSessions()) {
      let events: LedgerEvent[];
      try {
        events = ports.ledger.read(summary.sessionId);
      } catch {
        // An unreadable timeline is skipped by recovery too; it must not block startup.
        continue;
      }
      for (const event of events) {
        const key = `${summary.sessionId}:${event.turn}`;
        if (event.type === 'turn.started') this.recoveringTurns.add(key);
        else if (event.type === 'turn.finished') this.recoveringTurns.delete(key);
      }
    }
    this.turnRunner = new TurnRunner(this, this.replies);
    this.ready = this.initialize();
    void this.ready.catch(() => undefined);
  }

  get ledger(): LedgerPort {
    return this.ports.ledger;
  }

  /**
   * Recover every stored session at startup, not only the ones a later `send`
   * touches: a restart must cancel task runs orphaned by any session.
   */
  private async initialize(): Promise<void> {
    await this.ports.ledger.init();
    for (const summary of this.ports.ledger.listSessions()) {
      await this.recoverSession(summary.sessionId).catch(() => {
        // Nothing runs for a turn whose recovery failed, so it is not active work.
        const prefix = `${summary.sessionId}:`;
        for (const key of this.recoveringTurns) {
          if (key.startsWith(prefix)) this.recoveringTurns.delete(key);
        }
      });
    }
  }

  async createSession(): Promise<{ sessionId: string }> {
    this.assertOpen();
    await this.ready;
    const snapshot = await buildSnapshot(this.host);

    const sessionId = randomUUID();
    this.assertOpen();
    this.registerSession(sessionId, this.host.workspaceRoot, snapshot);
    await this.ports.ledger.append(sessionId, {
      type: 'session.created',
      workspaceRoot: this.host.workspaceRoot,
      snapshot,
    });
    return { sessionId };
  }

  listSessions(): SessionSummary[] {
    return this.ports.ledger.listSessions().map((summary) => ({
      ...summary,
      running: this.sessionHasRunningTurns(summary.sessionId),
    }));
  }

  /**
   * Whether a session has an in-flight turn right now. A loaded runtime is
   * checked turn by turn; a session still being recovered at startup is running
   * while any of its recovering turns remain. Never touches the ledger, so it
   * stays a pure read of in-memory state.
   */
  private sessionHasRunningTurns(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        if (!turn.durableTerminal) return true;
      }
    }
    const prefix = `${sessionId}:`;
    for (const key of this.recoveringTurns) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async send(
    sessionId: string,
    input: {
      text: string;
      /** Explicit public reasoning level; required for every turn. */
      model: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      attachments?: AttachmentInput[];
    },
  ): Promise<{ turn: number }> {
    this.assertOpen();
    // Resolve (recovering if needed) the session before any import, copy or append.
    const session = await this.ensureSession(sessionId);
    const publicId = `${input.model.provider}/${input.model.model}`;
    this.assertOpen();
    const metadata = resolveModelMetadata(publicId);
    const effort = input.model.reasoningEffort;
    if (effort === undefined || !REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoningEffort '${effort ?? ''}' is not a valid reasoning effort`);
    }
    if (metadata.reasoningEfforts !== undefined && !metadata.reasoningEfforts.includes(effort)) {
      throw new Error(
        `reasoningEffort '${effort}' is not supported by ${publicId}; expected one of ${metadata.reasoningEfforts.join(', ')}`,
      );
    }

    // A deletion that completed while this send was waiting on the session lock
    // must not be undone by admitting a turn after the fact.
    this.assertNotDeleted(sessionId);

    // Hold an admission for the whole import so a concurrent delete cannot
    // remove the session (and its files directory) out from under this send.
    this.beginAdmission(sessionId);
    let files: Awaited<ReturnType<FileStore['importAttachments']>>;
    try {
      files = input.attachments === undefined || input.attachments.length === 0
        ? []
        : await this.ports.fileStore.importAttachments(sessionId, input.attachments);
    } finally {
      this.endAdmission(sessionId);
    }
    this.assertNotDeleted(sessionId);

    // Turn numbers are assigned synchronously here, so concurrent sends take
    // their numbers in invocation order rather than in resolution order.
    const turnNumber = session.nextTurn;
    session.nextTurn += 1;
    const turn = this.createTurn(turnNumber, input.text, input.model, publicId, metadata.contextWindow);
    session.turns.set(turnNumber, turn);
    if (session.firstUserText === undefined) session.firstUserText = input.text;

    // Durable start: the user event is on disk before `send` returns.
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'turn.started',
        turn: turnNumber,
        text: input.text,
        model: input.model,
      });
    } catch (error) {
      // A turn whose start never reached the timeline was never admitted:
      // forget it so it is not counted active and cannot be interrupted.
      session.turns.delete(turnNumber);
      throw error;
    }

    // The imported files enter the context immediately before the turn runs.
    if (files.length > 0) {
      await this.ports.ledger.append(sessionId, { type: 'files', turn: turnNumber, source: 'user', files });
    }

    this.track(this.turnRunner.runTurn(session, turn));
    return { turn: turnNumber };
  }

  async interrupt(sessionId: string, turn: number): Promise<void> {
    this.assertOpen();
    const operation = this.interruptTurn(sessionId, turn, 'user');
    this.track(operation);
    await operation;
  }

  async readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }> {
    this.assertOpen();
    await this.ready;
    const events = this.ports.ledger.read(sessionId);
    if (findCreated(events) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    // Exact canonical path only; the ledger's own file rows are authoritative.
    const file = collectSessionFiles(events).find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Unknown session file: ${path}`);
    if (!this.isOwnedSessionFile(sessionId, file.path, events)) {
      throw new Error(`Path is outside this session's files: ${path}`);
    }
    if (file.kind !== 'image') return { path: file.path, mime: file.mime };
    const image = await this.ports.fileStore.readImage(file);
    return { path: file.path, mime: file.mime, dataUrl: image.dataUrl };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen();
    await this.ready;
    const prefix = `${sessionId}:`;
    if ([...this.recoveringTurns].some((key) => key.startsWith(prefix))) {
      throw new Error(`Cannot delete a session with a recovering turn: ${sessionId}`);
    }
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) {
      throw new Error(`Cannot delete a session while an attachment import is pending: ${sessionId}`);
    }
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        // A durable terminal alone is not enough: a turn can still be parsing
        // blocks, running actions, or holding late results to flush.
        const lateWork = turn.parsePromises.size > 0
          || turn.actionPromises.size > 0
          || turn.resultQueue.length > 0;
        if (!turn.durableTerminal || lateWork) {
          throw new Error(`Cannot delete a session with a running turn: ${sessionId}`);
        }
      }
    }
    const events = this.ports.ledger.read(sessionId);
    if (events.length === 0 && !runtime) throw new Error(`Unknown session: ${sessionId}`);

    // Mark synchronously, before any await, so a send that already passed its
    // admission check cannot append a turn after the timeline is removed.
    this.deletedSessions.add(sessionId);

    const taskRunIds = new Set<string>();
    for (const event of events) {
      if (event.type === 'action.started' && event.taskRunId !== undefined) taskRunIds.add(event.taskRunId);
    }
    for (const turn of runtime?.turns.values() ?? []) {
      for (const taskRunId of turn.taskRunIds) taskRunIds.add(taskRunId);
    }

    try {
      // Remove only the bounded session files directory and each recorded run's
      // bounded artifact directory. Never a checkout or an arbitrary path.
      assertStorageSegment(sessionId);
      await rm(join(this.host.stateRoot, 'sessions', sessionId), { recursive: true, force: true });
      for (const taskRunId of taskRunIds) {
        assertStorageSegment(taskRunId);
        await rm(join(this.host.stateRoot, 'artifacts', taskRunId), { recursive: true, force: true });
      }
      await this.ports.ledger.deleteSession(sessionId);
    } catch (error) {
      // The session survived a failed deletion; allow it to be used again.
      this.deletedSessions.delete(sessionId);
      throw error;
    }
    this.sessions.delete(sessionId);
    this.ensuring.delete(sessionId);
    this.live.drop(sessionId);
  }

  private async interruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown',
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);
    const runtime = session.turns.get(turn);
    if (!runtime || runtime.finished) return;

    // Flip the terminal flag synchronously so an in-flight continuation cannot
    // race this interrupt into writing a second `turn.finished`.
    runtime.status = 'interrupted';
    runtime.phase = 'terminal';
    runtime.finished = true;
    // Late action results are appended immediately, flagged as post-interrupt.
    runtime.reasonCompleted = true;

    await this.ports.ledger.append(sessionId, { type: 'turn.interrupted', turn, reason });
    runtime.abort.abort();
    // Queued and in-flight replies check this turn's terminal flag before
    // writing. Do not wait for communication belonging to other live turns.
    await Promise.allSettled([...runtime.taskRunIds].map((id) => this.safeCancelTask(id)));
    await this.turnRunner.flushResults(session, runtime);
    await this.ports.ledger.append(sessionId, { type: 'turn.finished', turn, status: 'interrupted' });
    runtime.durableTerminal = true;
  }

  activeTurnCount(): number {
    let count = this.recoveringTurns.size;
    for (const session of this.sessions.values()) {
      for (const turn of session.turns.values()) {
        if (!turn.durableTerminal) count += 1;
      }
    }
    return count;
  }

  hasRunningTurns(): boolean {
    return this.activeTurnCount() > 0;
  }

  readLedger(sessionId: string): LedgerEvent[] {
    return this.ports.ledger.read(sessionId);
  }

  async inspectContext(request: ContextInspectRequest): Promise<ContextInspection> {
    this.assertOpen();
    return this.inspector.inspect(request);
  }

  async previewRoutes(): Promise<{ roles: import('./role-requirements.ts').AuxiliaryRoutePreview[] }> {
    this.assertOpen();
    return { roles: [...await this.host.previewAuxiliaryRoutes()] };
  }

  readLive(sessionId: string): LiveCall[] {
    return this.live.read(sessionId);
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    return this.ports.ledger.subscribe(sessionId, listener);
  }

  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void {
    return this.live.subscribe(sessionId, listener);
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    await this.ready.catch(() => undefined);
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      for (const turn of [...session.turns.values()]) {
        if (!turn.finished) {
          await this.interruptTurn(sessionId, turn.turn, 'shutdown').catch(() => undefined);
        } else if (!turn.abort.signal.aborted) {
          // Abort post-final calls (title) that no interrupt reaches.
          turn.abort.abort();
        }
      }
    }
    // Let every tracked pipeline settle before the timeline is closed.
    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }
    this.live.clear();
    await this.ports.ledger.close();
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  private registerSession(sessionId: string, workspaceRoot: string, snapshot: WorkspaceSnapshot): SessionRuntime {
    // Never resurrect a deleted session from a late recovery.
    this.assertNotDeleted(sessionId);
    const files = this.ports.files(snapshot, workspaceRoot);
    const calls = this.live.wrap(sessionId, this.ports.calls(sessionId));
    const session: SessionRuntime = {
      sessionId,
      workspaceRoot,
      snapshot,
      files,
      actions: new ActionRunner({
        host: this.host,
        files,
        calls,
        fileStore: this.ports.fileStore,
        now: () => this.now(),
      }),
      calls,
      callSeq: 0,
      reasonQueue: Promise.resolve(),
      replyQueue: Promise.resolve(),
      title: '新会话',
      lastTitleVersion: 0,
      titleVersion: 0,
      titleUpdatedWithReply: false,
      turns: new Map(),
      nextTurn: 1,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Single-flight session recovery so concurrent callers share one replay. */
  private async ensureSession(sessionId: string): Promise<SessionRuntime> {
    await this.ready;
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    await this.ready;
    const registered = this.sessions.get(sessionId);
    if (registered) return registered;

    let pending = this.ensuring.get(sessionId);
    if (!pending) {
      pending = this.recoverSession(sessionId);
      this.ensuring.set(sessionId, pending);
      void pending.catch(() => undefined).finally(() => {
        if (this.ensuring.get(sessionId) === pending) this.ensuring.delete(sessionId);
      });
    }
    return pending;
  }

  /** Rebuild a session runtime from its stored timeline. */
  private async recoverSession(sessionId: string): Promise<SessionRuntime> {
    const events = this.ports.ledger.read(sessionId);
    const created = findCreated(events);
    if (!created) throw new Error(`unknown session: ${sessionId}`);
    const session = this.registerSession(sessionId, created.workspaceRoot, created.snapshot);
    this.replay(session, events);
    await this.recover(session, events);
    return session;
  }

  /** Rebuild cheap derived state (title, next turn) from the ledger. */
  private replay(session: SessionRuntime, events: LedgerEvent[]): void {
    let nextTurn = 1;
    for (const event of events) {
      if (typeof event.turn === 'number' && event.turn >= nextTurn) nextTurn = event.turn + 1;
      switch (event.type) {
        case 'title':
          session.title = event.text;
          session.lastTitleVersion += 1;
          session.titleVersion = session.lastTitleVersion;
          break;
        case 'turn.started':
          if (session.firstUserText === undefined) session.firstUserText = event.text;
          break;
        case 'reply':
          session.titleUpdatedWithReply = true;
          break;
        default:
          break;
      }
    }
    session.nextTurn = nextTurn;
  }

  /** Append synthetic interruption for turns the previous process never finished. */
  private async recover(session: SessionRuntime, events: LedgerEvent[]): Promise<void> {
    const started = new Set<number>();
    const finished = new Set<number>();
    const liveTaskRuns = new Map<number, string[]>();

    for (const event of events) {
      if (typeof event.turn !== 'number') continue;
      if (event.type === 'turn.started') started.add(event.turn);
      if (event.type === 'turn.finished') finished.add(event.turn);
      if (event.type === 'action.started' && event.taskRunId !== undefined) {
        liveTaskRuns.set(event.turn, [...(liveTaskRuns.get(event.turn) ?? []), event.taskRunId]);
      }
    }

    for (const turn of started) {
      if (finished.has(turn)) continue;
      await this.ports.ledger.append(session.sessionId, { type: 'turn.interrupted', turn, reason: 'restart' });
      for (const taskRunId of liveTaskRuns.get(turn) ?? []) {
        await this.safeCancelTask(taskRunId);
      }
      await this.ports.ledger.append(session.sessionId, { type: 'turn.finished', turn, status: 'interrupted' });
      this.recoveringTurns.delete(`${session.sessionId}:${turn}`);
    }
  }

  // ── turn state machine ──────────────────────────────────────────────────

  private createTurn(
    turn: number,
    userText: string,
    model: { provider: string; model: string; reasoningEffort: ReasoningEffort },
    publicId: string,
    contextWindow: number | undefined,
  ): TurnRuntime {
    return {
      turn,
      userText,
      model,
      publicId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      imageUnsupported: false,
      phase: 'preparing',
      cycle: 0,
      abort: new AbortController(),
      actions: new Map(),
      finished: false,
      durableTerminal: false,
      resultQueue: [],
      flushPromise: Promise.resolve(),
      dropDeferred: false,
      reasonCompleted: false,
      actionsThisCycle: 0,
      toolCallsThisCycle: 0,
      asksThisCycle: [],
      actionSeq: 0,
      parsePromises: new Set(),
      actionPromises: new Set(),
      cycleText: '',
      taskRunIds: new Set(),
      correctionRequired: false,
      emptyReasonRetried: false,
      currentReasonText: '',
    };
  }

  private isOwnedSessionFile(sessionId: string, path: string, events: readonly LedgerEvent[]): boolean {
    if (isInside(path, join(this.host.stateRoot, 'sessions', sessionId, 'files'))) return true;
    const runIds = new Set<string>();
    for (const event of events) {
      if ((event.type === 'action.started' || event.type === 'files') && event.taskRunId !== undefined) {
        runIds.add(event.taskRunId);
      }
    }
    for (const runId of runIds) {
      if (isInside(path, join(this.host.stateRoot, 'artifacts', runId))) return true;
    }
    return false;
  }

  async appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: TurnRuntime,
    cycle?: number,
  ): Promise<void> {
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'error',
        stage,
        message,
        ...(turn.turn > 0 ? { turn: turn.turn, cycle: cycle ?? turn.cycle } : {}),
      });
    } catch {
      // Error reporting must never take the pipeline down.
    }
  }

  /** Reserve the next call id for one turn. */
  private nextCallId(session: SessionRuntime, turn: TurnRuntime): string {
    return `c${turn.turn}.${++session.callSeq}`;
  }

  /**
   * Run one model call. `calls.ts` writes the `call` event and throws on
   * failure, so every role's failure consequence is decided here.
   */
  async invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra: {
      callId?: string;
      reason?: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      tools?: readonly import('./driver.ts').ToolSpec[];
      maxTokens?: number;
      cycle?: number;
    } = {},
  ): Promise<InvokedCall> {
    const callId = extra.callId ?? this.nextCallId(session, turn);
    try {
      const result = await session.calls.run({
        callId,
        role,
        turn: turn.turn,
        cycle: extra.cycle ?? turn.cycle,
        messages: view.messages,
        layers: view.layers,
        signal: turn.abort.signal,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.onText === undefined ? {} : { onText: extra.onText }),
        ...(extra.onReasoning === undefined ? {} : { onReasoning: extra.onReasoning }),
        ...(extra.onToolCall === undefined ? {} : { onToolCall: extra.onToolCall }),
        ...(extra.tools === undefined ? {} : { tools: extra.tools }),
        ...(extra.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens }),
      });
      return {
        ok: true,
        callId,
        text: result.text,
        toolCalls: result.toolCalls,
        ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
      };
    } catch (error) {
      const reasoning = error instanceof ModelCallError ? error.detail.partialReasoning : undefined;
      return {
        ok: false,
        callId,
        text: '',
        error: messageOf(error),
        ...(reasoning === undefined ? {} : { reasoning }),
      };
    }
  }

  async safeCancelTask(taskRunId: string): Promise<void> {
    try {
      await this.host.cancelTaskRun(taskRunId);
    } catch {
      // Cancellation is best-effort; a stale run id must not fail the turn.
    }
  }

  // ── live streaming snapshots ────────────────────────────────────────────

  track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pipeline.delete(promise));
  }

  now(): Date {
    return this.host.now ? this.host.now() : new Date();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session is closed');
  }

  private assertNotDeleted(sessionId: string): void {
    if (this.deletedSessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
  }

  /** Count one in-flight attachment import for the session. */
  private beginAdmission(sessionId: string): void {
    this.pendingAdmissions.set(sessionId, (this.pendingAdmissions.get(sessionId) ?? 0) + 1);
  }

  /** Release one admission; the entry is dropped only when the last one ends. */
  private endAdmission(sessionId: string): void {
    const remaining = (this.pendingAdmissions.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) this.pendingAdmissions.delete(sessionId);
    else this.pendingAdmissions.set(sessionId, remaining);
  }
}

// ─── shared helpers ────────────────────────────────────────────────────────

/** Guard one storage directory segment (session id / task run id). */
function assertStorageSegment(value: string): void {
  if (value === '.' || value === '..' || value === '' || /[/\\\u0000]/u.test(value)) {
    throw new Error(`invalid storage segment: ${value}`);
  }
}
