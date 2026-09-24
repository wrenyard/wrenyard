import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { spawnManaged, tsxLoaderInvocation } from './spawn.mjs';

/**
 * Marker the isolated probe prints on stdout only after the next daemon built,
 * started, bound HTTP + IPC, answered health, and closed cleanly. The parent
 * requires this marker *and* exit code 0 before anything live is stopped.
 */
export const PREFLIGHT_OK_MARKER = 'WRENYARD_PREFLIGHT_OK';

/** Overall bound for the daemon build plus the isolated startup probe. */
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_CAPTURE_CHARS = 64 * 1024;
const TREE_KILL_TIMEOUT_MS = 5_000;
const TAIL_CHARS = 4_000;

/**
 * Inherited identifiers and endpoints that would make the probe child either
 * look like, or talk to, a live source-development instance. They are deleted
 * and never re-created: the probe root fully owns every endpoint it uses.
 */
const INHERITED_INSTANCE_KEYS = Object.freeze([
  'WRENYARD_SOURCE_DEV',
  'WRENYARD_DEV_SUPERVISED',
  'WRENYARD_DEV_INSTANCE_ID',
  'WRENYARD_DEV_LAUNCH_ID',
  'WRENYARD_DEV_CONTROL',
  'WRENYARD_SOURCE_CHECKOUT',
  'WRENYARD_ROOT',
  'WRENYARD_CLI',
  'WRENYARD_NODE_BIN',
  'WRENYARD_DESKTOP_BIN',
  'WRENYARD_DESKTOP_PID',
  'WRENYARD_IPC_PATH',
  'FOREMAN_IPC_PATH',
  'FOREMAN_PET_FOREMAN_IPC',
  'WRENYARD_WORKSPACE',
  'FOREMAN_WORKSPACE',
]);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function tail(text) {
  const value = String(text ?? '');
  return value.length <= TAIL_CHARS ? value : value.slice(value.length - TAIL_CHARS);
}

export function preflightProbeTag() {
  return `${process.pid}-${randomBytes(6).toString('hex')}`;
}

/** Unique business-IPC endpoint owned by the probe root (never a live path). */
export function preflightIpcPath(platform, root, tag) {
  return platform === 'win32'
    ? `\\\\.\\pipe\\wrenyard-preflight-${tag}`
    : join(root, 'run', 'daemon.sock');
}

/**
 * Fully isolated environment for the probe child. Every writable home, state,
 * config, database, Desktop user-data and IPC endpoint points inside `root`, and
 * every inherited instance identifier/real endpoint is removed, so the probe can
 * neither read nor mutate live state and can never be reached by a live stack.
 *
 * Exported so the isolation contract can be reviewed (and asserted) statically.
 */
export function buildPreflightEnv(options) {
  const baseEnv = options.baseEnv ?? process.env;
  const root = options.root;
  const platform = options.platform ?? process.platform;
  const tag = options.tag ?? preflightProbeTag();
  if (!root) throw new Error('buildPreflightEnv requires a root');

  const env = { ...baseEnv };
  for (const key of INHERITED_INSTANCE_KEYS) delete env[key];

  const home = join(root, 'home');
  const ipcPath = preflightIpcPath(platform, root, tag);

  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(root, 'appdata', 'roaming');
  env.LOCALAPPDATA = join(root, 'appdata', 'local');
  env.XDG_CONFIG_HOME = join(root, 'xdg', 'config');
  env.XDG_STATE_HOME = join(root, 'xdg', 'state');
  env.XDG_DATA_HOME = join(root, 'xdg', 'data');
  env.XDG_CACHE_HOME = join(root, 'xdg', 'cache');
  env.WRENYARD_STATE_HOME = join(root, 'state');
  env.WRENYARD_CONFIG_HOME = join(root, 'config');
  env.WRENYARD_DESKTOP_USER_DATA = join(root, 'desktop');
  env.FOREMAN_DB_PATH = join(root, 'state', 'foreman.db');
  env.CODEX_HOME = join(root, 'codex');
  // A unique named pipe/socket guarantees the probe never reaches a live daemon.
  env.WRENYARD_IPC_PATH = ipcPath;
  env.FOREMAN_IPC_PATH = ipcPath;
  env.FOREMAN_PET_FOREMAN_IPC = ipcPath;

  return { env, ipcPath, tag };
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve(child.exitCode != null || child.signalCode != null);
    };
    child.once('exit', finish);
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Kill only the process tree this helper owns. Windows uses taskkill /T (the
 * .cmd wrapper is never involved here), POSIX signals the detached process
 * group; the root PID is never matched or killed by name.
 */
export async function terminateOwnedTree(child, platform = process.platform) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (platform === 'win32') {
    if (Number.isInteger(child.pid) && child.pid > 0) {
      await new Promise((resolve) => {
        let settled = false;
        let timer;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        try {
          const killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', done);
          killer.once('close', done);
        } catch {
          done();
        }
        timer = setTimeout(done, TREE_KILL_TIMEOUT_MS);
        timer.unref?.();
      });
    }
    if (!await waitForExit(child, TREE_KILL_TIMEOUT_MS)) throw new Error(`probe child ${child.pid} did not exit`);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (!await waitForExit(child, TREE_KILL_TIMEOUT_MS)) throw new Error(`probe child ${child.pid} did not exit`);
}

/**
 * Spawn a hidden child with shell:false and capture bounded combined output.
 * Abort/`signal` terminates the owned tree before resolving.
 */
