import { SessionClient } from '@wrenyard/control-client/session';
import type {
  SessionBackendResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionSummaryModelResult,
} from '@wrenyard/protocol/session';
import type {
  ConversationSnapshot,
  WorkspaceConfigurationSnapshot,
} from './shell-contract.js';

/** Server-side snapshot wait cap; the daemon wakes earlier on any change. */
const SNAPSHOT_WAIT_MS = 1_000;
/** Delay before retrying a dropped session IPC transport. */
const RECONNECT_RETRY_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Placeholder projection used until the session backend answers once. */
function unavailableConversation(
  workspace: WorkspaceConfigurationSnapshot,
  message?: string,
): ConversationSnapshot {
  return {
    status: workspace.status === 'configured' ? 'unavailable' : 'workspace-required',
    workspace,
    sessions: [],
    selectedRunning: false,
    models: { status: 'idle', groups: [] },
    hasMore: false,
    items: [],
    message: message ?? (workspace.status === 'configured'
      ? 'DSH 会话后端暂时不可用'
      : '请先配置 Wrenyard workspace 路径'),
  };
}

export interface DesktopConversationAdapterOptions {
  ipcPath: string;
  initialWorkspace: WorkspaceConfigurationSnapshot;
  /** Renderer notification for every observed conversation revision. */
  onChanged(): void;
  /** Fired on the unavailable→available edge of the session IPC transport. */
  onReconnected?(): void;
}

/**
 * Thin Desktop conversation adapter over the daemon-owned session service.
 *
 * Desktop owns no DSH process, controller, persistence or recovery: it keeps a
 * cached snapshot for synchronous projection (tray active count, settings), and
 * continuously requests versioned snapshots with a bounded wait so idle clients
 * still observe daemon-side changes. Action replies are applied immediately, a
 * dropped IPC transport is reconnected on a fresh client, and `close()` only
 * detaches — hiding, quitting or reconnecting never cancels a backend turn.
 */
export class DesktopConversationAdapter {
  private client: SessionClient | null = null;
  private cached: ConversationSnapshot;
  private workspaceValue: WorkspaceConfigurationSnapshot;
  private revision = 0;
  private cursorKnown = false;
  private appliedOnce = false;
  private unavailable = false;
  private lastError: string | undefined;
  private closed = false;

  constructor(private readonly options: DesktopConversationAdapterOptions) {
    this.workspaceValue = options.initialWorkspace;
    this.cached = unavailableConversation(options.initialWorkspace);
  }

  /** Desktop's own workspace view; the daemon remains authoritative for binding. */
  get workspace(): WorkspaceConfigurationSnapshot {
    return this.workspaceValue;
  }

  /** Last observed conversation projection, for synchronous callers. */
  snapshot(): ConversationSnapshot {
    return this.cached;
  }

  /**
   * Observe the daemon's existing workspace without reconfiguring its backend.
   * Never throws: an unavailable daemon is retried by the poll loop.
   */
  async start(): Promise<void> {
    if (this.closed || this.client) return;
    const client = new SessionClient({ ipcPath: this.options.ipcPath });
    this.client = client;
    await this.prime(client);
    void this.poll(client);
  }

  select(sessionId: string): Promise<ConversationSnapshot> {
    return this.action((client) => client.select({ sessionId }));
  }

  create(): Promise<ConversationSnapshot> {
    return this.action((client) => client.create());
  }

