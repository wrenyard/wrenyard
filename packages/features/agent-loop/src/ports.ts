/**
 * Loop-owned port types.
 *
 * The loop package must never import the session ledger, the session turn
 * runtime or a daemon protocol schema. The vocabulary it needs is therefore
 * declared here, shape for shape, so a session (or a bot kernel, or the CLI)
 * can satisfy these ports with its own concrete types. Nothing in this module
 * is an implementation: it is the contract between the loop and its host.
 */

import type { AuxiliaryRunRecordInput } from '@wrenyard/protocol'

// ─── Model wire vocabulary ──────────────────────────────────────────────────

/** Public reasoning level a route may be called at. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default';

/** Every auxiliary role a model call may carry. */
export type AuxiliaryCallRole =
  | 'title'
  | 'memory-search'
  | 'search'
  | 'dispatch'
  | 'document'
  | 'todo'
  | 'vcs'
  | 'project'
  | 'reply'
  | 'status'
  | 'suggestion'
  | 'task-output';

/** Every role a model call may carry. */
export type CallRole =
  | 'reason'
  | 'memory-search'
  | 'search'
  | 'dispatch'
  | 'reply'
  | 'title'
  | 'document'
  | 'todo'
  | 'vcs'
  | 'project'
  | 'status'
  | 'suggestion'
  | 'task-output';

/** One OpenAI-compatible content part. */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One tool a caller declares on a request, in protocol-neutral form. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One native tool call the model returned, in protocol-neutral form. */
export interface ToolCall {
  index: number;
  id: string;
  name: string;
  /** Raw JSON arguments text, exactly as upstream produced it. */
  arguments: string;
}

/** A completed tool call plus its parsed arguments. */
export interface ModelToolCall extends ToolCall {
  parsed?: unknown;
  parseError?: string;
}

/** One tool call an earlier assistant output started, replayed on a request. */
export interface MessageToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments text, exactly as the model produced it. */
  arguments: string;
}

/** How the caller wants tools used; mirrors the session ToolChoice shape. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** One message of a request, in protocol-neutral form. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  /** `assistant` only. */
  toolCalls?: MessageToolCall[];
  /** `tool` only. */
  toolCallId?: string;
}

/** Provider-reported usage; absent values stay absent. */
export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Normalized completion reason. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

/** Normalized model failure class. */
export type ModelErrorKind =
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth'
  | 'model_unavailable'
  | 'invalid_request'
  | 'context_overflow'
  | 'protocol'
  | 'interrupted'
  | 'aborted';

/** Which upstream response header supplied an adopted retry hint. */
export type RetryAfterSource = 'retry-after' | 'retry-after-ms';

/** An upstream retry hint the transport actually adopted. */
export interface RetryAfterHint {
  source: RetryAfterSource;
  value: string;
  delayMs: number;
  /** Absolute instant (epoch ms) before which no retry may start. */
  retryAt: number;
}

/** One request actually issued by a call. */
export interface ModelAttempt {
  status?: number;
  error?: ModelErrorKind;
  ms: number;
  waitedMs?: number;
  retryAfter?: RetryAfterHint;
  model?: string;
  routeUntil?: string;
}

/** Measured facts of one completed or failed call, produced by the transport. */
export interface ModelMetrics {
  responseModel?: string;
  finishReason?: FinishReason;
  usage?: Usage;
  ttftMs?: number;
  streamMs?: number;
  streamTokens?: number;
  attempts: ModelAttempt[];
}

// ─── Ledger draft vocabulary ────────────────────────────────────────────────

/**
 * The minimal envelope of one ledger event. `currentEvents()` is only ever
 * forwarded to the host's own renderer, so the loop never reads a member.
 */
export interface LedgerEvent {
  seq: number;
  at: string;
  type: string;
  turn?: number;
  step?: number;
}

/** The workspace change kinds a recorded update may carry. */
export type WorkspaceChange =
  | 'created'
  | 'updated'
  | 'committed'
  | 'pushed'
  | 'pulled'
  | 'worktree-created'
  | 'worktree-removed'
  | 'worktree-merged'
  | 'registered'
  | 'deleted';

/** One `workspace.changed` draft, without the ledger's own `seq` / `at`. */
export interface WorkspaceChangedDraft {
  type: 'workspace.changed';
  turn?: number;
  step?: number;
  parent: string;
  scope: 'document' | 'workspace' | 'project';
  target: string;
  change: WorkspaceChange;
  worktreeId?: string;
  version?: string;
  hash?: string;
  files?: string[];
}

