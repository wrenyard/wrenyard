/**
 * session ledger event model.
 *
 * The event type declarations moved to `@wrenyard/protocol/session` (they are
 * the wire format of `session.events` and friends); this module re-exports them
 * under their original names so every `./ledger/events.ts` consumer keeps
 * importing unchanged. The runtime members stay local: {@link CONTEXT_EVENT_TYPES}
 * is the single declaration of which event types may enter the rendered model
 * context, and `turnId` / `stepId` name the id conventions.
 */
import type { LedgerEventType } from '@wrenyard/protocol/session';

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
} from '@wrenyard/protocol/session';
export { REPLY_FALLBACK_SOURCES } from '@wrenyard/protocol/session';

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
