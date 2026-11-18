/**
 * Harness ports: the host surface a session runs on, the public `Session` /
 * `HarnessSession` interface, action/call ports, and the `@wrenyard/session`
 * ledger adapter port.
 */

import type { GatewayConnection as WrenyardGatewayConnection } from '@wrenyard/ai-protocol';
import type { TaskRunFacts } from '@wrenyard/protocol/task';
import type { ReasoningEffort } from '@wrenyard/models';
import type { LiveCall, SpanStatus } from '@wrenyard/protocol/session';
import type {
  Message as ModelMessage,
  ModelMetrics,
  ModelWaitReason,
  ToolCall,
  ToolChoice,
  ToolSpec,
  Usage,
} from '@wrenyard/ai/transport';
import type {
  ActionStatus,
  ActionType,
  LedgerEvent,
  LedgerEventDraft,
  LedgerPage,
  SessionSummary,
  TaskBrief,
  TaskSpanFinishedEvent,
  TaskSpanStartedEvent,
  WorkspaceSnapshot,
} from './events.ts';
import type {
  AuxiliaryCallRole,
  AuxiliaryRoute,
  AuxiliaryRoutePreview,
  CallRole,
  ReasoningRetryPolicy,
} from './types.ts';
import type { ContextInspectRequest, ContextInspection } from './context/inspect.ts';
import type { AttachmentInput, FileStore, TaskArtifact } from './tools/media-store.ts';
import type { DocCatalogEntry } from './tools/workspace-files.ts';
import type { WorkspaceMemoryPort } from './tools/memory-write.ts';
import type { SessionRuntime, TurnRuntime } from './drivers/runtime.ts';

export type { WorkspaceMemoryPort, LiveCall };

// ─── Public host and session surface ────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
}

/**
 * One callable protocol method: its name, a human-readable description (which
 * may be an empty string) and its `params` JSON Schema.
 */
export interface MethodInfo {
  name: string;
  description: string;
  params: Record<string, unknown>;
}

export interface SessionHost {
  workspaceRoot: string;
  stateRoot: string;
  deviceName: string;
  gateway(): Promise<WrenyardGatewayConnection>;
  resolveAuxiliaryModel(
    role: AuxiliaryCallRole,
    input?: { toolChoice?: ToolChoice },
  ): Promise<AuxiliaryRoute>;
  /**
   * Live global retry switches for main reasoning, read at call time: an absent
   * policy or an absent getter means retries are on.
   */
  retryPolicy?: ReasoningRetryPolicy;
  /** Read-only, per-role rank-1 auxiliary route preview; never calls a model. */
  previewAuxiliaryRoutes(): Promise<readonly AuxiliaryRoutePreview[]>;
  listProjects(): Promise<ProjectInfo[]>;
  gitHead(checkoutPath: string): Promise<{ branch?: string; head?: string }>;
  /** Describe the named protocol methods; unknown names are omitted. */
  methods(names: readonly string[]): Promise<MethodInfo[]>;
  /**
   * Invoke one protocol method with raw params. A rejection is an `Error`
   * carrying a string `code` and a message; a success returns the result value.
   */
  call(
    method: string,
    params: unknown,
    context?: { sessionId?: string; turn?: number; step?: number; actionId?: string },
  ): Promise<unknown>;
  listTaskDefinitions(): Promise<{ id: string; description: string; project?: string; inputSummary: string[] }[]>;
  describeTask(id: string, project?: string): Promise<{
    description: string;
    inputSchema: unknown;
    /** Definition source, e.g. `builtin` or `project`. */
    source: string;
    /** Input capabilities the task requires, e.g. `['image']`. */
    requiredCapabilities?: readonly string[];
    /** Execution tools the task requires, e.g. `['browser']` or a named MCP tool. */
    requiredTools?: readonly string[];
  }>;
  /** Execution tools the task run will mount for the given input, derived from the task's feature selection. */
  mountedTaskTools?(id: string, project: string | undefined, input: unknown): Promise<readonly string[]>;
  /** Ids of the execution tools the current environment actually provides. */
  environmentTools?(): Promise<readonly string[]>;
  findTaskWriteConflict(params: {
    project: string;
    worktree?: string;
    task: string;
    input: unknown;
  }): Promise<{
    runId: string;
    taskId: string;
    targets: readonly string[];
    overlap: readonly string[];
    /** ISO timestamp the holder run's first execution actually launched. */
    startedAt?: string;
    /** ISO timestamp of the holder run's latest recorded event, when any exist. */
    lastActivityAt?: string;
    /** ISO timestamp the holder run's effective run time limit ends at, when known. */
    timeLimitEndsAt?: string;
  } | null>;
  createTaskRun(params: {
    task: string;
    project?: string;
    /** A managed worktree of the project to run the task in; absent runs in the project checkout. */
    worktree?: string;
    input: unknown;
    ctx?: Record<string, unknown>;
    /** Explicit Fast preference for the main reasoning path; absent means no preference. */
    fast?: boolean;
  }): Promise<{ taskRunId: string }>;
  waitTaskRun(taskRunId: string, signal: AbortSignal): Promise<{
    status: string;
    output: string;
    /** Facts the daemon collected for the run; absent when the run recorded none. */
    facts?: TaskRunFacts;
    /** The task run's usage and reference cost as the task system reports them. */
    usage?: Record<string, unknown>;
    /** Sanitized structured artifacts, separate from the free-form output text. */
    artifacts?: TaskArtifact[];
    /** Textual descriptors of stripped artifact entries. */
    artifactErrors?: string[];
  }>;
  cancelTaskRun(taskRunId: string): Promise<void>;
  /**
   * Optional agent tool port for one session. When a host returns one, the
   * session's reason request uses the port's own system prompt and native tool
   * set, and every completed tool call is dispatched to {@link AgentToolPort.run}
   * instead of the built-in `wy_action` action layer.
   */
  agentTools?(sessionId: string): AgentToolPort | undefined;
  /**
   * The memory store of one session, for a host that keeps memory apart per
   * session (a bot's own memory).
   */
  memoryFor?(sessionId: string): WorkspaceMemoryPort | undefined;
  /** Optional recorder of one finished auxiliary run into the unified run record. */
  recordAuxiliaryRun?(input: import('@wrenyard/protocol').AuxiliaryRunRecordInput): void;
  now?(): Date;
}

