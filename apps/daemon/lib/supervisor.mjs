// Minimal daemon subprocess supervisor shared by the Desktop wrapper and
// scripts/dev.ts. It owns exactly one foreground `daemon run` child: spawn, readiness
// (the `ready` IPC message or a live `health.ping`), graceful shutdown over the
// shared version-checked control client, and awaited real exit. The exit
// callback distinguishes an expected/normal exit from a crash.
//
// The module depends only on Node builtins and @wrenyard/control so both
// the esbuild-bundled Desktop and the source supervisor can import it, and it
// never derives a path from its own module location: the caller supplies the
// complete invocation.

import { spawn } from 'node:child_process';
import { WrenyardIpcClient } from '@wrenyard/control';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_STOP_TIMEOUT_MS = 120_000;
const DEFAULT_EXIT_POLL_MS = 100;
const DEFAULT_IPC_TIMEOUT_MS = 1_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * One NDJSON JSON-RPC call over the owner-only IPC socket through the shared
 * version-checked control client. The client is always closed; the first
 * request also runs the `health.ping` protocol-version handshake, so a
 * mismatched daemon fails closed instead of speaking a stale protocol.
 */
export async function ipcCall(ipcPath, method, params = {}, timeoutMs = DEFAULT_IPC_TIMEOUT_MS) {
  const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: timeoutMs });
  try {
    return await client.request(method, params, { timeoutMs });
  } finally {
    client.close();
  }
}

/** True when the daemon answers `health.ping` with `ok: true` on `ipcPath`. */
export async function isDaemonHealthy(ipcPath, timeoutMs = DEFAULT_IPC_TIMEOUT_MS) {
  try {
    const health = await ipcCall(ipcPath, 'health.ping', {}, timeoutMs);
    return health != null && health.ok === true;
  } catch {
    return false;
  }
}

/**
 * One supervised `daemon run` child.
 *
 * @param {object} options
 * @param {string} options.command   Executable to run (the caller's Node/runtime).
 * @param {string[]} options.args    Complete argv (must include `daemon run`).
 * @param {string} [options.cwd]     Child working directory.
 * @param {NodeJS.ProcessEnv} [options.env] Child environment.
 * @param {string} options.ipcPath   Endpoint probed for readiness and shut down.
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.stopTimeoutMs]
 * @param {number} [options.exitPollMs]
 * @param {() => Promise<boolean>} [options.probe] Readiness probe override.
 * @param {(info: {code: number|null, signal: string|null, expected: boolean}) => void} [options.onExit]
 * @param {import('node:child_process').StdioOptions} [options.stdio]
 */
export class DaemonProcess {
  constructor(options) {
    this.options = options;
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this._child = null;
    this._expected = false;
    this._failedStart = false;
  }

  /** The live child (undefined before launch and after release). */
  get child() {
    return this._child;
  }

  get running() {
    return this._child !== null && this.exitCode === null && this.signalCode === null;
  }

  /** Spawn the child and resolve once it is ready; reject on failure/timeout. */
  launch() {
    if (this._child !== null) return Promise.resolve();
    const { command, args, cwd, env, stdio } = this.options;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: false,
      shell: false,
      stdio: stdio ?? ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    this._child = child;
    this.pid = child.pid;
    this.exitCode = null;
    this.signalCode = null;
    this._expected = false;
    this._failedStart = false;

    const readyTimeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const probe = this.options.probe ?? (() => isDaemonHealthy(this.options.ipcPath));

    return new Promise((resolve, reject) => {
      let childReady = false;
      let spawnError = null;
      let settled = false;
      let pollTimer;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        clearTimeout(pollTimer);
        if (!error) { resolve(); return; }
        // A child that never became ready must not be left running behind the
        // rejected launch, and its exit must not surface as a crash: the owner
        // already received the startup failure through this rejection.
        this._failedStart = true;
        this._child = null;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(error);
      };
      const readyTimer = setTimeout(
        () => settle(new Error(`daemon did not become ready within ${readyTimeoutMs}ms`)),
        readyTimeoutMs,
      );
      const poll = async () => {
        if (settled) return;
        if (spawnError) { settle(spawnError); return; }
        if (!this.running) { settle(new Error('daemon exited before it became ready')); return; }
        if (childReady) { settle(); return; }
        try {
          if (await probe()) { settle(); return; }
        } catch { /* keep polling until the deadline */ }
        if (!settled) pollTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
      };
      child.on('message', (message) => { if (message === 'ready') childReady = true; });
      child.on('error', (error) => { spawnError = error; });
      child.on('exit', (code, signal) => {
        const expected = this._expected;
        this.exitCode = code;
        this.signalCode = signal;
        if (!settled) settle(new Error('daemon exited before it became ready'));
        // A failed start already surfaced through launch()'s rejection and the
        // owner drives its own failure state, so it is never reported as a crash.
        if (!this._failedStart) this.options.onExit?.({ code, signal, expected });
      });
      void poll();
    });
  }

  /**
   * Graceful shutdown: send the `daemon.shutdown` RPC through the shared
   * version-checked control client and await the real exit. The owned Node IPC
   * `shutdown` message is only a fallback when the RPC transport is
   * unavailable. With `force`, the RPC also asks the daemon to cancel admitted
   * work and, if the child still has not exited, the supervisor escalates to
   * SIGKILL; a forced request escalates a graceful drain that is already
   * pending. Returns whether the child exited within the bounded wait.
   */
  async shutdown({ force = false, timeoutMs = this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS } = {}) {
    const child = this._child;
    if (child === null || !this.running) return true;
    this._expected = true;
    let requested = false;
    try {
      await ipcCall(
        this.options.ipcPath,
        'daemon.shutdown',
        { reason: force ? 'forced supervisor stop' : 'supervisor stop', force },
        DEFAULT_IPC_TIMEOUT_MS,
      );
      requested = true;
    } catch { /* fall through to the owned IPC channel */ }
    if (!requested && child.connected) {
      // The no-op callback routes a channel-closed send error to the callback
      // instead of an unhandled 'error' event on the child.
      try { child.send('shutdown', () => {}); } catch { /* channel already gone */ }
    }
    let exited = await this.waitForExit(timeoutMs);
    if (!exited && force) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      exited = await this.waitForExit(10 * DEFAULT_EXIT_POLL_MS);
    }
    return exited;
  }

  /** Kill the child immediately and await its real exit. */
  async kill() {
    const child = this._child;
    if (child === null || !this.running) return;
    this._expected = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await this.waitForExit(10 * DEFAULT_EXIT_POLL_MS);
  }

  /** Resolve true when the child has exited within `timeoutMs`. */
  waitForExit(timeoutMs) {
    if (!this.running) return Promise.resolve(true);
    const child = this._child;
    return new Promise((resolveWait) => {
      const deadline = Date.now() + timeoutMs;
      const exitPollMs = this.options.exitPollMs ?? DEFAULT_EXIT_POLL_MS;
      let settled = false;
      let timer;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExit);
        resolveWait(exited);
      };
      const onExit = () => finish(true);
      const tick = () => {
        if (!this.running) { finish(true); return; }
        if (Date.now() >= deadline) { finish(false); return; }
        timer = setTimeout(tick, exitPollMs);
      };
      child.on('exit', onExit);
      timer = setTimeout(tick, exitPollMs);
    });
  }

  /** Drop listeners and references without killing the child (Desktop dispose). */
  release() {
    if (this._child) this._child.removeAllListeners();
    this._child = null;
  }
}
