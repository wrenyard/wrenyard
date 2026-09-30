import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DaemonConnectionMode,
  DaemonLifecycleSnapshot,
  DaemonProcessState,
} from './shell-contract.js';
import { incompatibleDaemonMessage, type DaemonProbe } from './daemon-health.js';
import type { PackagedDaemonLaunch } from '../../daemon/lib/daemon/launch.mts';
import { DaemonProcess, type DaemonProcessExitInfo } from '../../daemon/lib/supervisor.mjs';

/**
 * Owns the daemon process when a packaged Desktop is its supervisor. The child
 * is the bundled Node running the daemon bundle's `run` entry. Desktop adds
 * only what an owner adds: it keeps the Node IPC channel to learn when the
 * daemon is `ready` and to ask it to `shutdown`, and respawns it on a crash.
 *
 * All subprocess lifecycle (spawn, readiness, graceful shutdown, awaited exit)
 * lives in the shared `@wrenyard/daemon/supervisor` module; this class keeps the
 * Desktop policy on top: connected vs supervised mode, crash backoff, and a
 * clean stop that never restarts.
 */

const READY_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 150;
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000] as const;
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_RESTARTS = 3;
const CONNECTIVITY_POLL_MS = 5_000;
const STOP_WAIT_MS = 120_000;
const EXIT_POLL_MS = 100;