export type HarnessHost = SessionHost;

export interface AgentToolPort {
  /** Replaces the whole reason system prompt (REASON_SYSTEM, `<wy-global>` AGENTS.md and REASON_ROLE). */
  system: string;
  /** Native tools offered to the model; empty means text replies only. */
  tools: readonly ToolSpec[];
  /** Kernel facts appended verbatim to the context after a compaction. */
  kernelFacts?(): string | undefined;
  /** Execute one tool call the model returned. */
  run(
    call: { name: string; arguments: string },
    ctx: { sessionId: string; turn: number },
  ): Promise<{ status: 'done' | 'failed'; result: string }>;
  /** Tools backed by a built-in auxiliary action instead of `run`. */
  auxiliaryTools?: Readonly<Record<string, ActionType>>;
}

export interface Session {
  createSession(): Promise<{ sessionId: string }>;
  listSessions(): SessionSummary[];
  send(
    sessionId: string,
    input: {
      text: string;
      model: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        fast?: boolean;
        autoSelected?: boolean;
      };
      attachments?: AttachmentInput[];
      sender?: { botId: string };
    },
  ): Promise<{ turn: number }>;
  steer(
    sessionId: string,
    input: { text: string; sender?: { botId: string } },
  ): Promise<{ turn: number } | undefined>;
  interrupt(sessionId: string, turn: number): Promise<void>;
  readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  regenerateTitle(sessionId: string): Promise<string>;
  updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void>;
  activeTurnCount(): number;
  hasRunningTurns(): boolean;
  readLedger(sessionId: string): LedgerEvent[];
  readLedgerPage(sessionId: string, afterSeq: number, limit: number): LedgerPage;
  inspectContext(request: ContextInspectRequest): Promise<ContextInspection>;
  previewRoutes(): Promise<{ roles: AuxiliaryRoutePreview[] }>;
  readLive(sessionId: string): LiveCall[];
  suggestPrompt(sessionId: string, requestId: string): Promise<{ suggestion?: string }>;
  cancelPromptSuggest(sessionId: string, requestId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void;
  close(): Promise<void>;
}

export type HarnessSession = Session;

// ─── Internal adapter & module ports ────────────────────────────────────────

export interface LedgerPort {
  init(): Promise<void>;
  append(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent>;
  read(sessionId: string): LedgerEvent[];
  readPage?(sessionId: string, afterSeq: number, limit: number): LedgerPage;
  listSessions(): SessionSummary[];
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export type HarnessLedgerPort = LedgerPort;

export interface RecalledFile {
  path: string;
  title: string;
  content: string;
}

export interface FilesPort {
  checkPath(path: string): { ok: true; kind: 'memory' | 'doc' } | { ok: false; reason: string };
  exists(path: string): boolean;
  read(path: string): RecalledFile | undefined;
  instructionChain(workspaceDir: string, docPath: string): string[];
  listDocuments(): DocCatalogEntry[];
  readDocumentRules(): string;
}

export interface SnapshotProjectInput {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  branch?: string;
  head?: string;
  tasks: TaskBrief[];
}

export interface SnapshotInput {
  workspaceRoot: string;
  deviceName: string;
  takenAt: Date;
  projects: SnapshotProjectInput[];
  builtinTasks: TaskBrief[];
}

export type TurnPhase = 'preparing' | 'reasoning' | 'acting' | 'replying' | 'terminal';

export interface SessionViewInfo {
  now?: string;
  sessionId: string;
  turn: number;
  step: number;
  model: string;
  deviceName: string;
  contextWindow?: number;
}

export interface CallRunRequest {
  spanId: string;
  parent: string;
  role: CallRole;
  turn?: number;
  step?: number;
  messages: readonly ModelMessage[];
  layers: Record<string, number>;
  reason?: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    fast?: boolean;
  };
  maxTokens?: number;
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onWait?: (state: { reason: ModelWaitReason; retryAt?: string } | null) => void;
}

export interface CallRunResult {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
  toolCalls: readonly ToolCall[];
  metrics: ModelMetrics;
  route?: { provider?: string; model?: string; effort?: string };
}

export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
  holdSpan(spanId: string): void;
  releaseSpan(spanId: string, status?: SpanStatus): Promise<void>;
  recordAuxiliaryRun?(input: import('@wrenyard/protocol').AuxiliaryRunRecordInput): void;
}

