/**
 * session ports: the host surface a session runs on, the public `Session`
 * interface, and the module ports the engine is composed from.
 */

import type { WrenyardGatewayConnection } from '@wrenyard/control';
import type { ReasoningEffort } from '@wrenyard/models';
import type { ProviderDefinition } from '@wrenyard/providers';
import type {
  LedgerEvent,
  LedgerEventDraft,
  SessionSummary,
  TaskBrief,
  WorkspaceSnapshot,
} from './ledger.ts';
import type { CallRole } from './calls.ts';
import type { ContextInspectRequest, ContextInspection } from './context-inspect.ts';
import type { ModelContentPart, ModelMessage, ToolCall, ToolSpec, Usage } from './driver.ts';
import type { AttachmentInput, FileStore, TaskArtifact } from './media.ts';
import type { DocCatalogEntry } from './workspace.ts';
import type { ActionRunContext } from './actions/index.ts';

// ─── Public host and session surface ───────────────────────────────────────

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
  /** The product-wired provider definitions main inference validates its
   *  target against. */
  resolveInferenceProvider(providerId: string): ProviderDefinition | undefined;
  /** In-memory Gateway state of a `provider/model` route; never queries a provider. */
  routeStatus?(model: string): import('@wrenyard/providers/base').GatewayRouteStatus | undefined;
  selectAuxiliary(role: import('./role-requirements.ts').AuxiliaryCallRole): Promise<readonly import('./calls.ts').AuxiliaryRoute[]>;
  /** Read-only, per-role rank-1 auxiliary route preview; never calls a model. */
  previewAuxiliaryRoutes(): Promise<readonly import('./role-requirements.ts').AuxiliaryRoutePreview[]>;
  listProjects(): Promise<ProjectInfo[]>;
  gitHead(checkoutPath: string): Promise<{ branch?: string; head?: string }>;
  /** Describe the named protocol methods; unknown names are omitted. */
  methods(names: readonly string[]): Promise<MethodInfo[]>;
  /**
   * Invoke one protocol method with raw params. A rejection is an `Error`
   * carrying a string `code` and a message; a success returns the result value.
   */
  call(method: string, params: unknown): Promise<unknown>;
  listTaskDefinitions(): Promise<{ id: string; description: string; project?: string; inputSummary: string[] }[]>;
  describeTask(id: string, project?: string): Promise<{
    description: string;
    inputSchema: unknown;
    /** Definition source, e.g. `builtin` or `project`. */
    source: string;
    /** Input capabilities the task requires, e.g. `['image']`. */
    requiredCapabilities?: readonly string[];
  }>;
  createTaskRun(params: {
    task: string;
    project?: string;
    input: unknown;
    ctx?: Record<string, unknown>;
  }): Promise<{ taskRunId: string }>;
  waitTaskRun(taskRunId: string, signal: AbortSignal): Promise<{
    status: string;
    output: string;
    /** Sanitized structured artifacts, separate from the free-form output text. */
    artifacts?: TaskArtifact[];
    /** Textual descriptors of stripped artifact entries. */
    artifactErrors?: string[];
  }>;
  cancelTaskRun(taskRunId: string): Promise<void>;
  now?(): Date;
}

/**
 * An in-memory streaming snapshot of one call. It is never written to the
 * ledger: the durable `call.started` / `call` events remain authoritative, and
 * the live table only bridges the gap while a call is still running. The
 * complete accumulated text (not a delta) is exposed on each notification.
 */
export interface LiveCall {
  callId: string;
  text: string;
  reasoning: string;
}

export interface Session {
  createSession(): Promise<{ sessionId: string }>;
  listSessions(): SessionSummary[];
  send(
    sessionId: string,
    input: {
      text: string;
      /** Explicit public reasoning level; required for every turn. */
      model: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      /** Optional user attachments imported before the turn starts. */
      attachments?: AttachmentInput[];
    },
  ): Promise<{ turn: number }>;
  interrupt(sessionId: string, turn: number): Promise<void>;
  /**
   * Resolve one ledger-known session file (by its exact canonical path) to its
   * stored path and MIME type, plus a data URL when it is an image.
   */
  readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }>;
  /**
   * Delete one session and its files/artifact directories. Rejects while the
   * session has a running or recovering turn.
   */
  deleteSession(sessionId: string): Promise<void>;
  /** Admitted turns whose terminal `turn.finished` is not yet durable. */
  activeTurnCount(): number;
  /** True while any admitted turn has not reached its durable terminal append. */
  hasRunningTurns(): boolean;
  readLedger(sessionId: string): LedgerEvent[];
  /**
   * Read-only, forward-looking inspection of the next main reasoning view.
   * Omitted `sessionId` inspects a new session (resident layers plus snapshot).
   */
  inspectContext(request: ContextInspectRequest): Promise<ContextInspection>;
  /**
   * Read-only preview of each auxiliary role's rank-1 route (model, reasoning
   * effort, display name and window). Never calls a model and never writes.
   */
  previewRoutes(): Promise<{ roles: import('./role-requirements.ts').AuxiliaryRoutePreview[] }>;
  /** Current in-memory streaming snapshots for the session's live calls. */
  readLive(sessionId: string): LiveCall[];
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  /** Subscribe to live-snapshot changes; the returned function unsubscribes. */
  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void;
  close(): Promise<void>;
}

