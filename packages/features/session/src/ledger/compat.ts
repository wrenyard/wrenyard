/**
 * Transitional ledger compatibility.
 *
 * Transitional code for the 2026-10 ledger redesign: it maps one stored event
 * of any historical shape onto the current `ledger/events.ts` model, one to
 * one, keeping `seq` and `at`. Delete this module when pre-redesign sessions no
 * longer need to open.
 *
 * {@link normalizeStoredEvent} is pure: it never mutates its input, it returns
 * a new frozen object for every event it rewrites, and an event already in the
 * current shape passes through unchanged. Mappings match by field value, not by
 * a format number, so a session started in an old shape and continued with new
 * events is handled.
 */
import type { CallRole } from '../model/request.ts';
import { stepId, turnId, type LedgerEvent, type ActionType } from './events.ts';

/** Old action-kind value -> current reasoning action type. */
const ACTION_KIND_COMPAT: Readonly<Record<string, ActionType>> = {
  read: 'search',
  write: 'document',
};

/** Old call-role value -> current call role. */
const CALL_ROLE_COMPAT: Readonly<Record<string, CallRole>> = {
  compile: 'dispatch',
  'doc-search': 'search',
};

type Rec = Record<string, unknown>;

/** Normalize one stored event to the current shape without mutating it. */
export function normalizeStoredEvent(raw: unknown): LedgerEvent {
  const event = raw as Rec;
  switch (event.type) {
    case 'turn.started':
      return freeze({ ...event, id: event.id ?? turnId(number(event.turn)) });
    case 'turn.finished':
      return freeze({ ...event, id: event.id ?? turnId(number(event.turn)) });
    case 'turn.interrupted':
      return freeze({ ...event, parent: event.parent ?? turnId(number(event.turn)) });
    case 'cycle.started':
      return freeze({
        type: 'step.started',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        step: event.cycle,
        id: stepId(number(event.turn), number(event.cycle)),
        parent: turnId(number(event.turn)),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
        ...(event.lastInputTokens === undefined ? {} : { lastInputTokens: event.lastInputTokens }),
      });
    case 'call.started':
      return mapCallStarted(event);
    case 'call':
      return mapCall(event);
    case 'thinking':
      return freeze({
        type: 'reasoning.thinking',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        parent: event.parent ?? event.callId,
        text: event.text ?? '',
      });
    case 'reason.completed':
      return freeze({
        type: 'reasoning.completed',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        parent: event.parent ?? event.callId,
        text: event.text ?? '',
        ...(event.workerOutput === undefined ? {} : { workerOutput: event.workerOutput }),
      });
    case 'doc.search':
      return freeze({
        type: 'document.found',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        parent: event.actionId,
        understanding: event.understanding,
        picks: event.picks,
        near: event.near,
        notes: event.notes,
      });
    case 'doc.content':
      return freeze({
        type: 'document.content',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        ...(event.actionId === undefined ? {} : { parent: event.actionId }),
        path: event.path,
        title: event.title,
        updated: event.updated,
        version: event.version,
        tokens: event.tokens,
        content: event.content,
        format: event.format,
        ...(event.base === undefined ? {} : { base: event.base }),
        source: event.source,
      });
    case 'files':
      return freeze({
        type: 'files.attached',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        ...(event.actionId === undefined ? {} : { parent: event.actionId }),
        source: event.source,
        files: event.files,
        ...(event.taskRunId === undefined ? {} : { taskRunId: event.taskRunId }),
      });
    case 'memory.recalled':
      return freeze({
        type: 'memory.recalled',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        ...((event.parent ?? event.actionId) === undefined ? {} : { parent: event.parent ?? event.actionId }),
        version: event.version,
        source: event.source,
        path: event.path,
        content: event.content,
      });
    case 'session.created':
      return mapSessionCreated(event);
    case 'ws.updated': {
      // A record with a string `path` and no `scope` is the pre-scope shape: a
      // document-scoped update whose change is `created` or `updated`.
      const preScope = event.scope === undefined && typeof event.path === 'string';
      return freeze({
        type: 'workspace.changed',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        parent: event.parent ?? event.actionId,
        scope: preScope ? 'document' : event.scope,
        target: preScope ? event.path : event.target,
        change: preScope && event.change !== 'created' ? 'updated' : event.change,
        ...(preScope ? {} : {
          ...(event.worktreeId === undefined ? {} : { worktreeId: event.worktreeId }),
          ...(event.version === undefined ? {} : { version: event.version }),
          ...(event.hash === undefined ? {} : { hash: event.hash }),
          ...(event.files === undefined ? {} : { files: event.files }),
        }),
      });
    }
    case 'action.started':
      return mapActionStarted(event);
    case 'action.titled':
      return mapActionTitled(event);
    case 'action.finished':
      return mapActionFinished(event);
    case 'reply':
      return freeze({
        type: 'reply.sent',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        ...(typeof event.callId === 'string' ? { parent: event.callId } : {}),
        text: event.text ?? '',
      });
    case 'title':
      return freeze({
        type: 'session.titled',
        seq: event.seq,
        at: event.at,
        ...(typeof event.callId === 'string' ? { parent: event.callId } : {}),
        text: event.text ?? '',
      });
    case 'error': {
      const parent = event.parent ?? (typeof event.turn === 'number' ? turnId(event.turn) : undefined);
      return freeze({
        type: 'system.error',
        seq: event.seq,
        at: event.at,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.cycle === undefined ? {} : { step: event.cycle }),
        ...(parent === undefined ? {} : { parent }),
        source: 'system',
        code: event.stage ?? '',
        message: event.message ?? '',
      });
    }
    default:
      return freeze(withStep(event));
  }
}

