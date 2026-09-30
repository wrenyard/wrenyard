import type { LedgerEvent, ProjectSnapshot, SessionSummary, WorkspaceSnapshot } from '@wrenyard/session-v2';
import type {
  LiveCall,
  SessionV2Bridge,
  SessionV2BridgeEventPayload,
  SessionV2BridgeModelEntry,
  SessionV2BridgeTaskBrief,
} from '../../../session-v2/preload.js';

export type { LiveCall, SessionV2BridgeTaskBrief };
export type SessionApi = SessionV2Bridge;
export type ModelEntry = SessionV2BridgeModelEntry;
export type EventPayload = SessionV2BridgeEventPayload;
export type { LedgerEvent, SessionSummary, WorkspaceSnapshot, ProjectSnapshot };

export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'exhausted';
export type Phase = 'preparing' | 'reasoning' | 'acting' | 'replying';
export type ItemStatus = 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'aborted';
export type ActionKindModel = 'dispatch' | 'read' | 'write-doc' | 'unsupported' | 'parse-failed';

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
  user: { text: string; at: string };
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
  progress: ReplyModel[];
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
  blocks: BlockModel[];
  actionIds: string[];
  progress: ReplyModel[];
  errors: ErrorItem[];
}

export interface ReasoningModel {
  callId: string;
  text: string;
  thinking?: string;
  streaming: boolean;
}

export interface BlockModel {
  blockId: string;
  text: string;
  unterminated: boolean;
  actionIds: string[];
}

export interface ContextItem {
  key: string;
  kind: 'memory' | 'doc' | 'instructions';
  path: string;
  title?: string;
  reason?: string;
  source: 'selection' | 'action' | 'project-instructions';
  actionId?: string;
  content: string;
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
  task?: SessionV2BridgeTaskBrief;
  outputs: ContextItem[];
  writes: { path: string; change: 'created' | 'updated' }[];
  afterInterrupt: boolean;
  cycle: number;
}

export interface CallModel {
  id: string;
  role: 'reason' | 'select' | 'interpret' | 'compile' | 'write' | 'reply' | 'title';
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
  phase: 'progress' | 'final';
  text: string;
  at: string;
  streaming: boolean;
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
  | { kind: 'block'; turnId: number; blockId: string }
  | { kind: 'call'; callId: string };

declare global {
  interface Window {
    sessionV2: SessionApi;
  }
}
