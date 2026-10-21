import type {
  AttachmentInput,
  LedgerEvent,
  ProjectSnapshot,
  SessionFile,
  SessionSummary,
  WorkspaceChangedEvent,
  WorkspaceSnapshot,
} from '@wrenyard/session';
import type {
  DraftAttachment,
  LiveCall,
  SessionBridge,
  SessionBridgeEventPayload,
  SessionBridgeModelEntry,
  SessionBridgeTaskBrief,
} from '../../../../session/preload.js';

export type { LiveCall, SessionBridgeTaskBrief };
export type { AttachmentInput, SessionFile, DraftAttachment };
export type SessionApi = SessionBridge;
export type ModelEntry = SessionBridgeModelEntry;
export type EventPayload = SessionBridgeEventPayload;
export type { LedgerEvent, SessionSummary, WorkspaceSnapshot, ProjectSnapshot };

export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type Phase = 'preparing' | 'reasoning' | 'acting' | 'replying';
export type ItemStatus = 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'aborted';
export type ActionKindModel = 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'schedule' | 'parse-failed';

export interface SessionModel {
  snapshot?: { takenAt: string; deviceName: string; projects: ProjectBrief[] };
  turns: TurnModel[];
  runningTurns: number;
  /** Every call across the session, for cross-turn lookups. */
  calls: CallModel[];
}

export interface ProjectBrief {
  id: string;
  displayName?: string;
  workspaceDir: string;
  branch?: string;
  head?: string;
}

export interface TurnModel {
  id: number;
  /** User text comes from `turn.started`; attachments from following `files` events. */
  user: { text: string; at: string; attachments?: SessionFile[]; sender?: { botId: string } };
  model: { provider: string; model: string; reasoningEffort?: string };
  status: TurnStatus;
  phase?: Phase;
  cycle: number;
  startedAt: string;
  endedAt?: string;
  interruptReason?: 'user' | 'shutdown' | 'restart';
  /** An interrupt was requested but `turn.finished` has not arrived yet. */
  interrupting: boolean;
  cycles: CycleModel[];
  /** Every committed communication publication, in chronological order. */
  replies: ReplyModel[];
  /**
   * The turn's closing publication: the latest final-kind reply, or, for a
   * successfully completed turn with no final-kind reply, the last published
   * reply. Undefined for failed, interrupted or running turns without a
   * final-kind reply, so their fallback, error or interruption display is
   * unaffected.
   */
  final?: ReplyModel;
  calls: CallModel[];
  actions: ActionModel[];
  errors: ErrorItem[];
  stats: TurnStats;
  lastSeq: number;
}

export interface CycleModel {
  index: number;
  startedAt: string;
  endedAt?: string;
  context: ContextItem[];
  reasoning?: ReasoningModel;
  actionIds: string[];
  errors: ErrorItem[];
}

export interface ReasoningModel {
  callId: string;
  text: string;
  thinking?: string;
  streaming: boolean;
}

export type ContextItemKindModel =
  | 'memory'
  | 'doc'
  | 'search'
  | 'instructions'
  | 'thinking'
  | 'files'
  | 'error';

export type ContextItemSource = 'read' | 'write' | 'memory-search' | 'project-instructions';

export interface ContextItem {
  key: string;
  kind: ContextItemKindModel;
  path: string;
  title?: string;
  reason?: string;
  source: ContextItemSource;
  actionId?: string;
  content: string;
  /** Document content format, present for `doc.content` projections. */
  format?: 'full' | 'diff';
  version?: string;
  base?: string;
  updated?: string;
}

export interface ActionModel {
  id: string;
  kind: ActionKindModel;
  title: string;
  subtitle?: string;
  /** The agent's full natural-language prompt for this action. */
  prompt?: string;
  status: ItemStatus;
  startedAt: string;
  endedAt?: string;
  parsed?: unknown;
  /** Submitted task input from the dispatch task span, when recorded. */
  taskInput?: unknown;
  result?: string;
  taskRunId?: string;
  task?: SessionBridgeTaskBrief;
  /** Session files produced by this action, projected from `files` events. */
  files?: SessionFile[];
  outputs: ContextItem[];
  writes: {
    path: string;
    change: WorkspaceChangedEvent['change'];
    worktreeId?: string;
  }[];
  afterInterrupt: boolean;
  cycle: number;
}

