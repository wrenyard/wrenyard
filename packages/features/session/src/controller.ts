import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type {
  ConversationSnapshot,
  SessionBackendResult,
  WorkspaceConfigurationSnapshot,
} from '@wrenyard/protocol/session';
import {
  startSessionBackend,
  type ConfiguredWorkspace,
  type SessionBackend,
  type StartedSessionBackend,
  type StartSessionBackendOptions,
} from './backend.js';
import { unavailableConversation } from './dsh-conversation-client.js';
import { sameGatewayIdentity } from './gateway-identity.js';

/** Daemon/DSH recovery interval; conservative and unref'd so it never blocks exit. */
const GATEWAY_RECOVERY_INTERVAL_MS = 2_000;

export interface SessionControllerOptions {
  stateRoot: string;
  initialWorkspace: WorkspaceConfigurationSnapshot;
  ipcPath: string;
  getGatewayConnection: () => Promise<WrenyardGatewayConnection>;
  waitForTaskRun: (taskRunId: string, signal: AbortSignal) => Promise<unknown>;
  cancelTaskRun: (taskRunId: string) => Promise<void>;
  summarize: StartSessionBackendOptions['summarize'];
  /** Published whenever the product projection may have changed. */
  onChanged: () => void;
  /**
   * Test seam: replaces the DSH backend start with an injected factory that
   * receives the exact StartSessionBackendOptions the controller would pass to
   * startSessionBackend. Production leaves this unset, so the real DSH backend
   * is always started there.
   */
  backendFactory?: (options: StartSessionBackendOptions) => Promise<StartedSessionBackend>;
}

/**
 * Serializes DSH session-backend transitions while keeping the process alive,
 * and owns the bounded gateway recovery watcher.
 *
 * A workspace change, a provider-key model refresh, an unexpected backend exit
 * and an ordinary recovery all take the same path: stop the current backend,
 * start exactly one replacement, and never replay a prompt, draft or task that
 * the previous backend was holding. Every transition is serialized, so two
 * concurrent recovery triggers can never produce two live backends.
 */
export class SessionController {
  private workspaceValue: WorkspaceConfigurationSnapshot;
  private backend: SessionBackend | null = null;
  private error: string | undefined;
  private generation = 0;
  private transition: Promise<void> = Promise.resolve();
  private transitioning = false;
  private closed = false;
  /** Selected session id remembered before an unexpected exit or forced replacement. */
  private restoreSessionId: string | undefined;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private gatewayDownObserved = false;
  /** Gateway connection read at backend spawn time, for identity comparison only. */
  private lastGatewayConnection: WrenyardGatewayConnection | null = null;
  /**
   * A gateway model refresh whose backend rebuild is deferred because turns were
   * still running. The watcher completes it once no turn is active, so
   * configuring a provider key never cancels an ongoing message.
   */
  private pendingModelRefreshRebuild = false;

  constructor(private readonly options: SessionControllerOptions) {
    this.workspaceValue = options.initialWorkspace;
  }

  get workspace(): WorkspaceConfigurationSnapshot {
    return this.workspaceValue;
  }

  /**
   * Live pid of the active session's DSH backend child; main-process
   * observability only. Clears naturally when the backend is replaced, stopped,
   * or exits unexpectedly.
   */
  get backendProcessId(): number | undefined {
    return this.backend?.backendProcessId;
  }

  /** Live backend state for main-process diagnostics. */
  backendState(): SessionBackendResult {
    if (this.backend) {
      return {
        state: 'running',
        ...(this.backend.backendProcessId !== undefined ? { pid: this.backend.backendProcessId } : {}),
      };
    }
    if (this.error) return { state: 'failed', message: this.error };
    if (this.transitioning) return { state: 'starting' };
    return { state: 'stopped' };
  }

  /** Start the backend for the initial workspace and arm the recovery watcher. */
  start(): Promise<void> {
    this.startWatcher();
    return this.configure(this.workspaceValue);
  }