export interface DaemonSupervisorOptions {
  /** The bundled daemon of a packaged Desktop; null when running from source. */
  launch: PackagedDaemonLaunch | null;
  /** Directory for the owned daemon's stdout/stderr logs. */
  logsDir: string;
  ipcPath: string;
  initialProbe: DaemonProbe;
  desktopVersion: string;
  probe: () => Promise<DaemonProbe>;
  /** `daemon.shutdown {force:true}` over IPC: cancels every task and graph. */
  forceShutdown: () => Promise<void>;
  onChanged: (snapshot: DaemonLifecycleSnapshot) => void;
  env?: NodeJS.ProcessEnv;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DesktopDaemonSupervisor {
  private readonly options: DaemonSupervisorOptions;
  private readonly connectionMode: DaemonConnectionMode;
  private proc: DaemonProcess | null = null;
  private owned = false;
  private state: DaemonProcessState;
  private message: string | undefined;
  private restartTimes: number[] = [];
  private restartTimer?: NodeJS.Timeout;
  private connectivityTimer?: NodeJS.Timeout;
  private probing = false;
  private stopping = false;
  /** True only while spawnOwned is racing a fresh child to readiness. */
  private starting = false;
  /** Serializes start() so two IPC requests never spawn two daemons. */
  private startPromise: Promise<DaemonLifecycleSnapshot> | null = null;
  private disposed = false;
  constructor(options: DaemonSupervisorOptions) {
    this.options = options;
    this.connectionMode = options.initialProbe.connected || !options.launch ? 'connected' : 'supervised';
    const canStart = this.canStart();
    if (options.initialProbe.compatible) {
      this.state = 'running';
    } else if (options.initialProbe.connected) {
      this.state = 'unavailable';
      this.message = incompatibleDaemonMessage(options.initialProbe, options.desktopVersion);
    } else if (canStart) {
      this.state = 'stopped';
    } else {
      this.state = 'unavailable';
      this.message = this.unavailableMessage();
    }
    this.startConnectivityMonitor();
  }

  get mode(): DaemonConnectionMode {
    return this.connectionMode;
  }

  canStart(): boolean {
    if (this.mode !== 'supervised') return false;
    return this.resolveInvocation() !== null;
  }

  snapshot(): DaemonLifecycleSnapshot {
    return {
      mode: this.mode,
      state: this.state,
      canStart: this.canStart(),
      restartCount: this.restartTimes.length,
      ...(this.proc?.pid !== undefined ? { pid: this.proc.pid } : {}),
      ...(this.message !== undefined ? { message: this.message } : {}),
    };
  }

  /** Launch the daemon when Desktop owns it. A reachable daemon is left alone. */
  async start(): Promise<DaemonLifecycleSnapshot> {
    if (this.disposed) return this.snapshot();
    // The guard is set in the same synchronous turn as the first await inside
    // doStart(), so a second start() sees it before this child is spawned.
    if (this.startPromise) return this.startPromise;
    const promise = this.doStart();
    this.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  async restart(): Promise<DaemonLifecycleSnapshot> {
    await this.stop();
    this.restartTimes = [];
    return this.start();
  }

  /** Graceful stop of the Desktop-owned daemon (drains via the IPC `shutdown`). */
  async stop(): Promise<void> {
    this.clearRestartTimer();
    const proc = this.proc;
    if (proc === null) {
      if (this.owned) {
        this.owned = false;
        this.setState('stopped');
      }
      return;
    }
    this.stopping = true;
    try {
      const exited = await proc.shutdown({ timeoutMs: STOP_WAIT_MS });
      if (!exited) {
        // The daemon still runs; keep the child so the stop can be retried
        // instead of reporting a stop that never happened.
        throw new Error(`daemon ${proc.pid ?? 'unknown'} 未在 ${STOP_WAIT_MS}ms 内退出；保留进程与状态`);
      }
    } finally {
      this.stopping = false;
    }
    this.starting = false;
    if (this.proc === proc) this.proc = null;
    this.owned = false;
    proc.release();
    this.setState('stopped');
  }

  /** Force-cancel every task/graph over IPC, then reap the owned child. */
  async forceStop(): Promise<void> {
    this.clearRestartTimer();
    if (!this.proc) return;
    try {
      await this.options.forceShutdown();
    } catch {
      // The daemon may be gone already; the reap below is what matters.
    }
    await this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRestartTimer();
    if (this.connectivityTimer) clearInterval(this.connectivityTimer);
    this.connectivityTimer = undefined;
    if (this.proc) {
      this.proc.release();
      this.proc = null;
    }
    this.owned = false;
  }

  private async doStart(): Promise<DaemonLifecycleSnapshot> {
    if (this.proc !== null) return this.snapshot();
    const probe = await this.options.probe();
    if (probe.connected && !probe.compatible) {
      this.setState('unavailable', incompatibleDaemonMessage(probe, this.options.desktopVersion));
      return this.snapshot();
    }
    if (probe.compatible) {
      this.owned = false;
      this.setState('running');
      return this.snapshot();
    }
    const invocation = this.mode === 'supervised' ? this.resolveInvocation() : null;
    if (invocation === null) {
      this.setState('unavailable', this.unavailableMessage());
      return this.snapshot();
    }
    await this.spawnOwned(invocation);
    return this.snapshot();
  }

  private unavailableMessage(): string {
    if (!this.options.launch) return '未连接到 daemon，请先运行 `pnpm dev` 或 `pnpm --filter @wrenyard/daemon dev`';
    return this.mode === 'connected' ? 'daemon 不可用，请由原启动方重新启动' : '未找到随包的 Wrenyard daemon';
  }

  private resolveInvocation(): PackagedDaemonLaunch | null {
    const launch = this.options.launch;
    if (!launch || !isFile(launch.command) || !isFile(launch.args[0]!)) return null;
    return launch;
  }

  private async spawnOwned(invocation: PackagedDaemonLaunch): Promise<void> {
    const logsDir = this.options.logsDir;
    mkdirSync(logsDir, { recursive: true });
    const stdoutPath = join(logsDir, 'wrenyard-out.log');
    const stderrPath = join(logsDir, 'wrenyard-error.log');

    let proc!: DaemonProcess;
    let launchPromise!: Promise<void>;
    let stdoutFd = -1;
    let stderrFd = -1;
    try {
      stdoutFd = openSync(stdoutPath, 'a');
      stderrFd = openSync(stderrPath, 'a');
      let ref: DaemonProcess | null = null;
      proc = new DaemonProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: this.options.env ?? process.env,
        ipcPath: this.options.ipcPath,
        readyTimeoutMs: READY_TIMEOUT_MS,
        pollIntervalMs: PROBE_INTERVAL_MS,
        stopTimeoutMs: STOP_WAIT_MS,
        exitPollMs: EXIT_POLL_MS,
        probe: async () => (await this.options.probe()).compatible,
        stdio: ['ignore', stdoutFd, stderrFd, 'ipc'],
        onExit: (info) => { if (ref) this.onProcessExit(ref, info); },
      });
      ref = proc;
      // Spawn synchronously while the log descriptors are still open, then
      // release our copies and await readiness.
      launchPromise = proc.launch();
    } catch (error) {
      if (stdoutFd >= 0) closeSync(stdoutFd);
      if (stderrFd >= 0) closeSync(stderrFd);
      this.setState('failed', `无法启动 daemon：${errorMessage(error)}`);
      return;
    }
    if (stdoutFd >= 0) closeSync(stdoutFd);
    if (stderrFd >= 0) closeSync(stderrFd);

    this.proc = proc;
    this.owned = true;
    this.stopping = false;
    this.starting = true;
    this.setState('starting', '正在启动 daemon');

    try {
      // Readiness is the `ready` message or a live health probe; the shared
      // module also rejects on spawn error, early exit or timeout.
      await launchPromise;
      const probe = await this.options.probe();
      if (!probe.compatible) throw new Error(incompatibleDaemonMessage(probe, this.options.desktopVersion));
    } catch (error) {
      this.failStart(proc, `daemon 启动失败：${errorMessage(error)}`);
      return;
    }
    this.finishStart();
  }

