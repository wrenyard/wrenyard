import type { DiagnosticLogger } from './diagnostic-logger';
import type { AgentEventSignal, SessionMetaData } from './agent-types';
import { WrenyardDaemonClient, resolveDaemonIpcPath, type DaemonClient } from './client';
import {
  mapForgeEvent,
  type EventsEventType,
  type EventsLine,
  type EventsLineData,
} from './foreman-event-map';

const DEFAULT_LIMIT = 200;
const STARTUP_DRAIN_LIMIT = 1000;
const MAX_CATCHUP_PAGES = 50;
/**
 * Server-side wait for event.list: the daemon holds the request until a
 * committed event insert wakes it or this deadline passes. There is no
 * timer-driven DB polling while idle; each wake performs one catch-up read.
 * Kept below the daemon client's 30s request timeout.
 */
const EVENT_LIST_WAIT_MS = 20_000;
/** Bounded reconnect backoff after a transport error, in milliseconds. */
const RECONNECT_BACKOFF_INITIAL_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 15_000;

const SUPPORTED_EVENT_TYPES = new Set<string>([
  'task.started',
  'task.done',
  'task.failed',
  'dispatch',
  'child-start',
  'queue-acquired',
  'queue-waiting',
  'lock-lost',
  'terminal',
  'turn-complete',
  'cancelled',
  'result',
  'message',
  'tool_call',
  'tool_result',
  'turn_usage',
  'task.usage.live',
]);

export interface ForemanEventRecord extends EventsLine {
  id?: unknown;
  execution_id?: unknown;
  task_run_id?: unknown;
  task_id?: unknown;
  workflow_id?: unknown;
  session_id?: unknown;
  profile?: unknown;
  cwd?: unknown;
  work_dir?: unknown;
  client_family?: unknown;
  seq?: unknown;
  created_at?: unknown;
}

export type ForemanRpcRequest = (method: string, params?: unknown) => Promise<unknown>;

export interface ForemanEventPollerOptions {
  ipcPath?: string;
  /** @deprecated Unused: delivery is event-driven; the poller no longer ticks. */
  intervalMs?: number;
  limit?: number;
  request?: ForemanRpcRequest;
  /** Shared Desktop daemon client; used when no explicit `request` is given. */
  client?: DaemonClient;
  logger?: DiagnosticLogger;
  /**
   * Cursor the owner already holds. The poller resumes from it and never
   * treats a missing cursor as event id 0, so a restart cannot replay history.
   */
  initialCursor?: string | number;
  /** Reports every cursor advance so the owner keeps the durable copy. */
  onCursor?: (cursor: string) => void;
  onSignal: (workerKey: string, signal: AgentEventSignal, meta: SessionMetaData) => void;
  /**
   * Cumulative gateway usage of a still-running task run, emitted by the
   * daemon's task.usage.live events. Keyed by task run id; the daemon
   * throttles emission, so every observed event is forwarded unchanged.
   */
  onTaskUsageLive?: (executionId: string, taskRunId: string, usage: TaskUsageLiveUpdate['usage']) => void;
}

/** One cumulative live-usage push for a still-running gateway task run. */
export interface TaskUsageLiveUpdate {
  executionId: string;
  taskRunId: string;
  usage: {
    input: number;
    cachedInput: number;
    output: number;
    requests: number;
  };
}

interface ForemanEventsPayload {
  events: ForemanEventRecord[];
  cursor?: string;
  fallbackCursor?: string;
}

interface TaskRunInfo {
  taskId: string;
  qualifiedName?: string;
}

export function deriveWorkerIdentityKey(event: ForemanEventRecord): string | null {
  return foremanWorkerKeyCandidates(event)[0]?.value ?? null;
}