/** Old `call.started` -> `span.started`. */
function mapCallStarted(event: Rec): LedgerEvent {
  const role = (CALL_ROLE_COMPAT[event.role as string] ?? event.role) as string | undefined;
  const kind = role === 'reason' ? 'reasoning' : 'auxiliary';
  const parent = typeof event.cycle === 'number'
    ? stepId(number(event.turn), event.cycle)
    : turnId(number(event.turn));
  return freeze({
    type: 'span.started',
    seq: event.seq,
    at: event.at,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.cycle === undefined ? {} : { step: event.cycle }),
    id: event.callId,
    parent,
    kind,
    request: {
      ...(role === undefined || role === 'reason' ? {} : { role }),
      model: event.model,
      inputEstimate: 0,
      layers: {},
    },
  });
}

/** Old `call` -> `span.finished` with transport metrics. */
function mapCall(event: Rec): LedgerEvent {
  const role = (CALL_ROLE_COMPAT[event.role as string] ?? event.role) as string | undefined;
  const kind = role === 'reason' ? 'reasoning' : 'auxiliary';
  const metrics: Rec = {};
  const usage = mapUsage(event.usage);
  if (usage !== undefined) metrics.usage = usage;
  const ttftMs = diffMs(event.startedAt, event.firstTokenAt);
  if (ttftMs !== undefined) metrics.ttftMs = ttftMs;
  const tps = event.tps;
  if (tps !== null && typeof tps === 'object') {
    const sample = tps as Rec;
    if (typeof sample.windowMs === 'number') metrics.streamMs = sample.windowMs;
    if (typeof sample.outputTokens === 'number') metrics.streamTokens = sample.outputTokens;
  }
  metrics.attempts = mapAttempts(event);
  const status = event.status;
  return freeze({
    type: 'span.finished',
    seq: event.seq,
    at: event.at,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.cycle === undefined ? {} : { step: event.cycle }),
    id: event.callId,
    kind,
    status,
    ...(status === 'ok' && typeof event.output === 'string' ? { output: event.output } : {}),
    ...(typeof event.reasoning === 'string' ? { reasoning: event.reasoning } : {}),
    ...(event.error === undefined ? {} : { error: typeof event.error === 'string' ? { kind: 'protocol', message: event.error } : event.error }),
    metrics,
  });
}

/**
 * Fill the snapshot fields an older `session.created` may lack, keeping the
 * values that are present. A missing snapshot becomes a fully defaulted one
 * stamped with the event time.
 */
function mapSessionCreated(event: Rec): LedgerEvent {
  const snapshot = event.snapshot;
  if (snapshot === null || typeof snapshot !== 'object') {
    return freeze({
      ...event,
      snapshot: { takenAt: event.at, deviceName: '', agents: '', memoryIndex: '', builtinTasks: [], projects: [] },
    });
  }
  const snap = snapshot as Rec;
  return freeze({
    ...event,
    snapshot: {
      ...snap,
      projects: snap.projects ?? [],
      builtinTasks: snap.builtinTasks ?? [],
      agents: snap.agents ?? '',
      memoryIndex: snap.memoryIndex ?? '',
    },
  });
}

