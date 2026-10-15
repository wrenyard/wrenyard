/**
 * Single active-connection context.
 *
 * Exactly one daemon endpoint is active at a time. This manager owns the active
 * endpoint and a monotonically increasing *generation*: every switch bumps the
 * generation, fences work started under the previous generation, and resets the
 * whole application's endpoint-bound state together. It never runs local and
 * remote business operations at the same time and never silently falls back to
 * local when a remote tunnel drops.
 *
 * States:
 *  - `local`        — the local daemon endpoint is active.
 *  - `connecting`   — a switch (to remote or back to local) is in progress.
 *  - `remote`       — the remote endpoint (via the SSH relay) is active.
 *  - `disconnected` — a remote connection was active and then lost; this is
 *                     explicitly *remote-disconnected*, not a local fallback.
 */

export type ActiveConnectionState = 'local' | 'connecting' | 'remote' | 'disconnected';

export interface ActiveRemoteHost {
  /** SSH alias of the active (or last) remote host. */
  alias: string;
  /** Display name shown to the user. */
  displayName: string;
  platform?: string;
  arch?: string;
}

export interface ActiveConnectionSnapshot {
  state: ActiveConnectionState;
  /** Increments on every switch; stale-generation work is rejected. */
  generation: number;
  /** Present while connecting/remote and retained through a disconnect. */
  host: ActiveRemoteHost | null;
  /** Human-readable reason for a refusal or a disconnect. */
  message?: string;
}

/** Raised when a switch is refused because user work is in flight. */
export class ConnectionBusyError extends Error {
  readonly code = 'busy';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionBusyError';
  }
}

/** Raised when a stale-generation reply must be discarded. */
export class StaleGenerationError extends Error {
  readonly code = 'stale_generation';
  constructor(message: string) {
    super(message);
    this.name = 'StaleGenerationError';
  }
}

export interface ActiveConnectionContextOptions {
  /** Apply the active endpoint to every consumer (client, subscriptions, etc.). */
  applyEndpoint: (endpoint: string) => void;
  /**
   * Reset session selection, drafts and all data caches together. Called on
   * every completed transition and on a tunnel loss, so no view keeps showing
   * the previous context's data. It is async and always awaited, so a caller
   * observes the real end state instead of a placeholder "atomic" completion.
   * A rejection is not a reason to undo a committed switch: it is surfaced on
   * the snapshot (see {@link ActiveConnectionContext.connectToRemote}) rather
   * than propagated or rolled back.
   */
  resetCaches: (info: { reason: string }) => Promise<void>;
  /** Fired after every state/generation change. */
  onStateChange?: (snapshot: ActiveConnectionSnapshot) => void;
  /**
   * External busy check, in addition to this manager's own operation counter.
   * It must report real app work still in flight (running daemon tasks,
   * taskgraphs, session turns) so a switch is refused instead of killing it.
   */
  hasActiveOperations?: () => boolean;
}

/** Closure returned by {@link ActiveConnectionContext.beginOperation}. */
export type OperationRelease = () => void;

/** A captured connection state that {@link ActiveConnectionContext.restore} can undo. */
export interface ConnectionCheckpoint {
  state: ActiveConnectionState;
  host: ActiveRemoteHost | null;
  endpoint: string;
  message?: string;
}

export class ActiveConnectionContext {
  private readonly options: ActiveConnectionContextOptions;
  private state: ActiveConnectionState = 'local';
  private generation = 0;
  private host: ActiveRemoteHost | null = null;
  private message: string | undefined;
  /** The always-available local daemon endpoint; never overwritten by a switch. */
  private readonly localEndpoint: string;
  /** The endpoint every consumer currently points at. */
  private activeEndpoint: string;
  private switching = false;
  private activeOperations = 0;
  private readonly listeners = new Set<(snapshot: ActiveConnectionSnapshot) => void>();

  constructor(options: ActiveConnectionContextOptions & { localEndpoint: string }) {
    this.options = options;
    this.localEndpoint = options.localEndpoint;
    this.activeEndpoint = options.localEndpoint;
    this.options.applyEndpoint(this.localEndpoint);
  }

  snapshot(): ActiveConnectionSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      host: this.host,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /** The current generation; consumers capture it to fence their own replies. */
  currentGeneration(): number {
    return this.generation;
  }

  /** The endpoint all control consumers currently resolve to. */
  endpoint(): string {
    return this.activeEndpoint;
  }

  /**
   * True only while the local daemon is the committed active endpoint. Every
   * other state — `connecting`, `disconnected`, `remote` — is a non-local host
   * context, so local paths and local-only actions must never run there.
   */
  isLocal(): boolean {
    return this.state === 'local';
  }

