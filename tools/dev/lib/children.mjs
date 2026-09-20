import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { GRACEFUL_STOP_MS } from './constants.mjs';
import { daemonInvocation, electronDesktopInvocation, spawnManaged } from './spawn.mjs';
import { sourceChildEnv } from './env.mjs';

function attachLogs(child, logPath) {
  if (!logPath) return;
  try {
    const stream = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on('close', () => stream.end());
  } catch {
    // Logging must not prevent spawning.
  }
}

export function spawnDaemonProcess(options) {
  const invocation = daemonInvocation(
    options.checkout,
    options.configPath,
    options.extraArgs ?? [],
    options.nodeExecutable,
    options.exists,
  );
  const env = sourceChildEnv(options.env ?? process.env, options.resolved);
  const child = spawnManaged(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    platform: options.platform,
  });
  attachLogs(child, options.logPath);
  return child;
}

export function spawnDesktopProcess(options) {
  const platform = options.platform ?? process.platform;
  const invocation = electronDesktopInvocation(
    options.checkout,
    options.nodeExecutable,
    options.exists,
    platform,
  );
  const env = sourceChildEnv(options.env ?? process.env, options.resolved);
  // An inherited ELECTRON_RUN_AS_NODE would make the real Electron binary run
  // as plain Node, so the Desktop main process would never start.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnManaged(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    platform,
  });
  attachLogs(child, options.logPath);
  return child;
}

/** A signal exit is just as final as a numeric exit code. */
export function childHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

export function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    if (childHasExited(child)) finish(true);
  });
}

function exitResult(child, forced = false) {
  return { ok: true, code: child?.exitCode ?? null, signal: child?.signalCode ?? null, forced };
}

export async function stopChild(child, options = {}) {
  if (childHasExited(child)) return exitResult(child);
  const timeoutMs = options.timeoutMs ?? GRACEFUL_STOP_MS;
  const firstExit = waitForChildExit(child, timeoutMs);
  let signalError;
  try { child.kill(options.signal ?? 'SIGTERM'); } catch (error) { signalError = error; }
  if (await firstExit) return exitResult(child);
  if (signalError) return { ok: false, forced: false, error: String(signalError) };
  const finalExit = waitForChildExit(child, Math.min(timeoutMs, 1_000));
  try { child.kill('SIGKILL'); } catch (error) { signalError = error; }
  if (await finalExit) return exitResult(child, true);
  return { ok: false, code: child.exitCode, forced: true, error: signalError ? String(signalError) : `Process ${child.pid} did not exit` };
}

/** Root-process stop for POSIX or non-Desktop children; not a Windows tree killer. */
export async function stopOwnedTree(child, options = {}) {
  const result = await stopChild(child, options);
  if (result.ok && options.postExit) await options.postExit(child);
  return result;
}

/** Wait for graceful Desktop quit, then use a platform-specific owned-process fallback. */
export async function stopOwnedDesktopTree(child, options = {}) {
  if (childHasExited(child)) return exitResult(child);
  const timeoutMs = options.timeoutMs ?? GRACEFUL_STOP_MS;
  if (options.afterGraceful === true && await waitForChildExit(child, timeoutMs)) return exitResult(child);
  if ((options.platform ?? process.platform) !== 'win32') return stopOwnedTree(child, options);
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0 || typeof options.run !== 'function') {
    return { ok: false, forced: false, error: 'Cannot terminate owned Desktop tree: missing PID or Windows process runner' };
  }
  // Register before termination, and never signal the root separately on Windows.
  const exit = waitForChildExit(child, timeoutMs);
  let result;
  try {
    result = await options.run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs });
  } catch (error) {
    result = { status: -1, error: String(error) };
  }
  const exited = await exit;
  if (exited && (result?.status === 0 || result?.status === 128)) return exitResult(child, true);
  return {
    ok: false, forced: true,
    error: `Desktop tree ${pid} was not confirmed cleanly stopped (taskkill exit ${result?.status ?? 'unknown'}, process exited: ${exited})`,
  };
}

export function componentLogPath(logDirectory, name) {
  return join(logDirectory, `${name}.log`);
}
