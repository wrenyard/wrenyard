import { spawn } from 'node:child_process';
import { connectControl, ERRORS, isAddrInUse, listenControl } from './control.mjs';
import { processAlive, readInstanceFile } from './identity.mjs';
import { sameCheckout, stateRoot, controlEndpoint, instancePath } from './paths.mjs';
import { spawnArgv } from './spawn.mjs';

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  /**
   * Reserved worker exit code: the worker stopped its owned stack because dev
   * tooling changed and wants the launcher to start a *fresh* process so the
   * new modules are loaded. Never used for an error.
   */
  reload: 75,
});

export const WORKER_IPC = Object.freeze({
  stop: 'dev:stop',
  stopFailed: 'dev:stop-failed',
  stopped: 'dev:stopped',
});

export const LAUNCH_DEFAULTS = Object.freeze({
  /** The old supervisor answers `replace` when its children are down; this is a ceiling, not a target. */
  replaceAckMs: 180_000,
  /** Wait for the old supervisor process to actually exit before competing for the endpoint. */
  exitWaitMs: 180_000,
  /** A merely slow exit still frees the control endpoint, so keep polling for a while after it. */
  releaseWaitMs: 60_000,
  releasePollMs: 200,
  /** A replace request that was never accepted must not own the stack forever. */
  stallMs: 90_000,
});

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(childExited(child)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Claim the control endpoint for a brand-new start.
 * @returns {Promise<{ peer: object | null, probeError: unknown | null } | null>} null when the endpoint is free.
 */
export async function probeControlEndpoint(endpoint, options = {}) {
  const platform = options.platform ?? process.platform;
  // Windows permits multiple servers for one pipe name; binding cannot prove
  // that the existing supervisor is gone. Probe its control channel directly.
  if (platform === 'win32') {
    let client;
    try {
      client = await connectControl(endpoint);
      return { peer: await client.request('status', {}, 2_000), probeError: null };
    } catch (probeError) {
      if (probeError?.code === 'ENOENT' || probeError?.code === 'ECONNREFUSED') return null;
      return { peer: null, probeError };
    } finally {
      client?.close();
    }
  }
  try {
    const server = await listenControl(endpoint, { platform, retryStale: platform !== 'win32' });
    await closeServer(server);
    return null;
  } catch (error) {
    if (!isAddrInUse(error)) throw error;
    try {
      const client = await connectControl(endpoint);
      try {
        return { peer: await client.request('status', {}), probeError: null };
      } finally {
        client.close();
      }
    } catch (probeError) {
      return { peer: null, probeError };
    }
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Replace a supervisor that already owns this checkout.
 *
 * All coordination goes through the control endpoint. The old supervisor stops
 * the children it owns and releases the endpoint; only then does the launcher
 * compete for it. Nothing is ever matched or killed by process name.
 *
 * @returns {Promise<{ replaced: boolean, peer: object | null }>}
 */
export async function replaceExistingSupervisor(input) {
  const checkout = input.checkout;
  const endpoint = input.controlEndpoint;
  const sleep = input.sleep ?? sleepDefault;
  const defaults = { ...LAUNCH_DEFAULTS, ...input.timeouts };
  const probe = input.probeConflict ?? (() => probeControlEndpoint(endpoint));
  const control = input.control ?? ((method, params, timeoutMs) => requestOnce(endpoint, method, params, timeoutMs));

  const conflicted = await probe();
  if (!conflicted) return { replaced: false, peer: null };

  const { peer, probeError } = conflicted;
  if (!peer) {
    const previous = readInstanceFile(input.instanceFile, input.readFile);
    if (previous && sameCheckout(previous.checkout, checkout, input.platform) && processAlive(previous.supervisorPid, input.kill)) {
      throw new Error(`Cannot confirm the previous source-development supervisor (pid ${previous.supervisorPid}). Control endpoint ${endpoint} is unreachable: ${probeError instanceof Error ? probeError.message : String(probeError)}`);
    }
    return { replaced: false, peer: null };
  }

  if (!sameCheckout(peer.checkout, checkout, input.platform)) {
    throw new Error(`A source-development instance already owns this user-data domain from ${peer.checkout ?? 'another checkout'}. Stop that checkout's pnpm dev first (Ctrl+C in its terminal).`);
  }

  input.stdout?.(`Replacing the running source-development stack for this checkout (supervisor pid ${peer?.pids?.supervisor ?? 'unknown'}). The latest supervisor and tooling are loaded; in-flight tasks and conversations may be interrupted.`);

  let accepted = false;
  let stallTimer = null;
  let clearStall = () => {};
  const stall = new Promise((_, reject) => {
    stallTimer = setTimeout(() => reject(new Error(
      `The previous source-development supervisor did not accept the replacement within ${defaults.stallMs}ms. Its processes were not killed by name; run pnpm dev again to retry.`,
    )), defaults.stallMs);
    stallTimer.unref?.();
    clearStall = () => clearTimeout(stallTimer);
  });

  try {
    let answer;
    try {
      answer = await Promise.race([
        control('replace', {}, defaults.replaceAckMs),
        stall,
      ]);
    } catch (error) {
      // An older supervisor may predate the `replace` method. Falling back to
      // its `stop` RPC still tears down the owned stack the same way.
      if (isMethodNotFound(error)) {
        input.stdout?.('The previous supervisor does not support replacement; asking it to stop instead.');
        answer = await Promise.race([control('stop', {}, defaults.replaceAckMs), stall]);
      } else {
        throw error;
      }
    }
    accepted = true;
    input.controlChildPid = answer?.supervisorPid ?? input.controlChildPid;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A dropped connection mid-stop is still a legitimate stop *only* when the
    // socket closed because the peer acted on the request. A request that merely
    // timed out is ambiguous and must not be reported as accepted.
    if (/closed|ENOENT|ECONNREFUSED|ECONNRESET/iu.test(message)) {
      accepted = true;
      input.stdout?.('The previous supervisor dropped the control connection while stopping; waiting for it to exit.');
    } else {
      throw error;
    }
  } finally {
    clearStall();
  }

  if (!accepted) return { replaced: false, peer };

  input.stdout?.('Waiting for the previous supervisor to exit and release the control endpoint.');

  // The `replace` result is not proof of release: the endpoint is only free once
  // the old process is gone. Wait for the recorded pid, then keep polling the
  // endpoint so a merely slow exit cannot turn into a lost socket race.
  const previousPid = input.controlChildPid ?? peer?.pids?.supervisor ?? readInstanceFile(input.instanceFile, input.readFile)?.supervisorPid;
  const exitDeadline = Date.now() + defaults.exitWaitMs;
  while (Date.now() < exitDeadline) {
    if (previousPid && !processAlive(previousPid, input.kill)) break;
    if (input.controlChild && childExited(input.controlChild)) break;
    await sleep(defaults.releasePollMs);
  }

  const deadline = Date.now() + defaults.releaseWaitMs;
  for (;;) {
    const now = await probe();
    if (!now) return { replaced: true, peer };
    if (Date.now() >= deadline) {
      throw new Error(`The previous source-development supervisor did not release the control endpoint within ${defaults.releaseWaitMs}ms. Its processes were not killed by name; run pnpm dev again to retry.`);
    }
    await sleep(defaults.releasePollMs);
  }
}

/** A JSON-RPC "unknown method" answer: the peer is old, not broken. */
function isMethodNotFound(error) {
  return error?.code === ERRORS.method;
}

/**
 * Spawn the worker process that loads the supervisor modules and run it as the
 * foreground child of this launcher.
 *
 * `ipc` is always enabled: the launcher asks the worker to stop over the
 * channel instead of signalling the process tree, which is unreliable on
 * Windows (a console-less child cannot receive SIGINT).
 */
export function runWorker(options) {
  const resolved = spawnArgv(options.nodeExecutable, [options.workerEntry, ...(options.args ?? [])], options.platform, options.env);
  return spawn(resolved.command, resolved.args, {
    cwd: options.checkout,
    env: options.env,
    stdio: options.stdio ?? ['inherit', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    shell: false,
  });
}

/** Ask the worker to stop its owned stack over IPC; resolve when it acknowledges. */
function requestWorkerStop(worker, timeoutMs) {
  if (!worker?.connected || typeof worker.send !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off?.('message', onMessage);
      resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === WORKER_IPC.stopped || message?.type === WORKER_IPC.stopFailed) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    worker.on('message', onMessage);
    try {
      worker.send({ type: WORKER_IPC.stop });
    } catch {
      finish(false);
    }
  });
}

/**
 * Full launcher sequence: replace an existing owned stack, then start the
 * worker and mirror its exit. Ctrl+C is delegated to the worker over IPC so the
 * supervisor performs the orderly stop instead of the launcher killing it.
 *
 * A worker that exits with the reserved reload code is *replaced* by a fresh
 * `run.mjs` child, so an edit to the dev tooling loads current modules instead
 * of reusing the ones already in memory. The original `run.mjs` is the entry
 * point, so its transitive imports are refreshed too.
 */
export async function runLauncher(options) {
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const replacement = await replaceExistingSupervisor({
    ...options,
    controlEndpoint: options.controlEndpoint ?? controlEndpoint(options.platform ?? process.platform, stateRoot(options.env ?? process.env)),
    instanceFile: options.instanceFile ?? instancePath(stateRoot(options.env ?? process.env)),
    stdout,
  });
  if (options.replaceOnly === true) return { exitCode: EXIT.ok, replaced: replacement.replaced };

  const entry = options.workerEntry;
  const spawnWorker = (entryPoint) => (options.spawnWorker
    ? options.spawnWorker(entryPoint)
    : runWorker({
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      workerEntry: entryPoint,
      args: options.args,
      checkout: options.checkout,
      env: options.env ?? process.env,
      platform: options.platform,
    }));

  let worker = spawnWorker(entry);
  let stopping = false;
  let spawnedReplacement = false;
  let replacedOnce = replacement.replaced;
  let exitCode = EXIT.ok;

  // Workers must not write directly to a terminal whose shell may have
  // already regained control after Windows broadcasts Ctrl+C to pnpm.
  // Continue draining their pipes during teardown, but keep the prompt clean.
  function forwardOutput(child) {
    child.stdout?.on('data', (chunk) => {
      if (!stopping) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (!stopping) process.stderr.write(chunk);
    });
  }
  forwardOutput(worker);

  const onInterrupt = () => {
    if (stopping) return;
    stopping = true;
    void delegateStop();
  };
  const onTerminate = onInterrupt;
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const onParentMessage = (message) => {
    if (message?.type === WORKER_IPC.stop) onInterrupt();
  };
  process.on('message', onParentMessage);

  /** Ask the running worker to stop; a worker that cannot take IPC is signalled. */
  async function delegateStop() {
    if (!worker) return;
    const usedIpc = await requestWorkerStop(worker, options.stopAckMs ?? 60_000);
    if (usedIpc) return;
    if (childExited(worker)) return;
    try {
      // Last resort for a worker that never attached IPC (e.g. a hand-spawned
      // one). This is a signal to the exact owned child, never a name match.
      worker.kill('SIGTERM');
    } catch {
      // The worker may already be gone.
    }
  }

  try {
    for (;;) {
      const result = await waitForWorkerExit(worker, (line) => {
        if (!stopping) stderr(line);
      });
      if (stopping) {
        // A stop was delegated and the worker owns the teardown. A reload code
        // here is a stale intent racing the stop, not a request to restart: the
        // launcher must not resurrect a replacement stack after a stop.
        exitCode = EXIT.ok;
        break;
      }
      exitCode = result.exitCode;
      if (result.code !== EXIT.reload) break;
      stdout('Dev tooling changed; starting a fresh source-development worker.');
      replacedOnce = true;
      spawnedReplacement = true;
      worker = spawnWorker(options.launcherEntry ?? entry);
      forwardOutput(worker);
    }
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('message', onParentMessage);
  }

  return { exitCode, replaced: replacedOnce || spawnedReplacement };
}

function waitForWorkerExit(worker, stderr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    // close follows exit and completion of the child's output streams.
    worker.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code == null && signal) {
        stderr(`The source-development worker was terminated by ${signal}.`);
        resolve({ exitCode: EXIT.failed, code: null, signal });
        return;
      }
      resolve({ exitCode: code ?? EXIT.ok, code, signal: null });
    });
  });
}

async function requestOnce(endpoint, method, params, timeoutMs) {
  const client = await connectControl(endpoint);
  try {
    return await client.request(method, params, timeoutMs);
  } finally {
    client.close();
  }
}

export { waitForChildExit };