export class ForemanEventPoller {
  private readonly ipcPath: string;
  private readonly limit: number;
  private readonly request: ForemanRpcRequest;
  private readonly onSignal: ForemanEventPollerOptions['onSignal'];
  private readonly onTaskUsageLive: ForemanEventPollerOptions['onTaskUsageLive'];
  private readonly onCursor: ForemanEventPollerOptions['onCursor'];
  private readonly logger: DiagnosticLogger | undefined;
  private readonly ownedClient: DaemonClient | undefined;
  private readonly resumeCursor: boolean;
  private readonly workerKeyAliases = new Map<string, string>();
  private readonly hasSpawnByWorker = new Map<string, boolean>();
  private readonly metadataByWorker = new Map<string, SessionMetaData>();
  private readonly taskRunInfoByRunId = new Map<string, TaskRunInfo | null>();
  private readonly taskRunInfoRequests = new Map<string, Promise<TaskRunInfo | null>>();
  private readonly terminalWorkers = new Set<string>();
  private cursor: string | undefined;
  private inFlight = false;
  private running = false;
  private generation = 0;
  private startedAtMs: number | undefined;
  private lastPollErrorSignature: string | null = null;
  private headProbed = false;

  constructor(opts: ForemanEventPollerOptions) {
    this.ipcPath = opts.ipcPath ?? resolveDaemonIpcPath();
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    if (opts.request) {
      this.request = opts.request;
    } else {
      this.ownedClient = opts.client ?? new WrenyardDaemonClient({ path: this.ipcPath });
      this.request = (method, params) => this.ownedClient!.request(method, params);
    }
    this.logger = opts.logger;
    this.onSignal = opts.onSignal;
    this.onTaskUsageLive = opts.onTaskUsageLive;
    this.onCursor = opts.onCursor;
    this.cursor = normalizeCursor(opts.initialCursor);
    this.resumeCursor = this.cursor !== undefined;
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  /** Last cursor this poller observed, for the owner to resume from. */
  getCursor(): string | undefined {
    return this.cursor;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.generation++;
    this.startedAtMs = Date.now();
    const generation = this.generation;

    this.logger?.info('foreman_events_poller_started', {
      ipcPath: this.ipcPath,
      cursor: this.cursor,
    });

    void this.runWaitLoop(generation);
  }

  /**
   * Single serial wait/catch-up loop over the existing event.list IPC channel.
   * Each iteration issues one request with a bounded server-side wait; the
   * daemon blocks it until a committed event insert wakes the request or the
   * deadline passes, so there is no timer-driven polling and never more than
   * one in-flight request. Transport errors apply a bounded exponential
   * reconnect backoff; generation fences discard stale replies after stop().
   */
  private async runWaitLoop(generation: number): Promise<void> {
    let backoffMs = 0;
    while (this.running && this.generation === generation) {
      const ok = await this.pollOnce(generation);
      if (this.isStoppedGeneration(generation)) return;
      if (ok) {
        backoffMs = 0;
        continue;
      }
      backoffMs = backoffMs === 0
        ? RECONNECT_BACKOFF_INITIAL_MS
        : Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
      await sleepUnlessStopped(backoffMs, () => this.isStoppedGeneration(generation));
    }
  }

  stop(): void {
    if (this.running) {
      this.running = false;
      this.generation++;
    }
    this.logger?.info('foreman_events_poller_stopped');
  }

  async pollOnce(expectedGeneration?: number): Promise<boolean> {
    if (this.inFlight) return true;
    this.inFlight = true;

    try {
      await this.probeStaleCursorOnce();
      let params = this.buildParams();
      let payload = await this.request('event.list', params);
      if (this.lastPollErrorSignature !== null) {
        this.logger?.info('foreman_events_poll_recovered', {
          previousError: this.lastPollErrorSignature,
        });
        this.lastPollErrorSignature = null;
      }
      let catchupPages = 0;

      while (true) {
        if (this.isStoppedGeneration(expectedGeneration)) return false;
        const prevCursor = this.cursor;
        const rawPageCount = rawEventsCount(payload);
        const parsed = parseEventsPayload(payload, this.logger);
        if (!parsed) {
          this.logger?.warn('foreman_events_invalid_payload');
          return false;
        }

        const countsByType: Record<string, number> = {};
        const startupReplayCountsByType: Record<string, number> = {};
        let startupReplaySkipped = 0;
        for (const event of parsed.events) {
          countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;
          if (this.isStoppedGeneration(expectedGeneration)) return false;
          if (this.isStartupReplay(event, expectedGeneration)) {
            startupReplaySkipped++;
            startupReplayCountsByType[event.type] = (startupReplayCountsByType[event.type] ?? 0) + 1;
            continue;
          }
          await this.ingestEvent(event);
        }

        if (this.isStoppedGeneration(expectedGeneration)) return false;
        const nextCursor = parsed.cursor ?? parsed.fallbackCursor ?? this.cursor;
        if (nextCursor !== undefined) {
          this.advanceCursor(nextCursor);
        }
        if (parsed.events.length > 0 || prevCursor !== this.cursor) {
          this.logger?.info('foreman_events_poll_success', {
            prevCursor,
            nextCursor: this.cursor,
            eventCount: parsed.events.length,
            countsByType,
            startupReplaySkipped,
            startupReplayCountsByType,
            usedFallbackCursor: parsed.cursor === undefined && parsed.fallbackCursor !== undefined,
          });
        }

        if (rawPageCount < params.limit || this.isStoppedGeneration(expectedGeneration)) return true;
        if (catchupPages >= MAX_CATCHUP_PAGES || this.cursor === prevCursor) return true;
        // Catch-up pages never wait: an empty page terminates the drain so the
        // loop re-enters the daemon-side wait instead of blocking per page.
        params = { since: Number(this.cursor), limit: STARTUP_DRAIN_LIMIT };
        payload = await this.request('event.list', params);
        catchupPages++;
      }
    } catch (err) {
      const error = pollErrorDetails(err);
      const signature = typeof error === 'string' ? error : `${error.name}:${error.message}`;
      if (signature !== this.lastPollErrorSignature) {
        this.logger?.warn('foreman_events_poll_error', { error });
        this.lastPollErrorSignature = signature;
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * A poller with no cursor asks the daemon for the tail, which answers from
   * the current maximum event id instead of replaying history from id 0. The
   * first page is then short or empty, so no further backlog paging happens.
   * Every non-catch-up request carries the bounded server-side wait so the
   * daemon wakes it on committed inserts instead of the client ticking.
   */
  private buildParams(): { since: number; limit: number; waitMs?: number } | { tail: true; limit: number; waitMs: number } {
    if (this.cursor === undefined) return { tail: true, limit: STARTUP_DRAIN_LIMIT, waitMs: EVENT_LIST_WAIT_MS };
    const since = Number(this.cursor);
    if (!Number.isFinite(since)) return { tail: true, limit: STARTUP_DRAIN_LIMIT, waitMs: EVENT_LIST_WAIT_MS };
    return { since, limit: this.limit, waitMs: EVENT_LIST_WAIT_MS };
  }

  /**
   * One-shot guard for a resumed poller whose durable cursor may sit ahead of
   * the daemon head (the daemon returns empty pages with cursor=since when
   * since exceeds head, which would stall forever). On the very first poll a
   * resumed poller requests the head cursor via {tail:true, limit:1} and, if
   * head is lower, rewinds to it so the durable copy is corrected. Probe
   * failures are non-fatal and fall through to normal polling.
   */
  private async probeStaleCursorOnce(): Promise<void> {
    if (this.headProbed) return;
    this.headProbed = true;
    if (!this.resumeCursor || this.cursor === undefined) return;
    try {
      const payload = await this.request('event.list', { tail: true, limit: 1 });
      const parsed = parseEventsPayload(payload, this.logger);
      const head = parsed?.cursor ?? parsed?.fallbackCursor;
      if (head !== undefined && Number.isFinite(Number(head)) && Number(head) < Number(this.cursor)) {
        this.logger?.info('foreman_events_cursor_reset_behind_head', {
          cursor: this.cursor,
          head,
        });
        this.advanceCursor(head);
      }
    } catch {
      // Probe failure must not break polling; the normal since-poll follows.
    }
  }

  private advanceCursor(next: string): void {
    if (next === this.cursor) return;
    this.cursor = next;
    this.onCursor?.(next);
  }

  private async ingestEvent(event: ForemanEventRecord): Promise<void> {
    // Live usage events carry no worker lifecycle signal; they are forwarded
    // directly to the usage subscriber and never enter signal mapping.
    if (event.type === 'task.usage.live') {
      this.forwardTaskUsageLive(event);
      return;
    }
    // Log raw message event before any filtering
    if (event.type === 'message') {
      const rawRole = event.data?.role ?? event.role;
      const rawText = event.data?.text ?? event.text;
      const textLength = typeof rawText === 'string' ? rawText.length : 0;
      const preview = typeof rawText === 'string'
        ? rawText.replace(/\s+/g, ' ').trim().slice(0, 160)
        : undefined;

      this.logger?.info('foreman_events_message_received', {
        id: event.id,
        execution_id: event.execution_id,
        task_id: event.task_id,
        session_id: event.session_id,
        workflow_id: event.workflow_id,
        role: rawRole,
        textLength,
        preview,
      });
    }

    const workerKey = this.resolveWorkerKey(event);
    if (!workerKey) {
      this.logger?.info('foreman_events_event_filtered', {
        reason: 'missing_worker_key',
        id: event.id,
        type: event.type,
      });
      return;
    }
    const hasSpawn = this.hasSpawnByWorker.get(workerKey) ?? false;
    const signal = mapForgeEvent(event, hasSpawn);
    const taskRunInfo = await this.taskRunInfoForEvent(event);
    const meta = metaForEvent(workerKey, signal, event, taskRunInfo, this.metadataByWorker.get(workerKey));
    this.metadataByWorker.set(workerKey, meta);
    if (!signal) {
      if (event.type === 'message') {
        this.logger?.info('foreman_events_event_filtered', {
          reason: 'map_returned_null',
          id: event.id,
          type: event.type,
        });
      }
      return;
    }

    if (signal.kind === 'done' || signal.kind === 'failed') {
      if (this.terminalWorkers.has(workerKey)) {
        this.logger?.info('foreman_events_event_filtered', {
          reason: 'duplicate_terminal_event',
          id: event.id,
          type: event.type,
          task_id: event.task_id,
          execution_id: event.execution_id,
        });
        return;
      }
      this.terminalWorkers.add(workerKey);
    }

    if (signal.kind !== 'done' && signal.kind !== 'failed') {
      this.hasSpawnByWorker.set(workerKey, true);
    }

    // Log successfully ingested message
    if (signal.kind === 'message') {
      const textLength = typeof signal.text === 'string' ? signal.text.length : 0;
      const preview = typeof signal.text === 'string'
        ? signal.text.replace(/\s+/g, ' ').trim().slice(0, 160)
        : undefined;

      this.logger?.info('foreman_events_message_ingested', {
        id: event.id,
        workerKey,
        textLength,
        preview,
      });
    }

    this.onSignal(workerKey, signal, meta);
  }

  private forwardTaskUsageLive(event: ForemanEventRecord): void {
    const data = isRecord(event.data) ? event.data : undefined;
    const usage = isRecord(data?.usage) ? data.usage : undefined;
    // refs.executionId is the stable gateway-run identity; refs.taskRunId lands
    // on event.task_run_id through normalizeForemanEvent and data.taskRunId is
    // the fallback for rows persisted before the ref existed.
    const executionId =
      stringIdentity(event.execution_id)
      ?? (typeof data?.executionId === 'string' ? data.executionId : undefined);
    const taskRunId =
      stringIdentity(event.task_run_id)
      ?? (typeof data?.taskRunId === 'string' ? data.taskRunId : undefined);
    if (executionId === undefined || taskRunId === undefined || usage === undefined) return;
    const input = numberCursor(usage.input);
    const cachedInput = numberCursor(usage.cachedInput);
    const output = numberCursor(usage.output);
    const requests = numberCursor(usage.requests);
    if (input === undefined || cachedInput === undefined || output === undefined || requests === undefined) return;
    this.onTaskUsageLive?.(executionId, taskRunId, { input, cachedInput, output, requests });
  }

  private async taskRunInfoForEvent(event: ForemanEventRecord): Promise<TaskRunInfo | null> {
    const runId = taskRunIdForStatusLookup(event);
    return runId ? this.lookupTaskRunInfo(runId) : null;
  }

  private async lookupTaskRunInfo(taskRunId: string): Promise<TaskRunInfo | null> {
    if (this.taskRunInfoByRunId.has(taskRunId)) {
      return this.taskRunInfoByRunId.get(taskRunId) ?? null;
    }
    const existing = this.taskRunInfoRequests.get(taskRunId);
    if (existing) return existing;

    const request = this.request('task.run.status', { task_run_id: taskRunId })
      .then(taskRunInfoFromStatus)
      .catch((err) => {
        this.logger?.warn('foreman_task_run_lookup_failed', {
          taskRunId,
          error: pollErrorDetails(err),
        });
        return null;
      })
      .then((info) => {
        this.taskRunInfoByRunId.set(taskRunId, info);
        return info;
      })
      .finally(() => {
        this.taskRunInfoRequests.delete(taskRunId);
      });

    this.taskRunInfoRequests.set(taskRunId, request);
    return request;
  }

  private resolveWorkerKey(event: ForemanEventRecord): string | null {
    const candidates = foremanWorkerKeyCandidates(event);
    if (candidates.length === 0) return null;

    const canonicalKey = candidates
      .map((candidate) => this.workerKeyAliases.get(candidate.alias))
      .find((alias): alias is string => alias !== undefined) ?? candidates[0].value;

    for (const candidate of candidates) {
      this.workerKeyAliases.set(candidate.alias, canonicalKey);
    }

    return canonicalKey;
  }

  private isStoppedGeneration(expectedGeneration: number | undefined): boolean {
    return expectedGeneration !== undefined && (!this.running || this.generation !== expectedGeneration);
  }

  private isStartupReplay(event: ForemanEventRecord, expectedGeneration: number | undefined): boolean {
    // A resumed poller continues from the owner's cursor, so everything the
    // daemon returns after it is genuinely new and must be ingested.
    if (this.resumeCursor) return false;
    if (expectedGeneration === undefined || this.startedAtMs === undefined) return false;
    const eventMs = eventTimestampMs(event);
    return eventMs !== null && eventMs < this.startedAtMs;
  }
}

function rawEventsCount(payload: unknown): number {
  return isRecord(payload) && Array.isArray(payload.events) ? payload.events.length : 0;
}

/**
 * Reconnect-backoff sleep that wakes early (in coarse slices) once the poller
 * is stopped, so stop() does not wait out the full backoff window.
 */
function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (isStopped() || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(200, deadline - Date.now()));
    };
    tick();
  });
}