function runCaptured(options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnManaged(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        platform: options.platform,
        detached: (options.platform ?? process.platform) !== 'win32',
      });
    } catch (error) {
      resolve({ status: null, output: '', error: errorText(error), aborted: false });
      return;
    }

    let output = '';
    const append = (chunk) => {
      output = (output + String(chunk)).slice(-MAX_CAPTURE_CHARS);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let settled = false;
    let aborted = false;
    let spawnError;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.('abort', onAbort);
      resolve({ status, output, error: spawnError, aborted });
    };
    const onAbort = () => {
      aborted = true;
      void terminateOwnedTree(child, options.platform).then(
        () => finish(child.exitCode ?? null),
        (error) => { spawnError = errorText(error); finish(null); },
      );
    };

    child.on('error', (error) => {
      spawnError = errorText(error);
      finish(null);
    });
    child.on('close', (status) => { if (!aborted) finish(status); });

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Check production TypeScript without emitting or rewriting live artifacts.
 */
async function runDaemonBuild(options) {
  const result = await runCaptured({
    command: options.nodeExecutable,
    args: [join(options.checkout, 'apps/daemon/node_modules/typescript/bin/tsc'), '-p',
      join(options.checkout, 'apps/daemon/tsconfig.startup.json')],
    cwd: options.checkout,
    env: options.env,
    platform: options.platform,
    signal: options.signal,
  });
  if (result.aborted) return { ok: false, error: 'daemon build aborted', logs: result.output, aborted: true };
  if (result.error) return { ok: false, error: `daemon build could not start: ${result.error}`, logs: result.output };
  if (result.status !== 0) {
    return { ok: false, error: `daemon build failed (exit ${result.status}):\n${tail(result.output)}`, logs: result.output };
  }
  return { ok: true, logs: result.output };
}

/** Start the probe entry in a brand-new, fully isolated child. */
async function runDaemonProbe(options) {
  const entry = join(options.checkout, 'tools', 'dev', 'check-daemon.mts');
  if (!existsSync(entry)) {
    return { ok: false, error: `daemon probe entry is missing: ${entry}`, logs: '' };
  }
  let invocation;
  try {
    invocation = tsxLoaderInvocation(
      options.checkout,
      entry,
      ['--source-config', options.configPath, '--probe-root', options.probeRoot],
      options.nodeExecutable,
      existsSync,
    );
  } catch (error) {
    return { ok: false, error: errorText(error), logs: '' };
  }
  const result = await runCaptured({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd ?? options.checkout,
    env: options.env,
    platform: options.platform,
    signal: options.signal,
  });
  if (result.aborted) return { ok: false, error: 'daemon probe aborted', logs: result.output, aborted: true };
  if (result.error) return { ok: false, error: `daemon probe could not start: ${result.error}`, logs: result.output };
  const markerSeen = result.output.split(/\r?\n/u).includes(PREFLIGHT_OK_MARKER);
  if (result.status !== 0 || !markerSeen) {
    return {
      ok: false,
      error: `isolated daemon probe failed (exit ${result.status ?? 'signal'}${markerSeen ? '' : ', no success marker'}):\n${tail(result.output)}`,
      logs: result.output,
    };
  }
  return { ok: true, logs: result.output };
}

function removeProbeRoot(root) {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('wrenyard-preflight-')) {
    throw new Error(`refusing to remove unexpected probe root: ${target}`);
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function createProbeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-preflight-'));
  const dirs = [
    'state',
    'config',
    'desktop',
    'codex',
    'run',
    'home',
    'workspace',
    join('appdata', 'roaming'),
    join('appdata', 'local'),
    join('xdg', 'config'),
    join('xdg', 'state'),
    join('xdg', 'data'),
    join('xdg', 'cache'),
  ];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/**
 * Validate the next daemon before any live component is touched: first the
 * daemon's existing build contract, then a fresh isolated child that starts the
 * real daemon against a scratch config and proves HTTP + IPC health.
 *
 * @param {object} options
 * @param {string} options.checkout
 * @param {string} options.configPath Source config, read read-only by the probe.
 * @param {string} [options.nodeExecutable]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] Overall bound (default 90s).
 * @returns {Promise<{ ok: boolean, error?: string, logs?: string[] }>}
 */
export async function checkDaemonStartup(options = {}) {
  const checkout = options.checkout;
  if (!checkout) return { ok: false, error: 'checkDaemonStartup requires options.checkout' };

  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logs = [];

  const controller = new AbortController();
  let timedOut = false;
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) return { ok: false, error: 'daemon preflight aborted before start', logs };
    external.addEventListener?.('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const abortReason = () => (timedOut
    ? `daemon preflight timed out after ${timeoutMs}ms`
    : 'daemon preflight aborted');

  let root;
  try {
    const build = await runDaemonBuild({ checkout, nodeExecutable, env: baseEnv, platform, signal: controller.signal });
    if (build.logs) logs.push(build.logs);
    if (!build.ok) return { ok: false, error: build.aborted ? abortReason() : build.error, logs };

    root = createProbeRoot();
    const { env } = buildPreflightEnv({ baseEnv, root, platform });
    const probe = await runDaemonProbe({
      checkout,
      configPath: options.configPath,
      probeRoot: root,
      nodeExecutable,
      env,
      platform,
      signal: controller.signal,
    });
    if (probe.logs) logs.push(probe.logs);
    if (!probe.ok) return { ok: false, error: probe.aborted ? abortReason() : probe.error, logs };

    return { ok: true, logs, probeRoot: root };
  } catch (error) {
    return { ok: false, error: errorText(error), logs };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener?.('abort', onExternalAbort);
    if (root) removeProbeRoot(root);
  }
}
