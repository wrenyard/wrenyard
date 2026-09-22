import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type {
  ConversationSnapshot,
  SessionBackendResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionSelectModelParams,
  SessionSelectModelResult,
  SessionSelectParams,
  SessionSelectResult,
  SessionSendParams,
  SessionSendResult,
  SessionSetWorkspaceParams,
  SessionSetWorkspaceResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionSummaryModelResult,
  SessionSummaryModelSetParams,
  WorkspaceConfigurationSnapshot,
} from '@wrenyard/protocol/session';
import { refreshCatalog } from './catalog.js';
import { SessionController } from './controller.js';
import { createConversationSummaryService, SummaryModelPreferenceStore } from './conversation-summary.js';
import { unavailableConversation, type ConversationSummaryInput } from './dsh-conversation-client.js';
import { summaryPreferencePath } from './state-root.js';
import { buildSummarySettingsSnapshot } from './summary-settings.js';
import { assertConsistentWorkspace } from './workspace-registry.js';
import { resolveDshVersion } from './paths.js';

/** Upper bound of one `session.snapshot` wait, regardless of the requested budget. */
const MAX_SNAPSHOT_WAIT_MS = 1_000;

/**
 * Injected dependencies. The feature owns the DSH process, the conversation
 * engine, persistence and recovery; everything that belongs to the daemon or to
 * the hosting application is pushed in:
 *
 * - `stateRoot` and `initialWorkspace` describe the product's local state.
 * - `ipcPath` is the daemon control socket DSH's MCP tools legitimately use.
 * - `getGatewayConnection` reads the live daemon gateway projection used both
 *   for the DSH model patch and for gateway identity recovery.
 * - `waitForTaskRun` / `cancelTaskRun` are in-process task-run ownership
 *   callbacks; the feature never opens its own daemon connection for them.
 */
export interface SessionServiceOptions {
  stateRoot: string;
  initialWorkspace: WorkspaceConfigurationSnapshot;
  ipcPath: string;
  getGatewayConnection: () => Promise<WrenyardGatewayConnection>;
  waitForTaskRun: (taskRunId: string, signal: AbortSignal) => Promise<unknown>;
  cancelTaskRun: (taskRunId: string) => Promise<void>;
}

/**
 * The conversation session service.
 *
 * Construction is side-effect free and safe before DSH exists: no filesystem
 * write, no child process and no socket happens until `start()`. Every action
 * returns the full versioned projection, so a caller can never hold a stale or
 * partially merged conversation.
 */
export class SessionService {
  private readonly options: SessionServiceOptions;
  private readonly preferenceStore: SummaryModelPreferenceStore;
  private readonly summary: ReturnType<typeof createConversationSummaryService>;
  private controller: SessionController | null = null;
  private starting: Promise<void> | undefined;
  private closed = false;
  private workspaceValue: WorkspaceConfigurationSnapshot;
  /** Epoch seed: a revision from an earlier process can never be mistaken for a live one. */
  private readonly revisionSeed = Date.now();
  private revision = this.revisionSeed;
  private readonly waiters = new Set<() => void>();

  constructor(options: SessionServiceOptions) {
    this.options = options;
    this.workspaceValue = options.initialWorkspace;
    this.preferenceStore = new SummaryModelPreferenceStore(summaryPreferencePath(options.stateRoot));
    this.summary = createConversationSummaryService({
      readGatewayConnection: options.getGatewayConnection,
      preferenceStore: this.preferenceStore,
    });
  }

  /**
   * Load the Catalog, start the DSH backend for the initial workspace and arm
   * the bounded recovery watcher. Idempotent — the first call owns the start.
   *
   * A failure is propagated so the host can report it, but it does not poison
   * the service: the projection stays `unavailable`/`failed`, every action
   * returns that truthful state, and the recovery watcher keeps retrying in the
   * background. No prompt, draft or task is ever replayed by a retry.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.starting ??= this.startInternal();
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    await refreshCatalog();
    if (this.closed) return;
    const controller = new SessionController({
      stateRoot: this.options.stateRoot,
      initialWorkspace: this.options.initialWorkspace,
      ipcPath: this.options.ipcPath,
      getGatewayConnection: this.options.getGatewayConnection,
      waitForTaskRun: this.options.waitForTaskRun,
      cancelTaskRun: this.options.cancelTaskRun,
      summarize: (input: ConversationSummaryInput) => this.summary.summarize(input),
      onChanged: () => this.noteChanged(),
    });
    this.controller = controller;
    await controller.start();
  }

  /**
   * Stop the backend and release every resource this service owns, including
   * any caller still waiting inside `snapshot()`.
   */
  async close(): Promise<void> {
    this.closed = true;
    const controller = this.controller;
    this.controller = null;
    this.starting = undefined;
    this.noteChanged();
    try { await controller?.close(); } finally { this.drainWaiters(); }
  }

