import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { GRACEFUL_STOP_MS } from './constants.mjs';
import { daemonInvocation, electronInvocation, spawnManaged } from './spawn.mjs';
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
  const invocation = electronInvocation(options.checkout, options.nodeExecutable, options.exists);
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

export function stopChild(child, options = {}) {
  const timeoutMs = options.timeoutMs ?? GRACEFUL_STOP_MS;
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve({ code: child?.exitCode ?? 0, forced: false });
      return;
    }
    let settled = false;
    const finish = (forced) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: child.exitCode, forced });
    };
    child.once('exit', () => finish(false));
    try {
      child.kill(options.signal ?? 'SIGTERM');
    } catch {
      finish(true);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process may already be gone.
      }
      finish(true);
    }, timeoutMs);
  });
}

export function componentLogPath(logDirectory, name) {
  return join(logDirectory, `${name}.log`);
}
