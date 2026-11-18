/**
 * Harness session ledger event vocabulary and timeline file helpers.
 */
import type { SessionFile } from '@wrenyard/protocol';
import type { LedgerEvent, LedgerEventType } from '@wrenyard/protocol/session';
import type { SessionPage } from '@wrenyard/session';

export type {
  LedgerEventType,
  LedgerEventBase,
  TurnStatus,
  TurnModel,
  TaskBrief,
  ProjectSnapshot,
  WorkspaceSnapshot,
  SessionCreatedEvent,
  TurnStartedEvent,
  TurnSteeredEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnAttentionEvent,
  TurnWaitingEvent,
  TurnWaitingClearedEvent,
  StepStatus,
  StepStartedEvent,
  StepFinishedEvent,
  ActionType,
  ActionStatus,
  ActionStartedEvent,
  ActionTitledEvent,
  ActionFinishedEvent,
  SpanKind,
  SpanStatus,
  SpanRoute,
  ModelSpanRequest,
  TaskSpanRequest,
  TaskSpanMetrics,
  SpanError,
  ModelSpanStartedEvent,
  TaskSpanStartedEvent,
  SpanStartedEvent,
  ModelSpanFinishedEvent,
  TaskSpanFinishedEvent,
  SpanFinishedEvent,
  SpanContextEvent,
  ReasoningThinkingEvent,
  ReasoningCompletedEvent,
  MemoryRecalledEvent,
  DocPick,
  DocumentFoundEvent,
  DocumentContentEvent,
  FilesAttachedEvent,
  WorkspaceChangedEvent,
  ReplySentEvent,
  SessionTitledEvent,
  SessionMetadataEvent,
  ContextCompactedEvent,
  ContextReducedEvent,
  SystemNoticeEvent,
  LedgerEvent,
  LedgerEventDraft,
  SessionSummary,
} from '@wrenyard/protocol/session';
export { REPLY_FALLBACK_SOURCES } from '@wrenyard/protocol/session';

/** One bounded timeline page, in `seq` order. */
export type LedgerPage = SessionPage<LedgerEvent>;

/**
 * Event types that may enter the rendered model context. Everything else is
 * observational; a span is never rendered.
 */
export const CONTEXT_EVENT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>([
  'turn.started',
  'turn.steered',
  'turn.interrupted',
  'step.started',
  'action.started',
  'action.finished',
  'reasoning.thinking',
  'reasoning.completed',
  'memory.recalled',
  'document.found',
  'document.content',
  'files.attached',
  'workspace.changed',
  'reply.sent',
  'system.info',
  'system.warning',
  'system.error',
  'context.compacted',
]);

/** Id of a turn: `t<turn>`. */
export function turnId(turn: number): string {
  return `t${turn}`;
}

/** Id of a step: `t<turn>.<step>`. */
export function stepId(turn: number, step: number): string {
  return `t${turn}.${step}`;
}

/**
 * Every distinct session file a timeline records through `files.attached`
 * events, keyed by path + hash, with the latest record kept and first-seen
 * timeline order.
 */
export function collectSessionFiles(events: readonly LedgerEvent[]): SessionFile[] {
  const files = new Map<string, SessionFile>();
  for (const event of events) {
    if (event.type !== 'files.attached') continue;
    for (const file of event.files) files.set(`${file.path}\u0000${file.hash}`, { ...file });
  }
  return [...files.values()];
}

/**
 * Every image occurrence in the context, in event order. An image stays in the
 * context for the life of the session, exactly like a loaded document.
 * Occurrences are identified by the actual `SessionFile` objects (no path/hash
 * dedup), and an occurrence is counted even when its preview is missing.
 */
export function contextImageFiles(events: readonly LedgerEvent[]): ReadonlySet<SessionFile> {
  const selected = new Set<SessionFile>();
  for (const event of events) {
    if (event.type !== 'files.attached') continue;
    for (const file of event.files) {
      if (file.kind === 'image') selected.add(file);
    }
  }
  return selected;
}
