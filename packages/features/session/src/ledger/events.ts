/**
 * session ledger event model.
 *
 * Every event carries exactly one timestamp (`at`, the moment it was appended).
 * Structure is expressed by ids: a start event names its `parent`, the matching
 * finish event repeats the same `id`, and content events only name a `parent`.
 *
 * Three families:
 * - structure: session, turn, step and action. What the system decided to do.
 * - execution: spans. What actually ran, with its request facts and metrics.
 *   Spans never enter the model context.
 * - content: material produced for the model and the user, and system
 *   notices: out-of-band facts the model should know.
 *
 * {@link CONTEXT_EVENT_TYPES} is the single declaration of which event types may
 * enter the rendered model context.
 */
import type { SessionFile } from '@wrenyard/protocol';
import type { ReasoningEffort } from '@wrenyard/models';
import type { AuxiliaryCallRole } from '../model/roles.ts';
import type { ModelMetrics } from '../transport/protocol.ts';
import type { ModelErrorKind } from '../transport/errors.ts';

// ─── Envelope ──────────────────────────────────────────────────────────────

/** The `type` discriminant of every ledger event. */
export type LedgerEventType =
  | 'session.created'
  | 'turn.started'
  | 'turn.finished'
  | 'turn.interrupted'
  | 'turn.attention'
  | 'step.started'
  | 'step.finished'
  | 'action.started'
  | 'action.titled'
  | 'action.finished'
  | 'span.started'
  | 'span.finished'
  | 'span.context'
  | 'reasoning.thinking'
  | 'reasoning.completed'
  | 'memory.recalled'
  | 'document.found'
  | 'document.content'
  | 'files.attached'
  | 'workspace.changed'
  | 'reply.sent'
  | 'session.titled'
  | 'session.metadata'
  | 'system.info'
  | 'system.warning'
  | 'system.error';

/**
 * Event types that may enter the rendered model context. Everything else is
 * observational; a span is never rendered.
 */
export const CONTEXT_EVENT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>([
  'turn.started',
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
]);

/** Fields common to every ledger event; `seq` and `at` are assigned on append. */
export interface LedgerEventBase {
  /** Global, strictly increasing sequence number within the session. */
  seq: number;
  /** ISO 8601 timestamp with timezone designator; the event's only time. */
  at: string;
  type: LedgerEventType;
  /** Turn number index; absent only on `session.created`. */
  turn?: number;
  /** Step number index within the turn; absent on turn-level events. */
  step?: number;
}

/** Id of a turn: `t<turn>`. */
export function turnId(turn: number): string {
  return `t${turn}`;
}

/** Id of a step: `t<turn>.<step>`. */
export function stepId(turn: number, step: number): string {
  return `t${turn}.${step}`;
}

// ─── Session and turn ──────────────────────────────────────────────────────

/** The terminal states of a work turn. */
export type TurnStatus = 'completed' | 'failed' | 'interrupted';

/** The main reasoning model a turn was started with. */
export interface TurnModel {
  provider: string;
  model: string;
  /** Explicit public reasoning level this turn runs at. */
  reasoningEffort?: ReasoningEffort;
}

export interface TaskBrief {
  id: string;
  description: string;
  inputSummary: string[];
}

export interface ProjectSnapshot {
  /** Registered project id. */
  id: string;
  displayName?: string;
  /** Workspace-relative project directory, e.g. `projects/saa/game`. */
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  /** Branch captured in the snapshot. */
  branch?: string;
  /** HEAD short hash captured in the snapshot. */
  head?: string;
  tasks: TaskBrief[];
  recentDocs: { path: string; title: string }[];
}

/** Frozen workspace facts taken when the session is created. */
export interface WorkspaceSnapshot {
  takenAt: string;
  deviceName: string;
  /** Full text of the workspace root `AGENTS.md`. */
  agents: string;
  /** Full text of `memories/INDEX.md`. */
  memoryIndex: string;
  builtinTasks: TaskBrief[];
  projects: ProjectSnapshot[];
}

export interface SessionCreatedEvent extends LedgerEventBase {
  type: 'session.created';
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
}

export interface TurnStartedEvent extends LedgerEventBase {
  type: 'turn.started';
  id: string;
  text: string;
  model: TurnModel;
}