/** Old action.started -> reasoning action.started; new events pass through. */
function mapActionStarted(event: Rec): LedgerEvent {
  if (event.action !== undefined) return freeze(withStep(event));
  const kind = ACTION_KIND_COMPAT[event.kind as string] ?? event.kind;
  const parsed = event.parsed;
  const prompt = parsed !== null && typeof parsed === 'object' && typeof (parsed as Rec).intent === 'string'
    ? String((parsed as Rec).intent)
    : '';
  return freeze({
    type: 'action.started',
    seq: event.seq,
    at: event.at,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.cycle === undefined ? {} : { step: event.cycle }),
    id: event.actionId,
    parent: typeof event.cycle === 'number'
      ? stepId(number(event.turn), event.cycle)
      : turnId(number(event.turn)),
    action: { type: kind, prompt },
    input: event.parsed,
    ...(event.taskRunId === undefined ? {} : { taskRunId: event.taskRunId }),
  });
}

/** Old action.titled -> id-based action.titled; new events pass through. */
function mapActionTitled(event: Rec): LedgerEvent {
  if (event.actionId === undefined) return freeze(withStep(event));
  return freeze({
    type: 'action.titled',
    seq: event.seq,
    at: event.at,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.cycle === undefined ? {} : { step: event.cycle }),
    id: event.actionId,
    title: event.title,
  });
}

/** Old action.finished -> reasoning action.finished; new events pass through. */
function mapActionFinished(event: Rec): LedgerEvent {
  if (event.action !== undefined) return freeze(withStep(event));
  const kind = ACTION_KIND_COMPAT[event.kind as string] ?? event.kind;
  return freeze({
    type: 'action.finished',
    seq: event.seq,
    at: event.at,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.cycle === undefined ? {} : { step: event.cycle }),
    id: event.actionId,
    action: { type: kind },
    status: event.status,
    result: event.result ?? '',
    ...(event.task === undefined ? {} : { task: event.task }),
    ...(event.taskStatus === undefined ? {} : { taskStatus: event.taskStatus }),
    ...(event.taskRunId === undefined ? {} : { taskRunId: event.taskRunId }),
    ...(event.afterInterrupt === undefined ? {} : { afterInterrupt: event.afterInterrupt }),
  });
}

/** Old usage field names -> current `*Tokens` names. */
function mapUsage(value: unknown): Rec | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const usage = value as Rec;
  const mapped: Rec = {};
  if (typeof usage.input === 'number') mapped.inputTokens = usage.input;
  if (typeof usage.cachedInput === 'number') mapped.cachedInputTokens = usage.cachedInput;
  if (typeof usage.output === 'number') mapped.outputTokens = usage.output;
  if (typeof usage.reasoning === 'number') mapped.reasoningTokens = usage.reasoning;
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/** Old `retries` plus the overall duration -> the current attempt list. */
function mapAttempts(event: Rec): Rec[] {
  const attempts: Rec[] = [];
  const retries = Array.isArray(event.retries) ? event.retries : [];
  for (const retry of retries) {
    if (retry === null || typeof retry !== 'object') continue;
    const record = retry as Rec;
    attempts.push({
      ...(typeof record.status === 'number' ? { status: record.status } : {}),
      ...(record.kind === undefined ? {} : { error: record.kind }),
      ms: 0,
      ...(typeof record.delayMs === 'number' ? { waitedMs: record.delayMs } : {}),
    });
  }
  const ms = diffMs(event.startedAt, event.endedAt);
  attempts.push(ms === undefined ? { ms: 0 } : { ms });
  return attempts;
}

/** Milliseconds between two ISO timestamps, when both are present. */
function diffMs(from: unknown, to: unknown): number | undefined {
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return end - start;
}

/** Rename the old `cycle` index field to `step`, without mutating the input. */
function withStep(event: Rec): Rec {
  if (event.cycle === undefined || event.step !== undefined) return event;
  const { cycle, ...rest } = event;
  return { ...rest, step: cycle };
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Recursively freeze a value in place and return it as a ledger event. */
function freeze(value: unknown): LedgerEvent {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Rec)) freeze(nested);
    Object.freeze(value);
  }
  return value as LedgerEvent;
}
