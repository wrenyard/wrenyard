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
} from './ledger/store.ts';
import type { CallRole } from './model/request.ts';
import type { ContextInspectRequest, ContextInspection } from './context/inspect.ts';
import type { Message as ModelMessage, ModelContentPart, ModelWaitReason, ToolCall, ToolSpec, ToolChoice, Usage, ModelMetrics } from './transport/index.ts';
import type { AttachmentInput, FileStore, TaskArtifact } from './media.ts';
import type { DocCatalogEntry } from './workspace.ts';
import type { ActionRunContext } from './reasoning/actions.ts';
import type { WorkspaceMemoryPort } from './memory-write.ts';

export type { WorkspaceMemoryPort };

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
  /**
   * In-memory Gateway state of a `provider/model` route; never queries a
   * provider. The typed circuit detail (`phase`, `nextProbeAt`, `faultKind`) lets
   * a caller skip an open route instead of only a legacy block.
   */
  routeStatus?(model: string): import('@wrenyard/providers/base').GatewayRouteStatus | undefined;
  /**
   * Announce the start of one auxiliary attempt so a later client-observed
   * timeout or transport failure is attributed to the same attempt the Gateway
   * already knows about. Optional: a host without attempt-level feedback keeps
   * the prior behaviour.
   */
  beginRouteAttempt?(publicModel: string, attemptId: string): void;
  /**
   * Report a client-observed route fault (a timeout or a real transport failure)
   * for one attempt into the same route-health authority. A user cancellation is
   * never reported as a route fault.
   */
  reportRouteFault?(publicModel: string, attemptId: string, kind: 'timeout' | 'transport'): void;
  /** Release one attempt's bookkeeping once it has settled, success or failure. */
  completeRouteAttempt?(publicModel: string, attemptId: string): void;
  selectAuxiliary(role: import('./model/roles.ts').AuxiliaryCallRole): Promise<readonly import('./model/request.ts').AuxiliaryRoute[]>;
  /** Read-only, per-role rank-1 auxiliary route preview; never calls a model. */
  previewAuxiliaryRoutes(): Promise<readonly import('./model/roles.ts').AuxiliaryRoutePreview[]>;
  listProjects(): Promise<ProjectInfo[]>;
  gitHead(checkoutPath: string): Promise<{ branch?: string; head?: string }>;
  /** Describe the named protocol methods; unknown names are omitted. */
  methods(names: readonly string[]): Promise<MethodInfo[]>;
  /**
   * Invoke one protocol method with raw params. A rejection is an `Error`
   * carrying a string `code` and a message; a success returns the result value.
   */
  call(method: string, params: unknown, context?: { sessionId?: string }): Promise<unknown>;
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
  /**
   * Ids of the execution tools the current environment actually provides: the
   * ready operation components plus any declared external tools (such as a
   * named MCP server).
   */
  environmentTools?(): Promise<readonly string[]>;
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
   * instead of the built-in `wy_action` action layer. A host without it (or one
   * that returns `undefined` for a session) keeps the default behaviour
   * byte-for-byte unchanged.
   */
  agentTools?(sessionId: string): AgentToolPort | undefined;
  now?(): Date;
}

/**
 * The optional agent tool surface one session may run on. It replaces the
 * built-in orchestrator prompt and the single `wy_action` tool with a host-owned
 * system prompt and native tool set.
 */
export interface AgentToolPort {
  /** Replaces the whole reason system prompt (REASON_SYSTEM, the `<wy-global>` AGENTS.md and REASON_ROLE). */
  system: string;
  /** Native tools offered to the model; empty means text replies only. */
  tools: readonly ToolSpec[];
  /** Per-turn tool-call cap; default 24. */
  maxToolCalls?: number;
  /**
   * Execute one tool call the model returned. The result maps to the action's
   * `action.finished` status and result text.
   */
  run(
    call: { name: string; arguments: string },
    ctx: { sessionId: string; turn: number },
  ): Promise<{ status: 'done' | 'failed'; result: string }>;
}