export interface TurnFinishedEvent extends LedgerEventBase {
  type: 'turn.finished';
  id: string;
  status: TurnStatus;
  error?: string;
}

export interface TurnInterruptedEvent extends LedgerEventBase {
  type: 'turn.interrupted';
  parent: string;
  reason: 'user' | 'shutdown' | 'restart';
}

/**
 * That a finished turn needs the user's attention: it ended on a single
 * standalone question (`source: 'ask'`), or the post-turn status judgement
 * marked it as needing the user (`source: 'model'`). Observational, like
 * `turn.finished`; written after it. Never enters the model context.
 */
export interface TurnAttentionEvent extends LedgerEventBase {
  type: 'turn.attention';
  /** Id of the turn that needs attention: `t<turn>`. */
  turnId: string;
  needsUser: boolean;
  /** Short label for the user, e.g. 「等你确认提交」. */
  label?: string;
  source: 'ask' | 'model';
}

// ─── Step ──────────────────────────────────────────────────────────────────

export type StepStatus = 'done' | 'failed' | 'interrupted';

/**
 * Marks the start of one reasoning step. It is appended before the step's
 * request is assembled and rendered as that step's `<wy-info>` line, so the
 * per-request facts are part of the append-only context instead of a block
 * rewritten on every request.
 */
export interface StepStartedEvent extends LedgerEventBase {
  type: 'step.started';
  id: string;
  parent: string;
  /** Main model public id serving this step. */
  model: string;
  contextWindow?: number;
  /** Upstream-reported input tokens of the previous reasoning request, when known. */
  lastInputTokens?: number;
}

export interface StepFinishedEvent extends LedgerEventBase {
  type: 'step.finished';
  id: string;
  status: StepStatus;
}

// ─── Action ────────────────────────────────────────────────────────────────

/** The action types: the tools the reasoning model may write. */
export type ActionType = 'search' | 'dispatch' | 'document' | 'vcs' | 'project' | 'schedule';
export type ActionStatus = 'done' | 'failed' | 'skipped' | 'cancelled' | 'interrupted';

export interface ActionStartedEvent extends LedgerEventBase {
  type: 'action.started';
  id: string;
  /** The step whose reasoning wrote it. */
  parent: string;
  /** The action as written: its type plus the natural-language prompt. */
  action: { type: ActionType; prompt: string };
  /** The parsed action payload; opaque here because the action layer owns its shape. */
  input?: unknown;
  taskRunId?: string;
}

/** The display name of an action, known only after it started. */
export interface ActionTitledEvent extends LedgerEventBase {
  type: 'action.titled';
  /** The action's id. */
  id: string;
  title: string;
}

export interface ActionFinishedEvent extends LedgerEventBase {
  type: 'action.finished';
  id: string;
  action: { type: ActionType };
  status: ActionStatus;
  /** The parsed result the reasoning model reads. */
  result: string;
  task?: string;
  taskStatus?: string;
  taskRunId?: string;
  /** The result arrived after the turn was interrupted; kept out of the context. */
  afterInterrupt?: boolean;
}

// ─── Span ──────────────────────────────────────────────────────────────────

export type SpanKind = 'reasoning' | 'auxiliary' | 'task';
export type SpanStatus = 'ok' | 'failed' | 'aborted' | 'interrupted';