/** One `document.content` draft, without the ledger's own `seq` / `at`. */
export interface DocumentContentDraft {
  type: 'document.content';
  turn?: number;
  step?: number;
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

/**
 * The only ledger drafts the loop produces. Narrowing the union here keeps
 * every draft structurally assignable to a host ledger's own event union.
 */
export type LedgerEventDraft = WorkspaceChangedDraft | DocumentContentDraft;

/** Frozen workspace facts the loop reads. */
export interface WorkspaceSnapshot {
  deviceName: string;
  takenAt: string;
}

/** One registered project the auxiliary user message lists. */
export interface ProjectInfo {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
}

/** Everything one loop run reads from its owning action. */
export interface ActionRunContext {
  sessionId: string;
  turn: number;
  step: number;
  /** The owning action id; auxiliary spans use it as their `parent`. */
  actionId: string;
  snapshot: WorkspaceSnapshot;
  currentEvents(): readonly LedgerEvent[];
  projects: readonly ProjectInfo[];
  signal: AbortSignal;
}

/** One parsed action the runner receives. */
export interface ParsedAction {
  type: string;
  intent: string;
  name?: string;
}

/** Result of executing one action, as the host action layer consumes it. */
export interface ActionExecutionOutcome {
  status: 'done' | 'failed';
  result: string;
  /** Drafts whose append is deferred until the step's reasoning event. */
  deferred: LedgerEventDraft[];
}

// ─── Model call port ────────────────────────────────────────────────────────

/** One model request the loop issues. */
export interface CallRunRequest {
  spanId: string;
  /** The owning action for an auxiliary span. */
  parent: string;
  role: CallRole;
  turn?: number;
  step?: number;
  messages: readonly Message[];
  layers: Record<string, number>;
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  signal: AbortSignal;
}

/** The result of one model request. */
export interface CallRunResult {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order. */
  toolCalls: readonly ToolCall[];
  /** Measured facts of the call. */
  metrics: ModelMetrics;
  /**
   * The route the last completed request actually served, when the host could
   * resolve one. Mirrors the same provider/model/effort identity reported on the
   * span's `finished` event so an auxiliary loop can record the run's route.
   */
  route?: { provider?: string; model?: string; effort?: string };
}

/** The model transport the loop calls through. */
export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
  /** Keep one span open across several requests of the same task. */
  holdSpan(spanId: string): void;
  /** Close a held span, writing everything measured so far. */
  releaseSpan(spanId: string, status?: 'ok' | 'failed' | 'aborted' | 'interrupted'): Promise<void>;
  /**
   * Optional hook a host supplies so a finished auxiliary run is recorded into
   * the unified run record (the daemon ledger / stats store). Invoked once per
   * finished auxiliary run with the run's id, role, caller session, status,
   * resolved route, summed usage, timing and summary. Absent hosts (CLI, bots
   * without persistence) simply skip the record.
   */
  recordAuxiliaryRun?(input: AuxiliaryRunRecordInput): void;
}

// ─── Method catalog port ────────────────────────────────────────────────────

/** One callable protocol method: name, description and params JSON Schema. */
export interface MethodInfo {
  name: string;
  description: string;
  params: Record<string, unknown>;
}

/** The context a catalog call carries; the loop sets the definition id. */
export interface MethodCallContext {
  turn?: number;
  step?: number;
  actionId?: string;
  sessionId?: string;
  auxiliaryDefinitionId?: string;
}

/**
 * The host's protocol-method catalog. The daemon implements it from the
 * protocol registry and RPC router; the loop never imports a schema.
 */
export interface MethodCatalogPort {
  /** Describe the named methods, in request order. */
  methods(names: readonly string[], context?: MethodCallContext): Promise<MethodInfo[]>;
  /** Invoke one method with raw params. */
  call(method: string, params: unknown, context?: MethodCallContext): Promise<unknown>;
}

// ─── Injected helpers ───────────────────────────────────────────────────────

/** One observed tool interaction to diagnose. */
export type ToolCallObservation =
  | { kind: 'enumeration'; tools: readonly string[]; wanted: string }
  | { kind: 'call'; tool: string; arguments: unknown; environment?: string; result: string }
  | { kind: 'handshake'; enumerated: readonly string[]; called: string; environment?: string };

/** An evidence-backed diagnosis of a tool observation. */
export type ToolDiagnosis = {
  code: 'tool-missing' | 'tool-call-rejected' | 'function-not-enumerated' | 'no-mcp';
  tool: string;
  evidence: string;
  message: string;
};

/** One verified tool contract to record. */
export interface ToolContractRecord {
  target: { project: string; task: string; worktree?: string };
  tool: string;
  arguments: unknown;
  environment: string;
  evidence: string;
  at: string;
}

/**
 * The host helpers the loop used to import from the session package. They are
 * injected so the loop owns no session module and every host keeps its own
 * rendering and diagnostics unchanged.
 */
export interface LoopHelpers {
  /** Human-readable message of an unknown thrown value. */
  messageOf(error: unknown): string;
  /** Escape one body of text for a tagged context block. */
  escapeBody(text: string): string;
  /** Render the conversation events block of the auxiliary user message. */
  renderEventsBlock(events: readonly LedgerEvent[]): string;
  /** Optional token estimator for bounded conversation rendering. */
  estimateTokens?(text: string): number;
  /** Optional per-event renderer; undefined means omit the event. */
  renderEvent?(event: LedgerEvent): string | undefined;
  /** Optional conversation budget before intent and tag reserves. */
  conversationTokenBudget?: number;
}