export type CallRoleModel = 'reason' | 'memory-search' | 'search' | 'dispatch' | 'reply' | 'title' | 'document' | 'todo' | 'vcs' | 'project' | 'schedule' | 'status' | 'suggestion';

/**
 * One per-request context snapshot folded from a `span.context` event: the
 * actual prompt occupancy of exactly one request, ordered by its ledger `seq`.
 * It is deliberately separate from the cumulative `usage` a multi-round span
 * accumulates for consumption accounting.
 */
export interface CallContextSnapshot {
  /** Ledger seq of the snapshot event; the ordering key, independent of span start order. */
  seq: number;
  /** Public id (`provider/model`) of the model that served this request. */
  model: string;
  /** Input tokens of this one request, including cached input; absent when unknown. */
  inputTokens?: number;
}

export interface CallModel {
  id: string;
  role: CallRoleModel;
  model: string;
  status: 'running' | 'ok' | 'failed' | 'aborted';
  turn: number;
  cycle?: number;
  /** The span's parent id: the action id for an auxiliary span an action ran. */
  parent?: string;
  startedAt: string;
  firstTokenAt?: string;
  endedAt?: string;
  usage?: { input?: number; cachedInput?: number; output?: number; reasoning?: number };
  /**
   * Per-request context snapshots folded from `span.context` events, oldest
   * first, kept separate from the cumulative `usage`. Historical records
   * written before the event existed have none.
   */
  snapshots?: CallContextSnapshot[];
  /**
   * Recorded generation sample of a successful call (tokenizer speed sample). Historical
   * records written before the transport refactor have none and are never
   * back-filled from official usage and local timestamps.
   */
  tps?: { outputTokens: number; windowMs: number };
  estimatedInputTokens?: number;
  layers?: Record<string, number>;
  /** Public reasoning level actually sent for this span, when known. */
  reasoningEffort?: string;
  /** Reasoning level explicitly requested for this span, when known. */
  requestedReasoningEffort?: string;
  /** Ranked auxiliary routes kept for this span, copied from its request facts. */
  routeCandidates?: readonly { model: string; reasoningEffort: string }[];
  /** Rank of the route that served this span, when it came from a ranked list. */
  selectedRank?: number;
  /** Same-route retries the transport performed, oldest first. */
  retries?: readonly { status?: number; kind: string; delayMs: number }[];
  output: string;
  reasoning?: string;
  error?: string;
}

/** A published reply is either a process update or the turn's closing reply. */
export type ReplyKind = 'progress' | 'final';

export interface ReplyModel {
  text: string;
  at: string;
  cycle?: number;
  /**
   * Records how the reply was produced: `progress` for an intermediate process
   * update, `final` for the turn's closing reply. The model layer uses it, so
   * it is execution metadata, not diagnostic only. Optional, for records
   * written before the ledger recorded the kind.
   */
  kind?: ReplyKind;
  /**
   * Rendering tone of a reply derived on read for a turn that recorded no
   * final reply: `destructive` for a failed turn, `muted` for an interrupted
   * one. Absent for every recorded reply, which renders as ordinary prose.
   */
  tone?: 'destructive' | 'muted';
}

export interface ErrorItem {
  at: string;
  stage: string;
  message: string;
  cycle?: number;
}

export interface TurnStats {
  wallMs: number;
  expensive: {
    calls: number;
    input?: number;
    cachedInput?: number;
    output?: number;
    reasoning?: number;
    partial: boolean;
  };
  cheap: { calls: number; input?: number; output?: number; partial: boolean };
  dispatches: number;
  docsLoaded: number;
  docsWritten: number;
}

/**
 * One transcript step inside an activity group. Lives in the model layer so
 * describe.ts and the transcript components can share it without a cycle.
 */
export type ActivityItem =
  | { kind: 'reason'; call: CallModel; reasoning?: ReasoningModel }
  | { kind: 'call'; call: CallModel }
  | { kind: 'action'; action: ActionModel; calls: readonly CallModel[] }
  | { kind: 'context'; item: ContextItem };

declare global {
  interface Window {
    wrenyardSession: SessionApi;
  }
}
