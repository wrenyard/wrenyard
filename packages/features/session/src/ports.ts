/**
 * session ports: the host surface a session runs on, the public `Session`
 * interface, and the module ports the engine is composed from.
 */

import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
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
import type { ModelMessage, ToolCall, Usage } from './driver.ts';
import type { AttachmentInput, FileStore, TaskArtifact } from './media.ts';
import type { DocCatalogEntry } from './workspace.ts';
import type { ActionRunContext } from './actions.ts';
import type { ViewsPort } from './views.ts';

// ─── Public host and session surface ───────────────────────────────────────

export interface ProjectInfo {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
}

export interface SessionHost {
  workspaceRoot: string;
  stateRoot: string;
  deviceName: string;
  gateway(): Promise<WrenyardGatewayConnection>;
  /** The product-wired provider definitions main inference validates its
   *  target against. */
  resolveInferenceProvider(providerId: string): ProviderDefinition | undefined;
  cheapModel(): Promise<string>;
  listProjects(): Promise<ProjectInfo[]>;
  gitHead(checkoutPath: string): Promise<{ branch?: string; head?: string }>;
  listTaskDefinitions(): Promise<{ id: string; description: string; project?: string; inputSummary: string[] }[]>;
  describeTask(id: string, project?: string): Promise<{
    description: string;
    inputSchema: unknown;
    /** Definition source, e.g. `builtin` or `project`. */
    source: string;
    /** True only for the trusted builtin document singleton. */
    builtinDoc: boolean;
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
}

/** Structural match for `calls.ts`'s `CallRunner`. */
export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
}

/**
 * Everything an action needs except its own id and task-run hook; the engine
 * supplies both per action. `currentEvents` is read at each request, so an
 * action always sees the timeline as of now.
 */
export type ActionBaseContext = Omit<ActionRunContext, 'actionId' | 'onTaskRun'>;

export interface EnginePorts {
  ledger: LedgerPort;
  createSnapshot(input: SnapshotInput): Promise<WorkspaceSnapshot>;
  files(snapshot: WorkspaceSnapshot, workspaceRoot: string): FilesPort;
  views: ViewsPort;
  /** Session-scoped so a `call` event lands on the right timeline. */
  calls(sessionId: string): CallsPort;
  /** Session file store: attachment import, artifact description, image reads. */
  fileStore: FileStore;
}