/**
 * An in-memory streaming snapshot of one call. It is never written to the
 * ledger: the durable `span.started` / `span.finished` events remain
 * authoritative, and the live table only bridges the gap while a call is still
 * running. The complete accumulated text (not a delta) is exposed on each
 * notification.
 */
export interface LiveCall {
  spanId: string;
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
      model: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        /** Explicit Fast preference: true on, false off, absent no preference. */
        fast?: boolean;
      };
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
  /**
   * Rename one session with an explicit user title. Appends one manual
   * `session.titled` event so the list, index and subscribers all see it.
   * Rejects an unknown session and a title that is empty or only whitespace;
   * both are refused before anything is persisted.
   */
  renameSession(sessionId: string, title: string): Promise<void>;
  /**
   * Update one session's list metadata (archived / pinned). Appends one
   * `session.metadata` event carrying only the provided fields, so an absent
   * field keeps its prior value. Rejects an unknown session and a patch that
   * provides neither field.
   */
  updateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void>;
  /** Admitted turns whose terminal `turn.finished` is not yet durable. */
  activeTurnCount(): number;
  /** True while any admitted turn has not reached its durable terminal append. */
  hasRunningTurns(): boolean;
  readLedger(sessionId: string): LedgerEvent[];
  /**
   * Record a real condition change on the session's timeline so a later
   * dispatch can be told apart from a blind repeat. It is not part of a turn,
   * so the event carries no turn or step.
   */
  recordConditionChange(sessionId: string, message: string): Promise<void>;
  /**
   * Read-only, forward-looking inspection of the next main reasoning view.
   * Omitted `sessionId` inspects a new session (resident layers plus snapshot).
   */
  inspectContext(request: ContextInspectRequest): Promise<ContextInspection>;
  /**
   * Read-only preview of each auxiliary role's rank-1 route (model, reasoning
   * effort, display name and window). Never calls a model and never writes.
   */
  previewRoutes(): Promise<{ roles: import('./model/roles.ts').AuxiliaryRoutePreview[] }>;
  /** Current in-memory streaming snapshots for the session's live calls. */
  readLive(sessionId: string): LiveCall[];
  /**
   * Generate one next-input suggestion for a session's latest completed turn.
   * `requestId` correlates the request with its cancel and lets a caller drop a
   * stale result. Resolves with the suggestion text, or with nothing when there
   * is no useful follow-up. A model, timeout or abort failure resolves empty
   * rather than rejecting; the suggestion is never written to the session.
   */
  suggestPrompt(sessionId: string, requestId: string): Promise<{ suggestion?: string }>;
  /** Cancel one in-flight suggestion request; a no-op once it has settled. */
  cancelPromptSuggest(sessionId: string, requestId: string): Promise<void>;
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
  step: number;
  model: string;
  deviceName: string;
  contextWindow?: number;
}

export interface CallRunRequest {
  spanId: string;
  /** The owning step for a reasoning span, or the owning action for an auxiliary span. */
  parent: string;
  role: CallRole;
  turn?: number;
  step?: number;
  messages: readonly ModelMessage[];
  layers: Record<string, number>;
  /** Required for the `reason` role; ignored for every other role. */
  reason?: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    /** Explicit Fast preference for the main reasoning call. */
    fast?: boolean;
  };
  /** Output-token cap forwarded to the wire `max_tokens` when the driver supports it. */
  maxTokens?: number;
  /** Tools declared on this call; forwarded to the driver for every role. */
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Completed native wy_action tool calls, delivered as each one is parsed. */
  onToolCall?: (call: ToolCall) => void;
  /**
   * The `reason` role's bounded-recovery wait lifecycle: the absolute next
   * probe/recovery instant and the wait reason when a wait begins, `null` when
   * it is cleared. Ignored for other roles.
   */
  onWait?: (state: { reason: ModelWaitReason; retryAt: string } | null) => void;
}

export interface CallRunResult {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order; empty when it returned none. */
  toolCalls: readonly ToolCall[];
  /** Measured facts of the call, produced by the transport. */
  metrics: ModelMetrics;
}