  configure(workspace: WorkspaceConfigurationSnapshot): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.transitioning = true;
      try {
        const generation = ++this.generation;
        const previous = this.backend;
        this.backend = null;
        this.workspaceValue = workspace;
        this.error = undefined;
        await previous?.stop();
        this.options.onChanged();

        if (workspace.status !== 'configured' || !workspace.path) return;
        const configured: ConfiguredWorkspace = {
          ...workspace,
          status: 'configured',
          path: workspace.path,
        };
        try {
          const started = await this.createBackend(configured, generation);
          if (started === null) return;
          this.backend = started.backend;
          this.lastGatewayConnection = started.gateway;
          this.options.onChanged();
        } catch (error) {
          if (generation === this.generation) {
            this.error = error instanceof Error ? error.message : String(error);
            this.options.onChanged();
          }
          throw error;
        }
      } finally {
        this.transitioning = false;
      }
    });
  }

  recover(force = false): Promise<void> {
    return this.enqueue(() => this.recoverInternal(force));
  }

  /**
   * Restore a live DSH backend for the configured workspace when none is live,
   * or replace the ready backend when force is true. A strict no-op when a
   * backend is already live and force is false. Selected-session continuity is
   * best-effort: the id selected before the exit/replacement is re-selected
   * once on the replacement backend before ready is published.
   */
  private recoverInternal(force: boolean): Promise<void> {
    return (async () => {
      if (this.closed) return;
      if (this.backend && !force) return;

      this.transitioning = true;
      try {
        const generation = ++this.generation;
        const previous = this.backend;
        if (previous) this.restoreSessionId = previous.snapshot().selectedSessionId;
        this.backend = null;
        this.error = undefined;
        await previous?.stop();
        this.options.onChanged();

        const workspace = this.workspaceValue;
        if (workspace.status !== 'configured' || !workspace.path) return;
        const configured: ConfiguredWorkspace = {
          ...workspace,
          status: 'configured',
          path: workspace.path,
        };
        try {
          const started = await this.createBackend(configured, generation);
          if (started === null) return;
          this.backend = started.backend;
          this.lastGatewayConnection = started.gateway;
          const restore = this.restoreSessionId;
          this.restoreSessionId = undefined;
          if (restore !== undefined) await started.backend.select(restore);
          this.options.onChanged();
        } catch (error) {
          if (generation === this.generation) {
            this.error = error instanceof Error ? error.message : String(error);
            this.options.onChanged();
          }
          throw error;
        }
      } finally {
        this.transitioning = false;
      }
    })();
  }

  /**
   * Refresh the backend after provider credentials changed: the DSH model patch
   * is generated from the gateway connection at spawn time, so new routes only
   * become selectable once the backend is rebuilt with a fresh patch. Deferred
   * while any turn runs; a gateway whose identity did not change needs no
   * rebuild at all.
   */
  refreshModels(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      if (this.workspaceValue.status !== 'configured' || !this.workspaceValue.path) return;
      // Mark the refresh pending before any read or recovery is attempted: if
      // the gateway snapshot cannot be read, or the rebuild below fails
      // transiently, the flag must survive so the recovery watcher retries it
      // instead of the new provider route being silently lost for this session.
      this.pendingModelRefreshRebuild = true;
      const connection = await this.readGatewayConnection();
      if (!connection) {
        warn('gateway connection refresh after provider change failed', undefined);
        return;
      }
      // Only a confirmed unchanged gateway identity makes the refresh unnecessary.
      if (this.lastGatewayConnection !== null && sameGatewayIdentity(this.lastGatewayConnection, connection)) {
        this.pendingModelRefreshRebuild = false;
        return;
      }
      if (this.hasActiveTurns()) return;
      // Already inside the serialized transition, so the rebuild is invoked
      // directly instead of re-entering the queue.
      await this.recoverInternal(true)
        .then(() => { this.pendingModelRefreshRebuild = false; })
        .catch((error: unknown) => warn('conversation backend rebuild after provider change failed', error));
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.stopWatcher();
    return this.enqueue(async () => {
      this.generation += 1;
      const backend = this.backend;
      this.backend = null;
      this.pendingModelRefreshRebuild = false;
      await backend?.stop();
      this.options.onChanged();
    });
  }

  snapshot(): ConversationSnapshot {
    return this.backend?.snapshot() ?? unavailableConversation(this.workspaceValue, this.error);
  }

  select(sessionId: string): Promise<ConversationSnapshot> {
    return this.requireBackend().select(sessionId);
  }

  create(): Promise<ConversationSnapshot> {
    return this.requireBackend().create();
  }

  selectModel(provider: string, model: string, reasoningEffort?: string): Promise<ConversationSnapshot> {
    return this.requireBackend().selectModel(provider, model, reasoningEffort);
  }

  send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    return this.requireBackend().send(text, clientTimeZone);
  }

  cancel(turnId?: string): Promise<ConversationSnapshot> {
    return this.requireBackend().cancel(turnId);
  }

  /**
   * True while any conversation turn is still executing. Rebuilding the DSH
   * backend under an active turn would cancel it, so this is exactly the state
   * a deferred rebuild waits on.
   */
  private hasActiveTurns(): boolean {
    const snapshot = this.snapshot();
    if (snapshot.status !== 'ready') return false;
    return snapshot.selectedRunning === true
      || snapshot.sessions.some((session) => session.running)
      || (snapshot.turns?.some((turn) => turn.running) ?? false);
  }

  /** Start one backend, or report that a newer transition already superseded it. */
  private async createBackend(
    workspace: ConfiguredWorkspace,
    generation: number,
  ): Promise<{ backend: SessionBackend; gateway: WrenyardGatewayConnection } | null> {
    const startBackend = this.options.backendFactory ?? startSessionBackend;
    const started = await startBackend({
      stateRoot: this.options.stateRoot,
      workspace,
      ipcPath: this.options.ipcPath,
      getGatewayConnection: this.options.getGatewayConnection,
      waitForTaskRun: this.options.waitForTaskRun,
      cancelTaskRun: this.options.cancelTaskRun,
      summarize: this.options.summarize,
      onChanged: this.options.onChanged,
      onUnexpectedExit: (message) => this.handleUnexpectedExit(generation, message),
    });
    if (generation !== this.generation) {
      await started.backend.stop();
      return null;
    }
    return started;
  }

  private requireBackend(): SessionBackend {
    if (!this.backend) throw new Error(this.error ?? '请先配置 Wrenyard workspace');
    return this.backend;
  }

  private handleUnexpectedExit(generation: number, message: string): void {
    if (generation !== this.generation) return;
    const backend = this.backend;
    if (backend) this.restoreSessionId = backend.snapshot().selectedSessionId;
    this.backend = null;
    this.error = message;
    void Promise.resolve(backend?.stop()).catch(() => undefined);
    this.options.onChanged();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.catch(() => undefined).then(operation);
    this.transition = result.catch(() => undefined);
    return result;
  }

  private startWatcher(): void {
    if (this.watcher) return;
    const watcher = setInterval(() => {
      if (this.tickRunning || this.closed) return;
      this.tickRunning = true;
      void this.recoveryTick().finally(() => {
        this.tickRunning = false;
      });
    }, GATEWAY_RECOVERY_INTERVAL_MS);
    (watcher as { unref?: () => void }).unref?.();
    this.watcher = watcher;
  }

  private stopWatcher(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
    this.tickRunning = false;
    this.gatewayDownObserved = false;
    this.pendingModelRefreshRebuild = false;
  }

  /**
   * Bounded gateway/backend recovery tick. Each healthy read lets an
   * unexpectedly exited backend rebuild; the first down->up transition compares
   * the fresh gateway connection identity against the one used at spawn time
   * and forces a single backend rebuild only when the identity changed. Never
   * replays a prompt, draft, task or navigation.
   */
  private async recoveryTick(): Promise<void> {
    const workspaceConfigured = this.workspaceValue.status === 'configured'
      && Boolean(this.workspaceValue.path);
    const connection = await this.readGatewayConnection();
    if (!connection) {
      this.gatewayDownObserved = true;
      return;
    }
    if (this.gatewayDownObserved) {
      this.gatewayDownObserved = false;
      const identityChanged = this.lastGatewayConnection !== null
        && !sameGatewayIdentity(this.lastGatewayConnection, connection);
      this.lastGatewayConnection = connection;
      if (!workspaceConfigured) {
        this.pendingModelRefreshRebuild = false;
        return;
      }
      // A forced identity rebuild already carries the freshest gateway models,
      // so a deferred provider refresh becomes obsolete the moment it runs —
      // but only once that rebuild actually succeeded.
      await this.recover(identityChanged)
        .then(() => {
          if (identityChanged) this.pendingModelRefreshRebuild = false;
        })
        .catch((error: unknown) => warn('gateway recovery failed', error));
      return;
    }
    if (!workspaceConfigured) {
      this.pendingModelRefreshRebuild = false;
      return;
    }
    if (this.pendingModelRefreshRebuild) {
      // Complete the deferred provider-key rebuild only once every turn settled;
      // while any is still running the rebuild stays deferred, never forced.
      if (this.hasActiveTurns()) return;
      // The flag is cleared only after a successful rebuild: a transient
      // recovery failure must leave it pending so the next tick retries.
      await this.recover(true)
        .then(() => { this.pendingModelRefreshRebuild = false; })
        .catch((error: unknown) => warn('deferred provider model refresh failed', error));
      return;
    }
    await this.recover(false).catch((error: unknown) => warn('DSH session recovery failed', error));
  }
  /**
   * Read the live gateway connection, treating an unreadable snapshot as a
   * gateway outage rather than as an unchanged gateway.
   */
  private async readGatewayConnection(): Promise<WrenyardGatewayConnection | undefined> {
    try {
      return await this.options.getGatewayConnection();
    } catch {
      return undefined;
    }
  }
}

function warn(context: string, error?: unknown): void {
  const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
  console.warn(`[wrenyard-session] ${context}${detail}`);
}