/** One ranked auxiliary route and the level it is called at. */
export interface SpanRoute {
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** Facts of a model request that hold before it is sent. */
export interface ModelSpanRequest {
  /** The auxiliary role; absent on a reasoning span. */
  role?: AuxiliaryCallRole;
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  effort?: {
    /** The explicitly requested level, or the auxiliary role's declared expectation. */
    requested?: string;
    /** Public reasoning level actually sent. */
    sent?: ReasoningEffort;
  };
  /** Input tokens estimated before sending. */
  inputEstimate: number;
  /** Character count per prompt layer, e.g. `{ 'wy-system': 1234 }`. */
  layers: Record<string, number>;
  /** Ordered auxiliary routes kept for this invocation and the rank that serves it. */
  route?: { candidates: readonly SpanRoute[]; rank?: number };
}

/** Facts of a dispatched agent task that hold when it is created. */
export interface TaskSpanRequest {
  task: string;
  project?: string;
  taskRunId: string;
}

/** Summary of a finished agent task, copied from the task system. */
export interface TaskSpanMetrics {
  taskStatus?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  referenceCostUsd?: number;
  generationMs?: number;
  outputTps?: number;
}

/** Structured failure fact of a span. */
export interface SpanError {
  kind: ModelErrorKind | 'task';
  status?: number;
  /**
   * The earliest instant the failed call may be retried, when the failure
   * carried one. A route that was never called reports its own retry instant
   * here rather than as an attempt record.
   */
  retryAt?: string;
  /** Supplier's original message. */
  message: string;
}

interface SpanStartedBase extends LedgerEventBase {
  type: 'span.started';
  id: string;
  /**
   * The owner: the step for a reasoning span and for the step's own auxiliary
   * tasks (memory search, reply), the turn for the title, the action for an
   * action's auxiliary task and its agent task.
   */
  parent: string;
}

export interface ModelSpanStartedEvent extends SpanStartedBase {
  kind: 'reasoning' | 'auxiliary';
  request: ModelSpanRequest;
}

export interface TaskSpanStartedEvent extends SpanStartedBase {
  kind: 'task';
  request: TaskSpanRequest;
}

export type SpanStartedEvent = ModelSpanStartedEvent | TaskSpanStartedEvent;

interface SpanFinishedBase extends LedgerEventBase {
  type: 'span.finished';
  id: string;
  status: SpanStatus;
  error?: SpanError;
}

export interface ModelSpanFinishedEvent extends SpanFinishedBase {
  kind: 'reasoning' | 'auxiliary';
  /** Raw visible output of the last completed request; absent when none completed. */
  output?: string;
  /** Raw reasoning text of the last completed request. */
  reasoning?: string;
  /**
   * Public id (`provider/model`) of the model the request actually selected for
   * the last completed round, including a fallback route. It is the session's
   * own serving identity, distinct from any provider-native response metadata
   * inside `metrics`.
   */
  requestModel?: string;
  /**
   * Measured by the transport. One span is one whole auxiliary task or one
   * reasoning request, so a multi-round task carries the sum of its requests,
   * including the part measured before a failure.
   */
  metrics?: ModelMetrics;
}

export interface TaskSpanFinishedEvent extends SpanFinishedBase {
  kind: 'task';
  metrics?: TaskSpanMetrics;
}

export type SpanFinishedEvent = ModelSpanFinishedEvent | TaskSpanFinishedEvent;

/**
 * Per-request context snapshot of one finished model request: the actual prompt
 * occupancy of that single request, as opposed to the cumulative metrics a
 * multi-request span accumulates. One is written for every reported request,
 * including each round of a held multi-round auxiliary task, so a consumer can
 * show the latest request's occupancy rather than the task's summed
 * consumption.
 *
 * `model` is the public id (`provider/model`) of the model that actually served
 * the request, including a fallback route chosen after a failover. `inputTokens`
 * is that request's upstream-reported input count and already includes cached
 * input; it is omitted — unknown — when the request reported no usage, never a
 * sentinel zero.
 */
export interface SpanContextEvent extends LedgerEventBase {
  type: 'span.context';
  /** The span this request belongs to. */
  id: string;
  kind: 'reasoning' | 'auxiliary';
  /** Public id (`provider/model`) of the model that actually served the request. */
  model: string;
  /** Input tokens of exactly this request, including cached input; absent when unknown. */
  inputTokens?: number;
}

// ─── Content ───────────────────────────────────────────────────────────────

/** The reasoning trace of a completed reasoning span. */
export interface ReasoningThinkingEvent extends LedgerEventBase {
  type: 'reasoning.thinking';
  /** The reasoning span. */
  parent: string;
  text: string;
}

export interface ReasoningCompletedEvent extends LedgerEventBase {
  type: 'reasoning.completed';
  /** The reasoning span. */
  parent: string;
  text: string;
  /**
   * The complete worker output of this step: the visible prose plus the ordered
   * raw action intents and questions parsed from its wy_action tool calls. The
   * communication view renders this; `text` stays the main reasoning prose.
   */
  workerOutput?: string;
}

export interface MemoryRecalledEvent extends LedgerEventBase {
  type: 'memory.recalled';
  /** The memory search span, or the search action that read it. */
  parent?: string;
  version: string;
  source: 'memory-search' | 'read';
  path: string;
  content: string;
}

/** One document pick in a document search result. */
export interface DocPick {
  path: string;
  title: string;
  reason: string;
}

export interface DocumentFoundEvent extends LedgerEventBase {
  type: 'document.found';
  /** The search action. */
  parent: string;
  understanding: string;
  picks: DocPick[];
  near: DocPick[];
  notes: string[];
}

export interface DocumentContentEvent extends LedgerEventBase {
  type: 'document.content';
  parent?: string;
  path: string;
  title: string;
  updated: string;
  version: string;
  tokens: number;
  content: string;
  format: 'full' | 'diff';
  base?: string;
  source: 'read' | 'write' | 'project-instructions';
}

export interface FilesAttachedEvent extends LedgerEventBase {
  type: 'files.attached';
  parent?: string;
  source: 'user' | 'task' | 'read';
  files: SessionFile[];
  taskRunId?: string;
}

export interface WorkspaceChangedEvent extends LedgerEventBase {
  type: 'workspace.changed';
  /** The action that made the change. */
  parent: string;
  scope: 'document' | 'workspace' | 'project';
  target: string;
  change: 'created' | 'updated' | 'committed' | 'pushed' | 'pulled' | 'worktree-created' | 'worktree-removed' | 'worktree-merged' | 'registered' | 'deleted';
  worktreeId?: string;
  version?: string;
  hash?: string;
  files?: string[];
}

/** The reply shown to the user for one step. */
export interface ReplySentEvent extends LedgerEventBase {
  type: 'reply.sent';
  /** The reply span; absent on records that predate spans. */
  parent?: string;
  text: string;
}

/** The session title; never part of the model context. */
export interface SessionTitledEvent extends LedgerEventBase {
  type: 'session.titled';
  /** The title span; absent on records that predate spans. */
  parent?: string;
  text: string;
  /**
   * True when the title was set by an explicit user rename rather than by
   * automatic generation. Absent on generated titles and on records written
   * before the marker existed, so old ledger lines still parse as generated.
   */
  manual?: boolean;
}

/**
 * Session list metadata set by explicit user actions: whether the session is
 * archived and whether it is pinned. Never part of the model context. Both
 * fields are optional so an event that only changes one flag leaves the other
 * untouched, and old ledger lines still parse unchanged.
 */
export interface SessionMetadataEvent extends LedgerEventBase {
  type: 'session.metadata';
  parent?: string;
  archived?: boolean;
  pinned?: boolean;
}

/**
 * An out-of-band notice the model should read: a system fault that no content
 * event already reports (`system.error`), a degraded but continuing condition
 * (`system.warning`), or a state change (`system.info`). A failed action that
 * produced its own result is reported by that result, not by a notice.
 */
export interface SystemNoticeEvent extends LedgerEventBase {
  type: 'system.info' | 'system.warning' | 'system.error';
  parent?: string;
  /** Who caused it: the system itself or a user operation. */
  source: 'system' | 'user';
  /** Stable identifier of the condition, e.g. `memory-search` or `model.changed`. */
  code: string;
  /** Text for the model. */
  message: string;
}

// ─── Union ─────────────────────────────────────────────────────────────────

export type LedgerEvent =
  | SessionCreatedEvent
  | TurnStartedEvent
  | TurnFinishedEvent
  | TurnInterruptedEvent
  | TurnAttentionEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ActionStartedEvent
  | ActionTitledEvent
  | ActionFinishedEvent
  | SpanStartedEvent
  | SpanFinishedEvent
  | SpanContextEvent
  | ReasoningThinkingEvent
  | ReasoningCompletedEvent
  | MemoryRecalledEvent
  | DocumentFoundEvent
  | DocumentContentEvent
  | FilesAttachedEvent
  | WorkspaceChangedEvent
  | ReplySentEvent
  | SessionTitledEvent
  | SessionMetadataEvent
  | SystemNoticeEvent;

/** An event body without the `seq` / `at` the ledger assigns on append. */
type WithoutSequence<T> = T extends LedgerEventBase ? Omit<T, 'seq' | 'at'> : never;

/** Discriminated distributively, so each member narrows on `type`. */
export type LedgerEventDraft = WithoutSequence<LedgerEvent>;