function metaForEvent(
  workerKey: string,
  signal: AgentEventSignal | null,
  event: ForemanEventRecord,
  taskRunInfo: TaskRunInfo | null,
  previous?: SessionMetaData,
): SessionMetaData {
  const profile = eventString(event, 'profile') ?? eventDataString(event, 'profile') ?? previous?.profile ?? 'foreman';
  const workDir = eventString(event, 'cwd')
    ?? eventString(event, 'work_dir')
    ?? eventDataString(event, 'cwd')
    ?? eventDataString(event, 'work_dir')
    ?? eventDataString(event, 'workDir')
    ?? previous?.workDir
    ?? '';
  const clientFamily = eventString(event, 'client_family')
    ?? eventDataString(event, 'client_family')
    ?? eventDataString(event, 'clientFamily')
    ?? previous?.clientFamily;
  const taskId = taskRunInfo?.taskId ?? previous?.taskId;
  const taskName = taskRunInfo?.taskId ?? previous?.taskName;
  const taskLabel = taskName ?? taskId ?? previous?.taskLabel;
  const foremanTaskRunID = foremanTaskRunIdForEvent(event) ?? previous?.foremanTaskRunID;
  const meta: SessionMetaData = {
    workerIdentityKey: workerKey,
    profile,
    workDir,
    isWorktree: workDir.includes('.worktrees'),
    status: signal?.kind === 'done' ? 'done' : signal?.kind === 'failed' ? 'failed' : 'running',
  };

  if (foremanTaskRunID !== undefined) {
    meta.foremanTaskRunID = foremanTaskRunID;
  }
  if (clientFamily !== undefined) {
    meta.clientFamily = clientFamily;
  }
  if (taskId !== undefined) {
    meta.taskId = taskId;
  }
  if (taskName !== undefined) {
    meta.taskName = taskName;
  }
  if (taskLabel !== undefined) {
    meta.taskLabel = taskLabel;
  }

  return meta;
}