  private finishStart(): void {
    this.starting = false;
    this.setState('running');
  }

  /**
   * Abandon a bootstrap that never became ready: reap only this failed child and
   * never restart automatically.
   */
  private failStart(proc: DaemonProcess, message: string): void {
    this.starting = false;
    this.owned = false;
    if (this.proc === proc) this.proc = null;
    void proc.kill();
    this.setState('failed', message);
  }

  private onProcessExit(proc: DaemonProcess, info: DaemonProcessExitInfo): void {
    const current = this.proc === proc;
    if (current) this.proc = null;
    // A replaced or already-reaped child never touches the current lifecycle.
    if (!current) return;
    // Exit during startup is a start failure driven by the launch() rejection.
    if (this.starting) return;
    if (this.stopping || this.disposed || info.expected) {
      this.owned = false;
      this.setState('stopped');
      return;
    }
    if (info.code === 0 && info.signal === null) {
      // Requested outside Desktop (e.g. `wrenyard daemon stop`): never restart.
      this.owned = false;
      this.setState('stopped', 'daemon 已停止');
      return;
    }
    this.owned = false;
    this.scheduleRestart(info.code, info.signal);
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.setState('failed', 'daemon 多次意外退出，已停止自动重启');
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.restartTimes.length, RESTART_DELAYS_MS.length - 1)];
    this.restartTimes.push(now);
    this.setState('starting', `daemon 意外退出（退出码 ${code ?? 'none'}${signal ? `，信号 ${signal}` : ''}），${Math.round(delay / 1_000)} 秒后重启`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  private startConnectivityMonitor(): void {
    this.connectivityTimer = setInterval(() => {
      if (this.disposed || this.owned || this.proc !== null || this.restartTimer || this.probing) return;
      this.probing = true;
      void this.options.probe().then((probe) => {
        if (this.disposed || this.owned || this.proc !== null || this.restartTimer) return;
        if (probe.compatible) {
          if (this.state !== 'running') this.setState('running');
          return;
        }
        // Only a live projection may be downgraded: an owned stop/failure
        // reason and a pending restart must survive the poll unchanged.
        if (this.state !== 'running' && this.state !== 'unavailable') return;
        const message = probe.connected ? incompatibleDaemonMessage(probe, this.options.desktopVersion)
          : this.canStart() ? 'daemon 已停止，可重新启动' : this.unavailableMessage();
        if (this.state !== 'unavailable' || this.message !== message) {
          this.setState('unavailable', message);
        }
      }).catch(() => undefined).finally(() => { this.probing = false; });
    }, CONNECTIVITY_POLL_MS);
    this.connectivityTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private setState(state: DaemonProcessState, message?: string): void {
    this.state = state;
    this.message = message;
    this.options.onChanged(this.snapshot());
  }
}
