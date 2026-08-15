import type { DiagnosticLogger } from './diagnostic-logger';
import type { ForgeEventSignal, SessionMetaData } from './forge-types';
import { ForemanIpcClient, resolveForemanIpcPath } from './foreman-ipc-client';
import {
  mapForgeEvent,
  type EventsEventType,
  type EventsLine,
  type EventsLineData,
} from './foreman-event-map';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LIMIT = 200;
const STARTUP_DRAIN_LIMIT = 1000;

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
  intervalMs?: number;
  limit?: number;
  request?: ForemanRpcRequest;
  logger?: DiagnosticLogger;
  onSignal: (workerKey: string, signal: ForgeEventSignal, meta: SessionMetaData) => void;
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
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly request: ForemanRpcRequest;
  private readonly onSignal: ForemanEventPollerOptions['onSignal'];
  private readonly logger: DiagnosticLogger | undefined;
  private readonly client: ForemanIpcClient | undefined;
  private readonly workerKeyAliases = new Map<string, string>();
  private readonly hasSpawnByWorker = new Map<string, boolean>();
  private readonly metadataByWorker = new Map<string, SessionMetaData>();
  private readonly taskRunInfoByRunId = new Map<string, TaskRunInfo | null>();
  private readonly taskRunInfoRequests = new Map<string, Promise<TaskRunInfo | null>>();
  private readonly terminalWorkers = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor: string | undefined;
  private inFlight = false;
  private running = false;
  private generation = 0;
  private startedAtMs: number | undefined;
  private lastPollErrorSignature: string | null = null;

  constructor(opts: ForemanEventPollerOptions) {
    this.ipcPath = opts.ipcPath ?? resolveForemanIpcPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    if (opts.request) {
      this.request = opts.request;
    } else {
      this.client = new ForemanIpcClient({ path: this.ipcPath });
      this.request = (method, params) => this.client!.request(method, params);
    }
    this.logger = opts.logger;
    this.onSignal = opts.onSignal;
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  start(): void {
    if (this.intervalId !== null) return;

    this.running = true;
    this.generation++;
    this.startedAtMs = Date.now();
    const generation = this.generation;

    this.logger?.info('foreman_events_poller_started', {
      ipcPath: this.ipcPath,
      cursor: this.cursor,
    });

    void this.pollOnce(generation);
    this.intervalId = setInterval(() => {
      void this.pollOnce(generation);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
    }
    this.intervalId = null;
    if (this.running) {
      this.running = false;
      this.generation++;
    }
    this.logger?.info('foreman_events_poller_stopped');
  }

  async pollOnce(expectedGeneration?: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const prevCursor = this.cursor;
      const payload = await this.request('event.list', this.buildParams(expectedGeneration));
      if (this.isStoppedGeneration(expectedGeneration)) return;

      if (this.lastPollErrorSignature !== null) {
        this.logger?.info('foreman_events_poll_recovered', {
          previousError: this.lastPollErrorSignature,
        });
        this.lastPollErrorSignature = null;
      }

      const parsed = parseEventsPayload(payload, this.logger);
      if (!parsed) {
        this.logger?.warn('foreman_events_invalid_payload');
        return;
      }
      if (this.shouldDrainStartupBacklog(expectedGeneration, prevCursor)) {
        await this.drainStartupBacklog(parsed, expectedGeneration);
        return;
      }

      const countsByType: Record<string, number> = {};
      const startupReplayCountsByType: Record<string, number> = {};
      let startupReplaySkipped = 0;
      for (const event of parsed.events) {
        countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;
        if (this.isStoppedGeneration(expectedGeneration)) return;
        if (this.isStartupReplay(event, expectedGeneration)) {
          startupReplaySkipped++;
          startupReplayCountsByType[event.type] = (startupReplayCountsByType[event.type] ?? 0) + 1;
          continue;
        }
        await this.ingestEvent(event);
      }

      if (this.isStoppedGeneration(expectedGeneration)) return;
      const nextCursor = parsed.cursor ?? parsed.fallbackCursor ?? this.cursor;
      if (nextCursor !== undefined) {
        this.cursor = nextCursor;
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
    } catch (err) {
      const error = pollErrorDetails(err);
      const signature = typeof error === 'string' ? error : `${error.name}:${error.message}`;
      if (signature !== this.lastPollErrorSignature) {
        this.logger?.warn('foreman_events_poll_error', { error });
        this.lastPollErrorSignature = signature;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private buildParams(expectedGeneration?: number): { since?: number; limit: number } {
    const since = this.cursor === undefined ? undefined : Number(this.cursor);
    const limit = since === undefined && expectedGeneration !== undefined
      ? STARTUP_DRAIN_LIMIT
      : this.limit;
    return {
      ...(since !== undefined && Number.isFinite(since) ? { since } : {}),
      limit,
    };
  }

  private async drainStartupBacklog(
    initial: ForemanEventsPayload,
    expectedGeneration: number | undefined,
  ): Promise<void> {
    let parsed = initial;
    let cursor = parsed.cursor ?? parsed.fallbackCursor ?? this.cursor;
    let scanned = parsed.events.length;
    const countsByType: Record<string, number> = {};
    addEventCounts(countsByType, parsed.events);

    while (
      !this.isStoppedGeneration(expectedGeneration)
      && cursor !== undefined
      && parsed.events.length >= STARTUP_DRAIN_LIMIT
    ) {
      const since = Number(cursor);
      if (!Number.isFinite(since)) break;
      const payload = await this.request('event.list', { since, limit: STARTUP_DRAIN_LIMIT });
      const next = parseEventsPayload(payload, this.logger);
      if (!next) break;
      const nextCursor = next.cursor ?? next.fallbackCursor ?? cursor;
      scanned += next.events.length;
      addEventCounts(countsByType, next.events);
      parsed = next;
      if (nextCursor === cursor) break;
      cursor = nextCursor;
    }

    if (cursor !== undefined) {
      this.cursor = cursor;
    }
    this.logger?.info('foreman_events_startup_backlog_drained', {
      nextCursor: this.cursor,
      eventCount: scanned,
      countsByType,
    });
  }

  private shouldDrainStartupBacklog(expectedGeneration: number | undefined, prevCursor: string | undefined): boolean {
    return expectedGeneration !== undefined && prevCursor === undefined;
  }

  private async ingestEvent(event: ForemanEventRecord): Promise<void> {
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
    if (expectedGeneration === undefined || this.startedAtMs === undefined) return false;
    const eventMs = eventTimestampMs(event);
    return eventMs !== null && eventMs < this.startedAtMs;
  }
}

function metaForEvent(
  workerKey: string,
  signal: ForgeEventSignal | null,
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
  return stringIdentity(event.task_run_id) ?? undefined;
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

function addEventCounts(target: Record<string, number>, events: ForemanEventRecord[]): void {
  for (const event of events) {
    target[event.type] = (target[event.type] ?? 0) + 1;
  }
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