function pollErrorDetails(err: unknown): { name: string; message: string } | string {
  return err instanceof Error ? { name: err.name, message: err.message } : String(err);
}

function parseEventsPayload(payload: unknown, logger?: DiagnosticLogger): ForemanEventsPayload | null {
  if (!isRecord(payload)) {
    logger?.warn('foreman_events_invalid_payload_shape', { reason: 'not_a_record' });
    return null;
  }
  if (!Array.isArray(payload.events)) {
    logger?.warn('foreman_events_invalid_payload_shape', { reason: 'events_not_an_array' });
    return null;
  }

  const fallbackCursor = maxNumericCursor(payload.events, 'id') ?? maxNumericCursor(payload.events, 'seq');
  const events: ForemanEventRecord[] = [];
  for (const raw of payload.events) {
    const event = normalizeForemanEvent(raw, logger);
    if (event) events.push(event);
  }

  return {
    events,
    ...(cursorToString(payload.cursor) !== undefined ? { cursor: cursorToString(payload.cursor) } : {}),
    ...(fallbackCursor !== undefined ? { fallbackCursor } : {}),
  };
}

function normalizeForemanEvent(raw: unknown, logger?: DiagnosticLogger): ForemanEventRecord | null {
  if (!isRecord(raw)) {
    logger?.warn('foreman_events_malformed_event', { reason: 'not_a_record' });
    return null;
  }
  const type = typeof raw.type === 'string' ? normalizeEventType(raw.type) : null;
  if (!type || !SUPPORTED_EVENT_TYPES.has(type)) {
    logger?.warn('foreman_events_unsupported_event_type', {
      type: typeof raw.type === 'string' ? raw.type : typeof raw.type,
    });
    return null;
  }

  const payload = isRecord(raw.data) ? raw.data : undefined;
  const refs = isRecord(payload?.refs) ? payload.refs : undefined;
  const data = isRecord(payload?.data) ? payload.data : payload;
  const event = {
    ...raw,
    type: type as EventsEventType,
  } as ForemanEventRecord;

  if (isRecord(data)) {
    event.data = normalizeEventData(type, data) as EventsLineData;
  } else {
    delete event.data;
  }
  if (event.task_run_id === undefined && refs?.taskRunId !== undefined) event.task_run_id = refs.taskRunId;
  if (event.task_run_id === undefined && refs?.taskId !== undefined) event.task_run_id = refs.taskId;
  if (event.task_id === undefined && refs?.taskId !== undefined) event.task_id = refs.taskId;
  if (event.workflow_id === undefined && refs?.workflowId !== undefined) event.workflow_id = refs.workflowId;
  if (event.execution_id === undefined && refs?.executionId !== undefined) event.execution_id = refs.executionId;
  if (event.session_id === undefined && refs?.sessionId !== undefined) event.session_id = refs.sessionId;

  if (event.timestamp === undefined && typeof raw.created_at === 'string') {
    event.timestamp = raw.created_at;
  }

  return event;
}

function normalizeEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type !== 'message' || data.text !== undefined) return data;
  const text = stringField(data.text)
    ?? stringField(data.body)
    ?? stringField(data.message)
    ?? stringField(data.title)
    ?? stringField(data.summary);
  if (!text) return data;
  return {
    ...data,
    role: stringField(data.role) ?? 'foreman',
    text,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function normalizeEventType(type: string): string {
  switch (type) {
    case 'task.run.started':
      return 'task.started';
    case 'task.run.completed':
      return 'task.done';
    case 'task.run.failed':
      return 'task.failed';
    case 'task.run.progress':
      return 'message';
    case 'workflow.run.started':
      return 'dispatch';
    case 'workflow.run.completed':
      return 'task.done';
    case 'workflow.run.failed':
      return 'task.failed';
    case 'workflow.run.checkpointed':
      return 'message';
    default:
      return type;
  }
}

function maxNumericCursor(events: unknown[], field: 'id' | 'seq'): string | undefined {
  let maxValue: number | undefined;
  for (const event of events) {
    if (!isRecord(event)) continue;
    const value = numberCursor(event[field]);
    if (value === undefined) continue;
    if (maxValue === undefined || value > maxValue) maxValue = value;
  }
  return maxValue === undefined ? undefined : String(maxValue);
}

function eventTimestampMs(event: ForemanEventRecord): number | null {
  if (typeof event.timestamp === 'string') {
    const ms = Date.parse(event.timestamp);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof event.created_at === 'string') {
    const ms = Date.parse(event.created_at);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof event.ts === 'number' && Number.isFinite(event.ts)) {
    return event.ts;
  }
  return null;
}

function numberCursor(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cursorToString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function normalizeCursor(value: string | number | undefined): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function stringIdentity(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function foremanWorkerKeyCandidates(event: ForemanEventRecord): Array<{ alias: string; value: string }> {
  // task_run_id is preserved separately as foremanTaskRunID (see metaForEvent).
  // workerIdentityKey falls back through workflow/session/execution/id so that
  // a worker (session/workflow) persists across multiple task runs.
  return uniqueCandidates([
    candidateIdentity('workflow_id', event.workflow_id),
    candidateIdentity('session_id', event.session_id),
    candidateIdentity('execution_id', event.execution_id),
    candidateIdentity('id', event.id),
  ]);
}

/** Actual task_run_id, preserved separately as foremanTaskRunID. */
function foremanTaskRunIdForEvent(event: ForemanEventRecord): string | undefined {
  return taskRunIdForStatusLookup(event);
}

function taskRunIdForStatusLookup(event: ForemanEventRecord): string | undefined {
  const explicit = stringIdentity(event.task_run_id) ?? undefined;
  if (explicit) return explicit;
  const taskId = stringIdentity(event.task_id) ?? undefined;
  return taskId && isGeneratedTaskRunId(taskId) ? taskId : undefined;
}

function isGeneratedTaskRunId(value: string): boolean {
  return /^task[-_][0-9a-f]{8}$/iu.test(value);
}

function taskRunInfoFromStatus(value: unknown): TaskRunInfo | null {
  if (!isRecord(value)) return null;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const taskId = stringField(meta?.template);
  if (!taskId) return null;
  return {
    taskId,
    ...(stringField(meta?.qualified_name) ? { qualifiedName: stringField(meta?.qualified_name) } : {}),
  };
}

function candidateIdentity(field: string, value: unknown): { alias: string; value: string } | null {
  const identity = stringIdentity(value);
  return identity === null ? null : { alias: `${field}:${identity}`, value: identity };
}

function eventString(event: ForemanEventRecord, field: string): string | undefined {
  const value = event[field as keyof ForemanEventRecord];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function eventDataString(event: ForemanEventRecord, field: string): string | undefined {
  if (!isRecord(event.data)) return undefined;
  const value = event.data[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function uniqueCandidates(
  candidates: Array<{ alias: string; value: string } | null>,
): Array<{ alias: string; value: string }> {
  const seen = new Set<string>();
  const unique: Array<{ alias: string; value: string }> = [];

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.alias)) continue;
    seen.add(candidate.alias);
    unique.push(candidate);
  }

  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