/** Structural match for `calls.ts`'s `CallRunner`. */
export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
  /** Keep one span open across several requests of the same task. */
  holdSpan(spanId: string): void;
  /** Close a held span, writing everything measured so far. */
  releaseSpan(spanId: string, status?: import('./ledger/events.ts').SpanStatus): Promise<void>;
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

/** Structured facts of a failed main reasoning call, handed to the reply view. */
export interface CallFailureSummary {
  model: string;
  /** Normalized transport failure kind. */
  kind: string;
  status?: number;
  /** Supplier's original message. */
  message: string;
  /** Measured facts of the failed call, produced by the transport. */
  metrics?: ModelMetrics;
}

/** The result of one engine model call. */
export interface InvokedCall {
  ok: boolean;
  spanId: string;
  text: string;
  reasoning?: string;
  toolCalls?: readonly ToolCall[];
  /** Measured facts of the call, produced by the transport. */
  metrics?: ModelMetrics;
  error?: string;
  /** Structured main-reasoning failure facts; present only when the call failed. */
  failure?: CallFailureSummary;
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
  /** Reserve the next session-wide action id, shared by reasoning and system actions. */
  nextActionId(session: import('./turn/runtime.ts').SessionRuntime): string;
  appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: import('./turn/runtime.ts').TurnRuntime,
    step?: number,
  ): Promise<void>;
  invoke(
    session: import('./turn/runtime.ts').SessionRuntime,
    turn: import('./turn/runtime.ts').TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra?: {
      spanId?: string;
      /** Span parent; defaults to the step id for `reason`, the turn id otherwise. */
      parent?: string;
      reason?: {
        provider: string;
        model: string;
        reasoningEffort: ReasoningEffort;
        /** Explicit Fast preference forwarded to the main reasoning call. */
        fast?: boolean;
      };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      /** Forwarded to the call runner for the `reason` role's wait lifecycle. */
      onWait?: (state: { reason: ModelWaitReason; retryAt: string } | null) => void;
      tools?: readonly ToolSpec[];
      toolChoice?: ToolChoice;
      maxTokens?: number;
      step?: number;
      /**
       * Overrides the turn's abort signal. A caller-owned signal (a suggestion
       * request) that fires really aborts the upstream request; omitted means
       * the owning turn's signal.
       */
      signal?: AbortSignal;
    },
  ): Promise<InvokedCall>;
  safeCancelTask(taskRunId: string): Promise<void>;
  /**
   * Mark the session's active turn as waiting in bounded recovery: the one live
   * waiting state the engine exposes and the send guard reads, so a repeated
   * continue while a turn waits starts no extra turn. It carries the selected
   * model, effort and attachment identity a resubmission must match.
   */
  setRecoveryWait(sessionId: string, waiting: RecoveryWait): void;
  /**
   * Clear a session's recovery marker, fenced by turn number so the completion
   * or cancel of a different turn can never clear an active wait.
   */
  clearRecoveryWait(sessionId: string, turn: number): void;
}

/** One session's live recovery marker, as exposed by {@link SessionCallHost}. */
export interface RecoveryWait {
  turn: number;
  model: string;
  effort: ReasoningEffort;
  attachmentsKey: string;
}

/**
 * Everything an action needs except its own id and task-run hook; the engine
 * supplies both per action. `currentEvents` is read at each request, so an
 * action always sees the timeline as of now.
 */
export type ActionBaseContext = Omit<ActionRunContext, 'actionId' | 'onTaskRun'>;

export interface EnginePorts {
  ledger: LedgerPort;
  /** Restricted workspace memory upserts, used only after a final reply. */
  memory?: WorkspaceMemoryPort;
  files(snapshot: WorkspaceSnapshot, workspaceRoot: string): FilesPort;
  /** Session-scoped so a `call` event lands on the right timeline. */
  calls(sessionId: string): CallsPort;
  /** Session file store: attachment import, artifact description, image reads. */
  fileStore: FileStore;
}