// ─── Ports (concrete wiring lives in index.ts) ─────────────────────────────

export interface LedgerPort {
  init(): Promise<void>;
  append(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent>;
  read(sessionId: string): LedgerEvent[];
  listSessions(): SessionSummary[];
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface RecalledFile {
  path: string;
  title: string;
  content: string;
}

export interface FilesPort {
  /** Validate a workspace-relative path against the read/write scope. */
  checkPath(path: string): { ok: true; kind: 'memory' | 'doc' } | { ok: false; reason: string };
  exists(path: string): boolean;
  /** Read a validated path; undefined when it is missing or unreadable. */
  read(path: string): RecalledFile | undefined;
  /** Existing project instruction files, outermost first. */
  instructionChain(workspaceDir: string, docPath: string): string[];
  /** Catalogue every registered project document, most-specific owner. */
  listDocuments(): DocCatalogEntry[];
  /** Workspace-level document writing rules, or the empty string. */
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
  cycle: number;
  model: string;
  deviceName: string;
  contextWindow?: number;
}

export interface CallRunRequest {
  callId: string;
  role: CallRole;
  turn?: number;
  cycle?: number;
  messages: readonly ModelMessage[];
  layers: Record<string, number>;
  /** Required for the `reason` role; ignored for every other role. */
  reason?: { provider: string; model: string; reasoningEffort: ReasoningEffort };
  /** Output-token cap forwarded to the wire `max_tokens` when the driver supports it. */
  maxTokens?: number;
  /** Tools declared on this call; forwarded to the driver for every role. */
  tools?: readonly ToolSpec[];
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Completed native wy_action tool calls, delivered as each one is parsed. */
  onToolCall?: (call: ToolCall) => void;
}

export interface CallRunResult {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order; empty when it returned none. */
  toolCalls: readonly ToolCall[];
}

/** Structural match for `calls.ts`'s `CallRunner`. */
export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
}

/** One assembled prompt view: protocol-neutral messages plus layer statistics. */
export type ViewMessage = ModelMessage;

export interface BuiltView {
  messages: ViewMessage[];
  /** Character count per prompt layer, for the `call` event. */
  layers: Record<string, number>;
  /** Raw text of each assembled layer, for the read-only context inspector. */
  segments?: Record<string, string>;
}

/** The result of one engine model call. */
export interface InvokedCall {
  ok: boolean;
  callId: string;
  text: string;
  reasoning?: string;
  toolCalls?: readonly ToolCall[];
  error?: string;
}

/**
 * The engine surface the turn loop and the auxiliary adapters call back into.
 * `ledger` is the durable timeline; `host` / `ports` are the composed session
 * seams.
 */
export interface SessionCallHost {
  readonly host: SessionHost;
  readonly ports: EnginePorts;
  readonly ledger: LedgerPort;
  now(): Date;
  track(promise: Promise<unknown>): void;
  appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: import('./runtime.ts').TurnRuntime,
    cycle?: number,
  ): Promise<void>;
  invoke(
    session: import('./runtime.ts').SessionRuntime,
    turn: import('./runtime.ts').TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra?: {
      callId?: string;
      reason?: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      tools?: readonly ToolSpec[];
      maxTokens?: number;
      cycle?: number;
    },
  ): Promise<InvokedCall>;
  safeCancelTask(taskRunId: string): Promise<void>;
}

/**
 * Everything an action needs except its own id and task-run hook; the engine
 * supplies both per action. `currentEvents` is read at each request, so an
 * action always sees the timeline as of now.
 */
export type ActionBaseContext = Omit<ActionRunContext, 'actionId' | 'onTaskRun'>;

export interface EnginePorts {
  ledger: LedgerPort;
  files(snapshot: WorkspaceSnapshot, workspaceRoot: string): FilesPort;
  /** Session-scoped so a `call` event lands on the right timeline. */
  calls(sessionId: string): CallsPort;
  /** Session file store: attachment import, artifact description, image reads. */
  fileStore: FileStore;
}