  /**
   * Return the full conversation projection with its revision.
   *
   * When `afterRevision` equals the current revision the call waits — bounded by
   * `waitMs`, never more than 1000ms — for the next change or terminal flush and
   * then returns a complete snapshot. A different revision returns immediately.
   * The response is never a delta, so a lagging caller cannot diverge.
   */
  async snapshot(params?: SessionSnapshotParams): Promise<SessionSnapshotResult> {
    const afterRevision = params?.afterRevision;
    if (!this.closed && afterRevision !== undefined && afterRevision === this.revision) {
      const requested = params?.waitMs ?? 0;
      const budget = Math.min(Math.max(requested, 0), MAX_SNAPSHOT_WAIT_MS);
      await this.waitForChange(afterRevision, budget);
    }
    return this.result();
  }

  async select(params: SessionSelectParams): Promise<SessionSelectResult> {
    return this.act(() => this.requireController().select(params.sessionId));
  }

  /** `session.create` is a local draft reset: no durable session is created. */
  async create(_params?: SessionCreateParams): Promise<SessionCreateResult> {
    return this.act(() => this.requireController().create());
  }

  async selectModel(params: SessionSelectModelParams): Promise<SessionSelectModelResult> {
    return this.act(() => this.requireController().selectModel(
      params.provider,
      params.model,
      params.reasoningEffort,
    ));
  }

  async send(params: SessionSendParams): Promise<SessionSendResult> {
    return this.act(() => this.requireController().send(params.text, params.clientTimeZone));
  }

  async cancel(params: SessionCancelParams): Promise<SessionCancelResult> {
    return this.act(() => this.requireController().cancel(params.turnId));
  }

  /**
   * Bind a new workspace. The daemon workspace is authoritative, so a
   * configured workspace is validated against the configured workspace root
   * (canonical paths must match) before the backend is replaced; a mismatch is
   * refused instead of silently rebinding the conversation elsewhere. A
   * missing/invalid workspace is bound as-is, so the projection can truthfully
   * report that no workspace is usable.
   */
  async setWorkspace(params: SessionSetWorkspaceParams): Promise<SessionSetWorkspaceResult> {
    const workspace: WorkspaceConfigurationSnapshot = params.workspace.status === 'configured'
      && params.workspace.path
      ? {
          ...params.workspace,
          path: await assertConsistentWorkspace(params.workspace, this.options.initialWorkspace),
        }
      : params.workspace;
    const controller = this.requireController();
    if (workspace.status === this.workspaceValue.status && workspace.path === this.workspaceValue.path) {
      return this.result();
    }
    await controller.configure(workspace);
    this.workspaceValue = workspace;
    return this.result();
  }

  /** The persisted summary-model preference plus its live usable options. */
  async getSummaryModel(): Promise<SessionSummaryModelResult> {
    return {
      summary: await buildSummarySettingsSnapshot({
        readGatewayConnection: this.options.getGatewayConnection,
        readSummaryModel: () => this.summary.selectedModel(),
      }),
    };
  }

  /** Persist one canonical summary model id (never a token or provider route). */
  async setSummaryModel(params: SessionSummaryModelSetParams): Promise<SessionSummaryModelResult> {
    this.preferenceStore.save(params.canonicalModel);
    return this.getSummaryModel();
  }

  /** Live DSH backend state. Main-process diagnostics only, never the renderer. */
  backend(): SessionBackendResult {
    return { ...(this.controller?.backendState() ?? { state: 'stopped' }), version: resolveDshVersion() };
  }

  /**
   * Refresh the backend after provider credentials changed. Deferred while any
   * turn runs so configuring a key never cancels an ongoing message; a no-op
   * before the service has started.
   */
  async refreshModels(): Promise<void> {
    if (!this.controller) return;
    await this.controller.refreshModels();
  }

  private async act(operation: () => Promise<ConversationSnapshot>): Promise<SessionSnapshotResult> {
    const before = this.revision;
    await operation();
    // An action reply is itself a projection: make sure its revision differs
    // from the caller's cursor so a concurrent waiter wakes up.
    if (this.revision === before) this.noteChanged();
    return this.result();
  }

  private result(): SessionSnapshotResult {
    return {
      conversation: this.controller?.snapshot()
        ?? unavailableConversation(this.workspaceValue),
      revision: this.revision,
    };
  }

  private requireController(): SessionController {
    if (this.closed || !this.controller) throw new Error('会话服务尚未启动');
    return this.controller;
  }

  private noteChanged(): void {
    this.revision = Math.max(this.revision, this.revisionSeed) + 1;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private drainWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private waitForChange(afterRevision: number, budgetMs: number): Promise<void> {
    if (budgetMs <= 0 || this.revision !== afterRevision) return Promise.resolve();
    return new Promise<void>((resolveWait) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(waiter);
        resolveWait();
      };
      timer = setTimeout(waiter, budgetMs);
      this.waiters.add(waiter);
      // A change that landed between the caller's read and this registration
      // must still wake the waiter immediately instead of stalling it.
      if (this.revision !== afterRevision) waiter();
    });
  }
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  return new SessionService(options);
}
