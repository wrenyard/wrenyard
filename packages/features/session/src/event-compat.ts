/**
 * Compatibility mappings for stored ledger events.
 *
 * Stored events are never rewritten on disk. When an event field is renamed or
 * reshaped, add its mapping here in the same change and never reject old
 * values. Mappings match by value and not by any format number, so a session
 * started in an old shape and continued with new events is handled, and
 * already-new values pass through unchanged.
 *
 * {@link normalizeStoredEvent} is pure: it never mutates its input. It returns
 * the same object when nothing changes, and otherwise a new frozen copy.
 */
import type { LedgerEvent, SessionCreatedEvent, WsUpdatedEvent } from './ledger.ts';
import type { ActionKind } from './actions/index.ts';
import type { CallRole } from './calls.ts';

/** Old action kind value -> current action kind value. */
const ACTION_KIND_COMPAT: Readonly<Record<string, ActionKind>> = {
  read: 'search',
  write: 'document',
};

/** Old call role value -> current call role value. */
const CALL_ROLE_COMPAT: Readonly<Record<string, CallRole>> = {
  compile: 'dispatch',
  'doc-search': 'search',
};

/** Normalize one stored event to the current shape without mutating it. */
export function normalizeStoredEvent(event: LedgerEvent): LedgerEvent {
  switch (event.type) {
    case 'action.started':
    case 'action.finished': {
      const kind = ACTION_KIND_COMPAT[event.kind];
      if (kind === undefined) return event;
      return deepFreeze({ ...event, kind }) as LedgerEvent;
    }
    case 'call':
    case 'call.started': {
      const role = CALL_ROLE_COMPAT[event.role];
      if (role === undefined) return event;
      return deepFreeze({ ...event, role }) as LedgerEvent;
    }
    case 'ws.updated':
      return normalizeWsUpdated(event);
    case 'session.created':
      return normalizeSessionCreated(event);
    default:
      return event;
  }
}

/**
 * A `ws.updated` that carries a string `path` and no `scope` is the pre-scope
 * shape: rebuild it as a document-scoped update, keep `change` only when it is
 * `created` or `updated` (otherwise `updated`), and drop the old `taskRunId`
 * and `taskStatus` fields.
 */
function normalizeWsUpdated(event: WsUpdatedEvent): LedgerEvent {
  const record = event as unknown as Record<string, unknown>;
  // Already-new events carry a scope; never touch them.
  if (record.scope !== undefined || typeof record.path !== 'string') return event;
  const change = record.change === 'created' || record.change === 'updated' ? record.change : 'updated';
  return deepFreeze({
    type: event.type,
    seq: event.seq,
    at: event.at,
    actionId: record.actionId,
    scope: 'document',
    target: record.path,
    change,
  }) as unknown as LedgerEvent;
}

/**
 * Fill the snapshot fields an older `session.created` may lack, keeping the
 * values that are present. A missing snapshot becomes a fully defaulted one
 * stamped with the event time.
 */
function normalizeSessionCreated(event: SessionCreatedEvent): LedgerEvent {
  const record = event as unknown as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (snapshot === null || typeof snapshot !== 'object') {
    return deepFreeze({
      ...event,
      snapshot: {
        takenAt: event.at,
        deviceName: '',
        agents: '',
        memoryIndex: '',
        builtinTasks: [],
        projects: [],
      },
    }) as LedgerEvent;
  }
  const snap = snapshot as Record<string, unknown>;
  const filled: Record<string, unknown> = {};
  if (snap.projects === undefined) filled.projects = [];
  if (snap.builtinTasks === undefined) filled.builtinTasks = [];
  if (snap.agents === undefined) filled.agents = '';
  if (snap.memoryIndex === undefined) filled.memoryIndex = '';
  if (Object.keys(filled).length === 0) return event;
  return deepFreeze({ ...event, snapshot: { ...snap, ...filled } }) as unknown as LedgerEvent;
}

/** Recursively freeze a value in place and return it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