  selectModel(provider: string, model: string, reasoningEffort?: string): Promise<ConversationSnapshot> {
    return this.action((client) => client.selectModel(
      reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort },
    ));
  }

  send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    return this.action((client) => client.send(
      clientTimeZone === undefined ? { text } : { text, clientTimeZone },
    ));
  }

  cancel(turnId?: string): Promise<ConversationSnapshot> {
    return this.action((client) => client.cancel(turnId === undefined ? {} : { turnId }));
  }

  /**
   * Bind a newly activated workspace. Desktop performs activation first and
   * then hands the canonical snapshot over once; reconnects never repeat it.
   */
  async setWorkspace(workspace: WorkspaceConfigurationSnapshot): Promise<ConversationSnapshot> {
    const client = this.requireClient();
    const result = await client.setWorkspace({ workspace });
    this.workspaceValue = workspace;
    this.adopt(result, true);
    return this.cached;
  }

  getSummaryModel(): Promise<SessionSummaryModelResult> {
    return this.requireClient().getSummaryModel();
  }

  setSummaryModel(canonicalModel: string): Promise<SessionSummaryModelResult> {
    return this.requireClient().setSummaryModel({ canonicalModel });
  }

  /** Main-process diagnostics only (runtime state and pid); never renderer IPC. */
  backend(): Promise<SessionBackendResult> {
    return this.requireClient().backend();
  }

  /** Detach from the session transport. Never cancels the backend. */
  close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    client?.close();
    return Promise.resolve();
  }

  private requireClient(): SessionClient {
    if (this.closed || !this.client) {
      throw new Error(this.lastError ?? '请先配置 Wrenyard workspace');
    }
    return this.client;
  }

  private async action(
    invoke: (client: SessionClient) => Promise<SessionSnapshotResult>,
  ): Promise<ConversationSnapshot> {
    const client = this.requireClient();
    const result = await invoke(client);
    if (this.closed || client !== this.client) return this.cached;
    this.adopt(result, true);
    return this.cached;
  }

  private async prime(client: SessionClient): Promise<void> {
    try {
      const result = await client.snapshot({});
      if (this.closed || client !== this.client) return;
      this.adopt(result, true);
    } catch (error) {
      if (this.closed || client !== this.client) return;
      this.markUnavailable(errorMessage(error));
    }
  }

  /**
   * Continuous versioned observation. While the cursor is known the request
   * carries `afterRevision` + `waitMs`, so the daemon answers immediately on any
   * change and at the cap while idle. A failed request only resets the cursor
   * and backs off: the session client reconnects lazily on the next request and
   * re-reads a full snapshot, never replaying a prompt or cancelling a turn.
   */
  private async poll(startingClient: SessionClient): Promise<void> {
    const client = startingClient;
    while (!this.closed && client === this.client) {
      try {
        const params: SessionSnapshotParams = {};
        if (this.cursorKnown) {
          params.afterRevision = this.revision;
          params.waitMs = SNAPSHOT_WAIT_MS;
        }
        const result = await client.snapshot(params);
        if (this.closed || client !== this.client) return;
        const recovered = this.unavailable;
        this.adopt(result, false);
        if (recovered && !this.unavailable) this.options.onReconnected?.();
      } catch (error) {
        if (this.closed || client !== this.client) return;
        this.markUnavailable(errorMessage(error));
        await this.retryDelay();
      }
    }
  }

  /**
   * Adopt one full snapshot. Revisions are monotonic, so a late reply from
   * before the last applied one is discarded rather than regressing the cache.
   */
  private adopt(result: SessionSnapshotResult, notify: boolean): void {
    if (this.appliedOnce && result.revision < this.revision) return;
    const changed = !this.appliedOnce || result.revision !== this.revision;
    this.revision = result.revision;
    this.cached = result.conversation;
    this.workspaceValue = result.conversation.workspace;
    this.appliedOnce = true;
    this.cursorKnown = true;
    this.unavailable = false;
    this.lastError = undefined;
    if (changed || notify) this.options.onChanged();
  }

  private markUnavailable(message: string): void {
    const changed = !this.unavailable || this.lastError !== message;
    this.unavailable = true;
    this.lastError = message;
    this.cursorKnown = false;
    this.appliedOnce = false;
    this.revision = 0;
    if (!changed) return;
    this.cached = unavailableConversation(this.workspaceValue, message);
    this.options.onChanged();
  }

  private retryDelay(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, RECONNECT_RETRY_MS); });
  }
}
