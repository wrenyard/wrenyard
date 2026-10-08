import type {
  AttachmentInput,
  LedgerEvent,
  ProjectSnapshot,
  SessionFile,
  SessionSummary,
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
export type ActionKindModel = 'dispatch' | 'read' | 'write' | 'parse-failed';

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
  user: { text: string; at: string; attachments?: SessionFile[] };
  model: { provider: string; model: string; reasoningEffort?: string };
  status: TurnStatus;
  phase?: Phase;
  cycle: number;
  startedAt: string;
  /** When the user message was received; mirrors `startedAt`. */
  receivedAt: string;
  endedAt?: string;
  interruptReason?: 'user' | 'shutdown' | 'restart';
  /** An interrupt was requested but `turn.finished` has not arrived yet. */
  interrupting: boolean;
  cycles: CycleModel[];
  /** Every committed communication reply, in chronological order. */
  replies: ReplyModel[];
  /** The latest committed reply, when the turn has one. */
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
  | 'doc-search'
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
  status: ItemStatus;
  startedAt: string;
  endedAt?: string;
  parsed?: unknown;
  result?: string;
  taskRunId?: string;
  task?: SessionBridgeTaskBrief;
  /** Session files produced by this action, projected from `files` events. */
  files?: SessionFile[];
  outputs: ContextItem[];
  writes: { path: string; change: 'created' | 'updated' }[];
  afterInterrupt: boolean;
  cycle: number;
}

/** One row in the session tree: a model call, memory, document, file or error. */
export interface TreeEntry {
  at: string;
  kind: 'call' | 'memory' | 'doc' | 'file' | 'error';
  /** Short: role name, or file name without directory and extension. */
  label: string;
  /** Full path. */
  path?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
  durationMs?: number;
  callId?: string;
  unchanged?: boolean;
  body?: string;
}

export interface ActionNode {
  id: string;
  kind: 'read' | 'dispatch' | 'write';
  title?: string;
  intent: string;
  task?: string;
  taskDisplayName?: string;
  project?: string;
  taskRunId?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';
  startedAt: string;
  endedAt?: string;
  result?: string;
  compile?: TreeEntry;
  /** Doc-search call, loaded docs, memory. */
  entries: TreeEntry[];
  /** Artifacts produced by this action. */
  files: SessionFile[];
  errors: string[];
}

export interface ReasonNode {
  callId: string;
  model: string;
  thinking?: string;
  text: string;
  startedAt: string;
  endedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface CycleNode {
  cycle: number;
  startedAt?: string;
  endedAt?: string;
  running: boolean;
  prepare: TreeEntry[];
  reason?: ReasonNode;
  actions: ActionNode[];
  replies: Array<{ at: string; text: string }>;
  errors: string[];
}

export interface TurnNode {
  turn: number;
  userText: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  cycles: CycleNode[];
}

export type CallRoleModel = 'reason' | 'memory-search' | 'doc-search' | 'compile' | 'reply' | 'title';

export interface CallModel {
  id: string;
  role: CallRoleModel;
  model: string;
  status: 'running' | 'ok' | 'failed' | 'aborted';
  turn: number;
  cycle?: number;
  startedAt: string;
  firstTokenAt?: string;
  endedAt?: string;
  usage?: { input?: number; cachedInput?: number; output?: number; reasoning?: number };
  estimatedInputTokens?: number;
  layers?: Record<string, number>;
  output: string;
  reasoning?: string;
  error?: string;
}

export interface ReplyModel {
  text: string;
  at: string;
  cycle?: number;
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

/** What the inspector can show. Breadcrumbs are derived from it. */
export type InspectorTarget =
  | { kind: 'turn'; turnId: number }
  | { kind: 'cycle'; turnId: number; cycle: number }
  | { kind: 'reasoning'; turnId: number; cycle: number }
  | { kind: 'context'; turnId: number; cycle?: number; key: string }
  | { kind: 'action'; turnId: number; actionId: string }
  | { kind: 'call'; callId: string };

declare global {
  interface Window {
    wrenyardSession: SessionApi;
  }
}