export type ViewMessage = ModelMessage;

export interface BuiltView {
  messages: ViewMessage[];
  layers: Record<string, number>;
  segments?: Record<string, string>;
}

export interface CallFailureSummary {
  model: string;
  kind: string;
  status?: number;
  message: string;
  metrics?: ModelMetrics;
}

export interface InvokedCall {
  ok: boolean;
  spanId: string;
  text: string;
  reasoning?: string;
  toolCalls?: readonly ToolCall[];
  metrics?: ModelMetrics;
  error?: string;
  failure?: CallFailureSummary;
  route?: CallRunResult['route'];
}

/** One parsed action the reasoning model requested. */
export interface ParsedAction {
  type: ActionType;
  intent: string;
  name?: string;
}

/** Result of executing one action. */
export interface ActionExecutionOutcome {
  taskRunId?: string;
  status: ActionStatus;
  result: string;
  taskStatus?: string;
  task?: string;
  deferred: LedgerEventDraft[];
}

export type ActionProjectInfo = Pick<ProjectInfo, 'id' | 'displayName' | 'workspaceDir' | 'checkoutPath'>;

export type ActionTaskInfo = Pick<TaskBrief, 'id' | 'description' | 'inputSummary'> & { project?: string };

export type TaskSpanDraft =
  | Omit<TaskSpanStartedEvent, 'seq' | 'at'>
  | Omit<TaskSpanFinishedEvent, 'seq' | 'at'>;

export interface ActionRunnerDeps {
  host: Pick<
    SessionHost,
    | 'describeTask'
    | 'mountedTaskTools'
    | 'findTaskWriteConflict'
    | 'createTaskRun'
    | 'waitTaskRun'
    | 'cancelTaskRun'
    | 'methods'
    | 'call'
    | 'environmentTools'
    | 'resolveAuxiliaryModel'
    | 'gateway'
  >;
  files: Pick<FilesPort, 'checkPath' | 'exists' | 'read' | 'instructionChain' | 'listDocuments' | 'readDocumentRules'>;
  calls: CallsPort;
  fileStore: FileStore;
  appendSpan(draft: TaskSpanDraft): void | Promise<void>;
  now(): Date;
}

export interface ActionWorkflowDeps extends ActionRunnerDeps {
  nextSpanId(): string;
}

export interface ActionRunContext {
  sessionId: string;
  turn: number;
  step: number;
  actionId: string;
  userText: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  currentEvents(): LedgerEvent[];
  projects: ActionProjectInfo[];
  tasks: ActionTaskInfo[];
  signal: AbortSignal;
  onTaskRun(taskRunId: string): Promise<void>;
  onTitle?(title: string): void;
  onDispatched?(): void;
}

export type ActionBaseContext = Omit<ActionRunContext, 'actionId' | 'onTaskRun'>;

export interface SessionCallHost {
  readonly host: SessionHost;
  readonly ports: EnginePorts;
  readonly ledger: LedgerPort;
  now(): Date;
  track(promise: Promise<unknown>): void;
  trackTurnWork(sessionId: string, turn: number, promise: Promise<unknown>): void;
  nextActionId(session: SessionRuntime): string;
  appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: TurnRuntime,
    step?: number,
  ): Promise<void>;
  invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra?: {
      spanId?: string;
      parent?: string;
      reason?: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        fast?: boolean;
      };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      onWait?: (state: { reason: ModelWaitReason; retryAt?: string } | null) => void;
      tools?: readonly ToolSpec[];
      toolChoice?: ToolChoice;
      maxTokens?: number;
      step?: number;
      signal?: AbortSignal;
    },
  ): Promise<InvokedCall>;
  safeCancelTask(taskRunId: string): Promise<void>;
  setRecoveryWait(sessionId: string, waiting: RecoveryWait): void;
  clearRecoveryWait(sessionId: string, turn: number): void;
}

export interface RecoveryWait {
  turn: number;
  model: string;
  effort: ReasoningEffort;
  attachmentsKey: string;
}

export interface EnginePorts {
  ledger: LedgerPort;
  memory?: WorkspaceMemoryPort;
  memoryFor?(sessionId: string): WorkspaceMemoryPort | undefined;
  files(snapshot: WorkspaceSnapshot, workspaceRoot: string): FilesPort;
  calls(sessionId: string): CallsPort;
  fileStore: FileStore;
}