  /** True while a remote endpoint is committed (not connecting, not lost). */
  isRemote(): boolean {
    return this.state === 'remote';
  }

  /**
   * Business operations are allowed only while a committed endpoint is active:
   * the local daemon, or a fully switched remote. `connecting` and
   * `disconnected` are denied, so a request can neither race a half-open target
   * nor be sent to a lost endpoint.
   */
  allowsBusinessOperations(): boolean {
    return this.state === 'local' || this.state === 'remote';
  }

  onChange(listener: (snapshot: ActiveConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** True when a result produced under `generation` is still current. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** Reject a stale-generation result instead of letting it leak into a view. */
  assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new StaleGenerationError('连接上下文已切换，忽略过期结果');
    }
  }

  /**
   * Run `work` only while the captured generation is still current: a reply
   * that resolves after a switch is discarded instead of being applied.
   */
  async runFenced<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = await work();
    this.assertCurrent(generation);
    return result;
  }

  /**
   * Register an in-flight business operation. While any operation is in flight a
   * switch is refused rather than killing the user's work. The returned release
   * function is idempotent.
   */
  beginOperation(): OperationRelease {
    this.activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperations = Math.max(0, this.activeOperations - 1);
    };
  }

  private isBusy(): boolean {
    return this.activeOperations > 0 || this.options.hasActiveOperations?.() === true;
  }

  /**
   * Switch to a remote endpoint. `start` owns the *entire* readiness, persist
   * and switch sequence; it receives the reserved generation and returns the
   * active local endpoint path (for example the SSH relay's local owner-only
   * socket) plus the verified host metadata. The target stays hidden until
   * `start` resolves, so nothing is retargeted before persistence succeeded.
   *
   * The transition lock and the generation are taken synchronously, before the
   * first await, so the whole sequence is single-flight and a second switch can
   * never interleave.
   *
   * Only a failure *before* persistence rolls back to the previous endpoint,
   * state and host, so a half-open candidate can never be left active and the
   * app never silently changes context. Once `start` has resolved the host is
   * already saved, so the commit is fail-closed instead: a failure to retarget
   * consumers or refresh caches keeps the saved host and the remote endpoint
   * intent and ends explicitly `disconnected` (see {@link commitRemote}). A
   * tunnel *loss* after a successful switch is the other path to `disconnected`
   * (see {@link markDisconnected}).
   */
  async connectToRemote(
    host: ActiveRemoteHost,
    start: (generation: number) => Promise<{ endpoint: string; host?: ActiveRemoteHost }>,
  ): Promise<ActiveConnectionSnapshot> {
    if (this.switching) {
      throw new ConnectionBusyError('已有连接切换正在进行，请稍候');
    }
    if (this.isBusy()) {
      throw new ConnectionBusyError('当前有任务正在进行，完成后才能切换连接');
    }
    const previous: ConnectionCheckpoint = {
      state: this.state,
      host: this.host,
      endpoint: this.activeEndpoint,
      ...(this.message ? { message: this.message } : {}),
    };
    // Taken before the first await: no other switch can start, and every
    // business request is denied while the state is `connecting`.
    this.switching = true;
    this.generation += 1;
    const generation = this.generation;
    this.state = 'connecting';
    this.host = host;
    this.message = undefined;
    this.emit();
    try {
      let started: { endpoint: string; host?: ActiveRemoteHost };
      try {
        started = await start(generation);
      } catch (error) {
        // Registry persistence failed (or a pre-commit step threw): roll back to
        // the previous endpoint and keep the failure visible. Nothing was saved,
        // so this is not a silent local fallback: the caller reports `error` and
        // the previous context is exactly what it was before the attempt.
        this.activeEndpoint = previous.endpoint;
        this.host = previous.host;
        this.options.applyEndpoint(previous.endpoint);
        this.state = previous.state === 'connecting' ? 'disconnected' : previous.state;
        this.message = error instanceof Error ? error.message : String(error);
        this.emit();
        await this.refreshCaches('connect-failed');
        throw error;
      }
      // A newer switch or a tunnel loss superseded this attempt.
      this.assertCurrent(generation);
      // `start` persisted the host registry before it resolved, so the commit
      // from here on is fail-closed and can never re-enter the pre-save
      // rollback above.
      await this.commitRemote(started.endpoint, started.host ?? host);
      return this.snapshot();
    } finally {
      this.switching = false;
    }
  }

  /**
   * Commit a remote transition whose persistence already succeeded.
   *
   * Nothing here may fall back to the previous context or report a false
   * "unsaved" result. The endpoint retarget, the state emit and the whole-app
   * cache reset are each allowed to fail, and any failure keeps the saved host
   * and the remote endpoint intent and leaves the app explicitly
   * `disconnected`, with business operations denied until the user reconnects
   * or returns to local explicitly.
   */
  private async commitRemote(endpoint: string, host: ActiveRemoteHost): Promise<void> {
    // Retained even if a later step fails: this is the remote endpoint intent.
    this.activeEndpoint = endpoint;
    this.host = host;
    this.state = 'remote';
    this.message = undefined;
    // A throwing endpoint apply or listener must not be misrouted into the
    // pre-save rollback, so each fallible commit step is contained here.
    try {
      this.options.applyEndpoint(endpoint);
    } catch (error) {
      this.failClosedAfterCommit(error);
      return;
    }
    try {
      this.emit();
    } catch (error) {
      this.failClosedAfterCommit(error);
      return;
    }
    // The reset is awaited so the caller observes the real end state, but a
    // rejection only surfaces a message: it never rolls back and never loops.
    const refreshError = await this.refreshCaches('connect-remote');
    if (refreshError !== undefined) {
      this.failClosedAfterCommit(refreshError);
    }
  }

  /**
   * Post-persistence commit failure. The host registry is already saved, so
   * this never rolls back to local and never reports a false unsaved result: it
   * keeps the saved host and the remote endpoint intent, moves to an explicit
   * `disconnected` state with an actionable message, and emits so the renderer
   * unmounts business pages while business operations stay denied.
   */
  private failClosedAfterCommit(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.state = 'disconnected';
    this.message = `远程连接已保存，但切换到远程上下文失败：${detail}。请重新连接，或显式返回本地。`;
    // A throwing listener must not turn this into a pre-save rollback.
    try {
      this.emit();
    } catch {
      // Nothing further can be done to report the failure.
    }
  }

  /**
   * Await the caller's cache reset without letting it undo a transition: the
   * reset is part of committing a new context, never a reason to reject it, so a
   * failure is returned as a message for the snapshot to surface. The caller
   * still logs the underlying error, so no diagnostic is lost.
   */
  private async refreshCaches(reason: string): Promise<string | undefined> {
    try {
      await this.options.resetCaches({ reason });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Explicit return to the local endpoint. It refreshes all views and never
   * stops an externally owned remote daemon (that is the caller's concern).
   */
  async returnToLocal(): Promise<ActiveConnectionSnapshot> {
    if (this.switching) {
      throw new ConnectionBusyError('连接切换进行中，请稍候');
    }
    if (this.isBusy()) {
      throw new ConnectionBusyError('当前有任务正在进行，完成后才能返回本地');
    }
    this.generation += 1;
    this.state = 'local';
    this.host = null;
    this.message = undefined;
    this.activeEndpoint = this.localEndpoint;
    this.options.applyEndpoint(this.localEndpoint);
    this.emit();
    await this.refreshCaches('return-to-local');
    return this.snapshot();
  }

  /**
   * Tunnel loss. Stay explicitly `disconnected` (remote): never fall back to
   * local, but keep the host so the user can reconnect or return explicitly.
   *
   * Only a committed remote can be lost. A report from a candidate switch that
   * never committed (state `connecting`) or from an already-lost context is
   * ignored, so a candidate's failure can never mark the previous active remote
   * lost.
   */
  async markDisconnected(message: string): Promise<ActiveConnectionSnapshot> {
    if (this.state !== 'remote') return this.snapshot();
    this.generation += 1;
    this.state = 'disconnected';
    this.message = message;
    this.emit();
    await this.refreshCaches('tunnel-lost');
    return this.snapshot();
  }

  /**
   * Capture the current connection so a committed switch can be undone when a
   * later step of the same transaction fails (for example the config write).
   */
  checkpoint(): ConnectionCheckpoint {
    return {
      state: this.state,
      host: this.host,
      endpoint: this.activeEndpoint,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /**
   * Undo a committed switch back to a captured checkpoint. It bumps the
   * generation so work started under the abandoned switch is fenced, restores
   * the endpoint every consumer points at, and resets all caches so no view
   * keeps showing the abandoned context.
   */
  async restore(checkpoint: ConnectionCheckpoint, reason: string): Promise<ActiveConnectionSnapshot> {
    this.generation += 1;
    this.activeEndpoint = checkpoint.endpoint;
    this.host = checkpoint.host;
    this.state = checkpoint.state;
    this.message = checkpoint.message;
    this.options.applyEndpoint(checkpoint.endpoint);
    this.emit();
    await this.refreshCaches(reason);
    return this.snapshot();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    this.options.onStateChange?.(snapshot);
  }
}
