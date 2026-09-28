import type { DaemonConnectionMode } from './shell-contract.js';

/**
 * Electron-free quit orchestration. It decides *whether* a quit must drain,
 * drives a blocking dialog with live task/taskgraph counts, and only then asks
 * the caller to exit. The Electron surfaces (dialog window, tray, windows, power
 * events) are injected so the policy stays deterministic and testable.
 */

export interface QuitCounts {
  /**
   * Daemon-reported idleness. It already accounts for active tasks, taskgraphs,
   * executions and conversations, and is the single readiness signal.
   */
  idle: boolean;
  activeTaskCount: number;
  /** Active taskgraph runs, distinct from the legacy workflow count. */
  activeTaskGraphCount: number;
}

export interface QuitDialogHandle {
  /** `null` means the daemon status is currently unavailable. */
  update(counts: QuitCounts | null): void;
  focus(): void;
  close(): void;
  /** Resolves only when the user chooses "force end". */
  forced: Promise<void>;
}

export interface QuitDialogPresenter {
  open(counts: QuitCounts | null): QuitDialogHandle;
}

export interface QuitControllerOptions {
  daemonMode: () => DaemonConnectionMode;
  /** Live daemon counts; `null` when the daemon status is unavailable. */
  readCounts: () => Promise<QuitCounts | null>;
  /** Graceful stop of the Desktop-owned daemon (drains, never cancels). */
  stopDaemon: () => Promise<void>;
  /** Cancel every task/taskgraph and stop the daemon (`daemon.shutdown {force:true}`). */
  forceCancel: () => Promise<void>;
  presenter: QuitDialogPresenter;
  /** Run the final teardown and exit the app. */
  exit: () => void;
  pollIntervalMs?: number;
}

export interface QuitController {
  /** User/app quit: drain a supervised daemon when busy, then exit. */
  requestQuit(options?: { bypassDrain?: boolean }): void;
  /** System shutdown/logout: cancel everything and exit without a dialog. */
  forceQuit(): void;
  /** Record an OS shutdown so the next quit takes the forced path. */
  markSystemShutdown(): void;
  isQuitting(): boolean;
  /** True while the blocking drain dialog owns the Desktop surfaces. */
  isBlocking(): boolean;
  /** Returns true when a second instance must only focus the dialog. */
  handleSecondInstance(): boolean;
}

function isIdle(counts: QuitCounts): boolean {
  return counts.idle === true;
}

export function createQuitController(options: QuitControllerOptions): QuitController {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let quitting = false;
  /** True from the first quit request until the app actually exits. */
  let finishing = false;
  let settled = false;
  let forcePromise: Promise<void> | null = null;
  let blocking = false;
  let systemShutdown = false;
  let handle: QuitDialogHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Only a Desktop-owned daemon may ever be stopped; a connected external one never is. */
  const ownsDaemon = (): boolean => options.daemonMode() === 'supervised';
  const forceOwnedDaemon = (): Promise<void> => {
    if (!forcePromise) forcePromise = options.forceCancel().catch(() => undefined);
    return forcePromise;
  };

  const finish = async (force: boolean): Promise<void> => {
    if (settled) return;
    if (finishing) {
      // A graceful stop is already draining: a forced request escalates it.
      if (force && ownsDaemon()) void forceOwnedDaemon();
      return;
    }
    finishing = true;
    blocking = false;
    clearTimer();
    try {
      // Only a Desktop-owned daemon is ever stopped; a connected external
      // daemon is left running, not even on OS shutdown.
      if (ownsDaemon()) {
        if (force) await forceOwnedDaemon();
        else await options.stopDaemon();
      }
    } catch {
      // Teardown is best effort; the exit below must always run.
    }
    if (forcePromise) await forcePromise;
    settled = true;
    handle?.close();
    handle = null;
    options.exit();
  };

  const drain = async (): Promise<void> => {
    const counts = await options.readCounts().catch(() => null);
    if (finishing || settled) return;
    if (counts !== null && isIdle(counts)) {
      void finish(false);
      return;
    }
    blocking = true;
    handle = options.presenter.open(counts);
    void handle.forced.then(() => { void finish(true); }).catch(() => undefined);
    const poll = async (): Promise<void> => {
      if (!blocking) return;
      const next = await options.readCounts().catch(() => null);
      if (!blocking) return;
      // A null status is never idle: keep the dialog showing counts/error until
      // the daemon is confirmed idle (which includes confirmed absence).
      handle?.update(next);
      if (next !== null && isIdle(next)) {
        void finish(false);
        return;
      }
      timer = setTimeout(() => { void poll(); }, pollIntervalMs);
    };
    timer = setTimeout(() => { void poll(); }, pollIntervalMs);
  };

  return {
    requestQuit(requestOptions = {}) {
      // The updater install path must complete the final teardown exactly once,
      // even if a drain somehow already started.
      if (requestOptions.bypassDrain === true) {
        quitting = true;
        void finish(false);
        return;
      }
      if (quitting) return;
      quitting = true;
      if (!ownsDaemon()) {
        // Connection mode: only disconnect; the daemon is owned elsewhere.
        void finish(false);
        return;
      }
      if (systemShutdown) {
        void finish(true);
        return;
      }
      void drain().catch(() => { void finish(false); });
    },
    forceQuit() {
      systemShutdown = true;
      quitting = true;
      void finish(true);
    },
    markSystemShutdown() {
      systemShutdown = true;
    },
    isQuitting: () => quitting,
    isBlocking: () => blocking,
    handleSecondInstance() {
      if (!blocking) return false;
      handle?.focus();
      return true;
    },
  };
}
