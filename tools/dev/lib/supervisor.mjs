import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  COMPONENT_RETRY_BACKOFF_MS,
  COMPONENT_RETRY_LIMIT,
  COMPONENT_RETRY_STABLE_MS,
  DESKTOP_KILL_WAIT_MS,
  DRAIN_TIMEOUT_MS,
  HEALTH_WAIT_MS,
} from './constants.mjs';
import { DISPATCH_THAW_HINT, dispatchBlocksNewWork, dispatchIsAccepting, shouldAutoThaw } from './admission.mjs';
import { combineActivity, identityMatchesSource } from './activity.mjs';
import { buildGeneration } from './builder.mjs';
import { spawnDaemonProcess, spawnDesktopProcess, stopChild, stopOwnedDesktopTree, componentLogPath, childHasExited } from './children.mjs';
import { attachHandler, connectControl, isAddrInUse, listenControl } from './control.mjs';
import { sourceChildEnv } from './env.mjs';
import { COMPONENTS, expandDependents, isRendererOnly } from './graph.mjs';
import { createInstanceRecord, formatGitRevision, newInstanceId, newLaunchId, processAlive, readGitRevision, startIdentity } from './identity.mjs';
import { readInstanceFile, writeInstanceFile } from './instance.mjs';
import { createLogger } from './log.mjs';
import {
  businessIpcPath,
  configDir,
  controlEndpoint as resolveControlEndpoint,
  defaultRuntimeBin,
  desktopUserData,
  instancePath as resolveInstancePath,
  logDir as resolveLogDir,
  sameCheckout,
  stateRoot,
  normalizeCheckout,
} from './paths.mjs';
import { checkBuildArtifacts, checkToolchain } from './prepare.mjs';
import { ERRORS } from './protocol.mjs';
import {
  createInspectReleaseDesktop,
  createTerminateReleaseDesktop,
  gateReleaseDesktop,
  runExecFile,
} from './release-desktop.mjs';
import { createGenerationQueue } from './queue.mjs';
import { createRequestQueue } from './requests.mjs';
import { sourceIdentityFromHealth, withDaemon } from './rpc.mjs';
import { sourceCliInvocation } from './spawn.mjs';
import { createWatcher } from './watcher.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(code, message) {
  return Object.assign(new Error(message), { code, ok: false, message });
}

const TRANSIENT_STATUSES = new Set([
  'preparing',
  'starting',
  'waiting-for-idle',
  'restarting',
  'stopping',
]);

/**
 * Status measured from the live components, ignoring transient operation status.
 * @param {{ daemon: unknown, desktop: unknown, desktopStoppedByUser: boolean }} components
 */
export function healthyComponentStatus(components) {
  const alive = (child) => Boolean(child) && !childHasExited(child);
  if (!alive(components?.daemon)) return 'degraded';
  if (components.desktopStoppedByUser) return 'ready';
  if (!alive(components?.desktop)) return 'degraded';
  return 'ready';
}

/**
 * Pick the status to publish after a failed lifecycle operation. A snapshot that
 * is itself transient (or missing) is replaced by the live component truth, so a
 * blocked stop never leaves `stopping` / `waiting-for-idle` behind.
 * @param {string|null|undefined} snapshotStatus
 * @param {{ daemon: unknown, desktop: unknown, desktopStoppedByUser: boolean }} components
 */
export function restoredStatus(snapshotStatus, components) {
  const live = healthyComponentStatus(components);
  if (live === 'degraded') return 'degraded';
  if (!snapshotStatus || TRANSIENT_STATUSES.has(snapshotStatus)) {
    return live;
  }
  return snapshotStatus;
}

export function createSupervisor(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const checkout = normalizeCheckout(options.checkout, {
    platform,
    realpath: options.realpath ?? realpathSync,
    exists: options.exists,
  });
  const state = options.stateRoot ?? stateRoot(env, home);
  const controlEndpoint = options.controlEndpoint ?? resolveControlEndpoint(platform, state);
  const instanceFile = options.instanceFile ?? resolveInstancePath(state);
  const logs = options.logDir ?? resolveLogDir(state);
  const logger = options.logger ?? createLogger({ dir: logs, stdout: options.stdout });
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const userData = options.userData ?? desktopUserData(platform, env, home);
  const ipcPath = options.ipcPath ?? businessIpcPath(platform, env);
  const configPath = options.configPath ?? join(configDir(env, home), 'config.json');
  const git = readGitRevision({ checkout, git: options.git });
  const queue = createGenerationQueue();
  const requests = createRequestQueue();
  const exists = options.exists;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const spawnDaemon = options.spawnDaemon ?? spawnDaemonProcess;
  const spawnDesktop = options.spawnDesktop ?? spawnDesktopProcess;
  const stopChildFn = options.stopChild ?? stopChild;
  const retryStableMs = options.retryStableMs ?? COMPONENT_RETRY_STABLE_MS;
  const retryBackoffMs = options.retryBackoffMs ?? COMPONENT_RETRY_BACKOFF_MS;
  const makeLaunchId = options.newLaunchId ?? newLaunchId;
  const killDesktop = options.killDesktop === true;
  const inspectReleaseDesktop = options.inspectReleaseDesktop ?? createInspectReleaseDesktop({
    platform,
    env,
    home,
    checkout,
    currentPid: process.pid,
    run: options.runCommand,
  });
  const terminateReleaseDesktop = options.terminateReleaseDesktop ?? createTerminateReleaseDesktop({
    platform,
    env,
    run: options.runCommand,
  });

  let status = 'preparing';
  let instanceId = newInstanceId();
  let record = null;
  let server = null;
  let watcher = null;
  let daemon = null;
  let desktop = null;
  let daemonSlot = null;
  let desktopSlot = null;
  let daemonStart = null;
  let desktopStart = null;
  let desktopSession = null;
  let desktopStoppedByUser = false;
  let currentRuntimeBin = options.runtimeBin ?? defaultRuntimeBin(checkout, platform, exists);
  let stopping = false;
  let retries = { daemon: 0, desktop: 0 };
  let retryTimers = { daemon: null, desktop: null };
  let buildAbort = null;
  let buildLock = Promise.resolve();
  const usedRuntimeGens = new Set();
  const sessions = new Set();

  function withBuildLock(fn) {
    const run = buildLock.then(fn, fn);
    buildLock = run.then(() => undefined, () => undefined);
    return run;
  }

  function resolvedPaths(launchId) {
    const cli = sourceCliInvocation(checkout, [], nodeExecutable, exists);
    return {
      instanceId,
      launchId,
      checkout,
      cli: [cli.command, ...cli.args].join(' '),
      nodeBin: nodeExecutable,
      runtimeBin: currentRuntimeBin,
      desktopBin: [nodeExecutable, join(checkout, 'apps', 'desktop')].join(' '),
      controlEndpoint,
      userData,
      ipcPath,
    };
  }

  function persist(patch = {}) {
    record = {
      ...(record ?? createInstanceRecord({
        instanceId,
        checkout,
        platform,
        controlEndpoint,
        startIdentity: startIdentity(),
        paths: {
          config: configPath,
          state,
          userData,
          ipc: ipcPath,
          logs,
        },
        sources: {
          cli: 'apps/cli/src/index.ts',
          node: nodeExecutable,
          runtime: currentRuntimeBin,
          desktop: 'apps/desktop',
        },
      })),
      ...patch,
      instanceId,
      checkout,
      updatedAt: new Date().toISOString(),
      supervisorPid: process.pid,
      daemonPid: daemon?.pid ?? null,
      desktopPid: desktop?.pid ?? null,
      currentGeneration: queue.current?.id ?? record?.currentGeneration ?? null,
      pendingGeneration: queue.pending?.id ?? queue.building?.id ?? null,
      status,
    };
    writeInstanceFile(instanceFile, record);
    return record;
  }

  function setStatus(next, detail) {
    status = next;
    persist({ status: next });
    logger.info(next, detail ?? '');
    for (const session of sessions) {
      session.send?.({ jsonrpc: '2.0', method: 'dev.event', params: { status: next, detail } });
    }
  }

  /**
   * Status that truthfully reflects the live components, independent of any
   * transient operation status (stopping / waiting-for-idle / restarting).
   */
  function healthyStatus() {
    return healthyComponentStatus({ daemon, desktop, desktopStoppedByUser });
  }

  /**
   * Restore the pre-operation status after a failed lifecycle operation.
   * Falls back to the live component truth when the snapshot is itself a
   * transient operation status, so a failed stop never leaves the supervisor
   * stuck in `stopping` / `waiting-for-idle`.
   */
  function restoreStatusAfterFailure(snapshotStatus, detail) {
    setStatus(restoredStatus(snapshotStatus, { daemon, desktop, desktopStoppedByUser }), detail);
  }

  function snapshot() {
    return {
      status,
      mode: 'source-development',
      checkout,
      git: formatGitRevision(git),
      instanceId,
      pids: {
        supervisor: process.pid,
        daemon: daemon?.pid ?? null,
        desktop: desktop?.pid ?? null,
      },
      sources: {
        cli: 'apps/cli/src/index.ts',
        node: nodeExecutable,
        runtime: currentRuntimeBin,
        desktop: 'electron cli.js + apps/desktop',
      },
      paths: {
        config: configPath,
        state,
        userData,
        ipc: ipcPath,
        logs: logger.path,
      },
      generation: queue.current?.id ?? null,
      pendingGeneration: queue.pending?.id ?? queue.building?.id ?? null,
    };
  }

  function printReady(admission) {
    const snap = snapshot();
    const lines = [
      admission?.blocked ? 'ready (dispatch blocked)' : 'ready',
      `checkout: ${snap.checkout}`,
      `revision: ${snap.git}`,
      'mode: source-development',
      `supervisor pid: ${snap.pids.supervisor}`,
      `daemon pid: ${snap.pids.daemon ?? '—'}`,
      `daemon launchId: ${daemonSlot?.launchId ?? '—'}`,
      `desktop pid: ${snap.pids.desktop ?? '—'}`,
      `cli: source apps/cli/src/index.ts via tsx`,
      `node: ${snap.sources.node}`,
      `runtime: ${snap.sources.runtime ?? 'unresolved'}`,
      `config: ${snap.paths.config}`,
      `state: ${snap.paths.state}`,
      `userData: ${snap.paths.userData}`,
      `ipc: ${snap.paths.ipc}`,
      `logs: ${snap.paths.logs}`,
      `generation: ${snap.generation ?? 'initial'}`,
    ];
    if (admission?.blocked) lines.push(DISPATCH_THAW_HINT);
    options.stdout?.(lines.join('\n'));
  }

  async function withRpc(fn, timeoutMs) {
    if (typeof options.withDaemon === 'function') return options.withDaemon(fn, timeoutMs);
    return withDaemon(ipcPath, fn, timeoutMs);
  }

  async function pingDaemon() {
    return withRpc((client) => client.request('health.ping', {}), 1500);
  }

  function currentDesktopSession() {
    if (!desktopSession) return null;
    if (desktopSession.launchId && desktopSlot?.launchId && desktopSession.launchId !== desktopSlot.launchId) {
      return null;
    }
    return desktopSession;
  }

  function cancelRetry(kind) {
    if (retryTimers[kind]) {
      clearTimeout(retryTimers[kind]);
      retryTimers[kind] = null;
    }
  }

  function bindSlot(kind, child, launchId) {
    const slot = {
      kind,
      child,
      launchId,
      expectedExit: false,
      startInFlight: true,
      failureCounted: false,
      healthySince: null,
    };
    child.once('exit', (code, signal) => {
      onTrackedChildExit(slot, code, signal);
    });
    if (kind === 'daemon') {
      daemonSlot = slot;
      daemon = child;
    } else {
      desktopSlot = slot;
      desktop = child;
    }
    return slot;
  }

  function scheduleRetry(kind, slot, error) {
    if (stopping || requests.pendingStop) return;
    cancelRetry(kind);
    const survived = slot.healthySince != null && (now() - slot.healthySince) >= retryStableMs;
    if (survived) {
      retries[kind] = 0;
      logger.info('retry-reset', `${kind} launchId=${slot.launchId} stayed healthy for ${retryStableMs}ms; starting a new recovery budget`);
    }
    if (retries[kind] >= COMPONENT_RETRY_LIMIT) {
      const detail = `${kind} exceeded ${COMPONENT_RETRY_LIMIT} restarts (launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'})`;
      logger.error('retry-exhausted', `${detail}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`);
      setStatus('degraded', detail);
      return;
    }
    const attempt = retries[kind] + 1;
    retries[kind] = attempt;
    const delay = retryBackoffMs[Math.min(attempt - 1, retryBackoffMs.length - 1)];
    logger.warn('retry', `${kind} restart in ${delay}ms (attempt ${attempt}/${COMPONENT_RETRY_LIMIT}) launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'} planned=${slot.expectedExit}`);
    retryTimers[kind] = setTimeout(() => {
      retryTimers[kind] = null;
      if (stopping || requests.pendingStop) return;
      const current = kind === 'daemon' ? daemonSlot : desktopSlot;
      if (current?.child && !childHasExited(current.child) && !current.expectedExit) return;
      if (kind === 'daemon' && daemonStart) return;
      if (kind === 'desktop' && desktopStart) return;
      void withBuildLock(() => (kind === 'daemon' ? startDaemon() : startDesktop())).then(() => {
        if (daemon && (desktop || desktopStoppedByUser) && status !== 'stopping') {
          setStatus(status === 'degraded' ? 'ready' : status);
        }
      }).catch((retryError) => {
        logger.error('retry-failed', retryError instanceof Error ? retryError.message : String(retryError));
      });
    }, delay);
    retryTimers[kind]?.unref?.();
  }

  function onTrackedChildExit(slot, code, signal) {
    if (stopping) return;
    const current = slot.kind === 'daemon' ? daemonSlot : desktopSlot;
    if (current !== slot) {
      logger.info('stale-exit', `${slot.kind} launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'} ignored`);
      return;
    }
    if (slot.expectedExit) {
      logger.info('expected-exit', `${slot.kind} launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'} code=${code ?? 'none'} signal=${signal ?? 'none'}`);
      return;
    }
    if (slot.kind === 'desktop' && code === 0 && !signal) {
      desktopStoppedByUser = true;
      desktopSession = null;
      desktopSlot = null;
      desktop = null;
      persist({ desktopPid: null });
      logger.info('desktop-stopped', `Desktop exited cleanly (pid was ${slot.child?.pid ?? 'unknown'} launchId=${slot.launchId}). Supervisor and daemon stay running. Use pnpm dev:restart to restore the window.`);
      return;
    }
    setStatus('degraded', `${slot.kind} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}) launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'}`);
    if (slot.startInFlight || slot.failureCounted) return;
    slot.failureCounted = true;
    scheduleRetry(slot.kind, slot);
  }

  async function waitForSourceDaemon(slot, timeoutMs = HEALTH_WAIT_MS) {
    const child = slot.child;
    const launchId = slot.launchId;
    let lastError = childHasExited(child)
      ? `daemon exited before becoming healthy (launchId ${launchId}, code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'})`
      : 'daemon did not become healthy';
    let exited = childHasExited(child);
    const onExit = (code, signal) => {
      exited = true;
      lastError = `daemon exited before becoming healthy (launchId ${launchId}, code ${code ?? 'none'}, signal ${signal ?? 'none'})`;
    };
    child.once('exit', onExit);
    const deadline = now() + timeoutMs;
    try {
      while (now() < deadline && !exited && !childHasExited(child)) {
        try {
          const health = await pingDaemon();
          if (exited || childHasExited(child)) break;
          if (health?.ok !== true) {
            lastError = 'health.ping did not return ok';
          } else if (!identityMatchesSource(health, { instanceId, launchId })) {
            const identity = sourceIdentityFromHealth(health);
            lastError = `daemon identity is ${identity.mode ?? 'unknown'} launchId=${identity.launchId ?? 'none'}, not launch ${launchId}`;
          } else {
            const identity = sourceIdentityFromHealth(health);
            if (identity.checkout && !sameCheckout(identity.checkout, checkout, platform)) {
              lastError = `daemon checkout ${identity.checkout} does not match ${checkout}`;
            } else {
              return health;
            }
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await wait(250);
      }
      throw fail(ERRORS.internal, lastError);
    } finally {
      child.removeListener('exit', onExit);
    }
  }

  async function waitForIpcDown(timeoutMs = HEALTH_WAIT_MS) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      try {
        await pingDaemon();
      } catch {
        return;
      }
      await wait(200);
    }
    throw fail(ERRORS.internal, `business IPC still reachable at ${ipcPath}`);
  }

  async function readDesktopActivity() {
    if (!desktop || childHasExited(desktop)) return { known: true, busy: false, running: false };
    const session = currentDesktopSession();
    if (!session) return { known: false, busy: true };
    try {
      const activity = await session.request('desktop.activity', {});
      return { known: true, ...activity };
    } catch {
      return { known: false, busy: true };
    }
  }

  async function captureDesktopUi() {
    const session = currentDesktopSession();
    if (!session) return null;
    try {
      return await session.request('desktop.snapshotUi', {});
    } catch {
      return null;
    }
  }

  async function restoreDesktopUi(ui) {
    const session = currentDesktopSession();
    if (!session || !ui) return;
    try {
      await session.request('desktop.restoreUi', ui);
    } catch {
      // Restoration is best-effort UI state only.
    }
  }

  async function reloadDesktopRenderer() {
    const session = currentDesktopSession();
    if (!session) return;
    await session.request('desktop.reload', {});
  }

  async function quitDesktop() {
    cancelRetry('desktop');
    const slot = desktopSlot;
    if (!slot?.child) return;
    slot.expectedExit = true;
    let graceful = false;
    const session = currentDesktopSession();
    if (session) {
      try {
        await session.request('desktop.quit', {});
        graceful = true;
      } catch {
        // Not a graceful success: fall through to owned-tree termination.
      }
    }
    const stopped = await stopOwnedDesktopTree(slot.child, {
      platform,
      run: options.runCommand ?? runExecFile,
      timeoutMs: options.desktopStopMs,
      afterGraceful: graceful,
    });
    if (!stopped.ok) {
      slot.expectedExit = false;
      logger.error('desktop-stop-failed', stopped.error ?? 'Desktop did not exit cleanly');
      throw fail(ERRORS.internal, stopped.error ?? `Desktop pid ${slot.child.pid ?? 'unknown'} did not exit`);
    }
    if (desktopSlot === slot) {
      desktopSlot = null;
      desktop = null;
      if (desktopSession?.launchId === slot.launchId) desktopSession = null;
    }
  }

  async function freezeAndDrain(timeoutMs = DRAIN_TIMEOUT_MS, drainOptions = {}) {
    let originalMode = 'accepting';
    let froze = false;
    const token = () => ({ froze, originalMode });
    setStatus('waiting-for-idle');
    try {
      await withRpc(async (client) => {
        const health = await client.request('health.ping', {});
        const dispatch = health?.dispatch;
        originalMode = dispatch?.mode;
        if (dispatch?.recovery_required === true || originalMode === 'planned_restart') {
          throw fail(ERRORS.busy, `cannot drain: ${dispatchBlocksNewWork(health).reason}`);
        }
        if (originalMode !== 'accepting' && originalMode !== 'frozen') {
          throw fail(ERRORS.internal, `cannot confirm dispatch admission (${originalMode ?? 'unknown'})`);
        }
        if (originalMode === 'accepting') {
          await client.request('daemon.freeze', {});
          froze = true;
        }
        try {
          const drain = await client.request('daemon.drain', { timeout_ms: timeoutMs }, timeoutMs + 5_000);
          if (!drain?.drained) {
            if (froze) {
              await client.request('daemon.thaw', {});
              froze = false;
            }
            throw Object.assign(fail(ERRORS.busy, `still busy after ${timeoutMs}ms`), {
              blocking: {
                tasks: drain?.activeTasks ?? [],
                workflows: drain?.activeWorkflows ?? [],
                executions: drain?.activeExecutions ?? [],
              },
              admissionToken: token(),
            });
          }
        } catch (error) {
          if (error.code === ERRORS.busy) throw error;
          if (froze) {
            try {
              await client.request('daemon.thaw', {});
              froze = false;
            } catch (thawError) {
              throw Object.assign(fail(
                ERRORS.internal,
                `cannot confirm daemon activity: ${error instanceof Error ? error.message : String(error)}; dispatch admission was not restored (${thawError instanceof Error ? thawError.message : String(thawError)}). ${DISPATCH_THAW_HINT}`,
              ), { admissionToken: { froze: true, originalMode: 'accepting' } });
            }
          }
          throw error;
        }
      }, 2000);
    } catch (error) {
      error.admissionToken = error.admissionToken ?? token();
      if (error.code === ERRORS.busy || error.code === ERRORS.internal) throw error;
      throw Object.assign(fail(ERRORS.internal, `cannot confirm daemon activity: ${error instanceof Error ? error.message : String(error)}`), {
        admissionToken: token(),
      });
    }
    if (drainOptions.ignoreDesktop !== true) {
      const desktopActivity = await readDesktopActivity();
      if (desktopActivity.known === false || desktopActivity.busy) {
        if (froze && originalMode === 'accepting') {
          const thawError = await restoreAdmissionSafe(token());
          if (thawError) {
            throw fail(ERRORS.busy, `${desktopActivity.known === false ? 'cannot confirm Desktop activity; treating as busy' : 'Desktop still has an active conversation or tool call'}; ${thawError}`);
          }
        }
        throw Object.assign(fail(ERRORS.busy, desktopActivity.known === false
          ? 'cannot confirm Desktop activity; treating as busy'
          : 'Desktop still has an active conversation or tool call'), { admissionToken: token() });
      }
    }
    return token();
  }

  async function restoreAdmissionSafe(token) {
    if (!shouldAutoThaw(token)) return null;
    try {
      await withRpc((client) => client.request('daemon.thaw', {}), 2000);
      return null;
    } catch (error) {
      return `dispatch admission was not restored (${error instanceof Error ? error.message : String(error)}). ${DISPATCH_THAW_HINT}`;
    }
  }

  async function restoreAdmission(token) {
    const unrestored = await restoreAdmissionSafe(token);
    if (unrestored) {
      logger.error('admission-unrestored', unrestored);
      throw fail(ERRORS.internal, unrestored);
    }
  }

  async function finalizeAdmission(handover) {
    const token = handover?.token;
    if (shouldAutoThaw(token)) {
      try {
        await withRpc((client) => client.request('daemon.thaw', {}), 2000);
      } catch (error) {
        const message = `failed to restore dispatch admission: ${error instanceof Error ? error.message : String(error)}. ${DISPATCH_THAW_HINT}`;
        setStatus('degraded', message);
        throw fail(ERRORS.internal, message);
      }
      const health = await pingCurrentDaemon();
      if (!dispatchIsAccepting(health)) {
        const message = `daemon thaw did not restore accepting dispatch. ${DISPATCH_THAW_HINT}`;
        setStatus('degraded', message);
        throw fail(ERRORS.internal, message);
      }
      return { blocked: false, health };
    }
    let health;
    try {
      health = await pingCurrentDaemon();
    } catch (error) {
      throw fail(ERRORS.internal, `cannot confirm dispatch admission: ${error instanceof Error ? error.message : String(error)}`);
    }
    const block = dispatchBlocksNewWork(health);
    if (block.blocked) {
      if (health?.dispatch?.mode === 'planned_restart' || health?.dispatch?.recovery_required) {
        throw fail(ERRORS.busy, `${block.reason}. Source-development will not bypass an active planned restart.`);
      }
      logger.warn('dispatch-blocked', block.reason);
      options.stdout?.(DISPATCH_THAW_HINT);
      return { blocked: true, health };
    }
    return { blocked: false, health };
  }

  async function pingCurrentDaemon() {
    const health = await pingDaemon();
    if (daemonSlot && !identityMatchesSource(health, { instanceId, launchId: daemonSlot.launchId })) {
      throw fail(ERRORS.internal, `health.ping did not match this daemon launch (${daemonSlot.launchId})`);
    }
    return health;
  }

  async function stopDaemon() {
    cancelRetry('daemon');
    const slot = daemonSlot;
    if (slot) slot.expectedExit = true;
    try {
      await withRpc((client) => client.request('daemon.shutdown', { reason: 'source development supervisor' }), 2000);
    } catch {
      // Process stop below is the fallback.
    }
    if (slot?.child) {
      const stopped = await stopChildFn(slot.child);
      if (!stopped.ok) {
        slot.expectedExit = false;
        throw fail(ERRORS.internal, stopped.error ?? `Daemon pid ${slot.child.pid ?? 'unknown'} did not exit`);
      }
      if (daemonSlot === slot) {
        daemonSlot = null;
        daemon = null;
      }
    }
    await waitForIpcDown(options.ipcDownMs ?? 8_000);
  }

  async function startDaemon() {
    if (daemonStart) return daemonStart;
    daemonStart = startDaemonOnce().finally(() => {
      daemonStart = null;
    });
    return daemonStart;
  }

  async function startDaemonOnce() {
    cancelRetry('daemon');
    mkdirSync(logs, { recursive: true });
    const launchId = makeLaunchId();
    const child = spawnDaemon({
      checkout,
      configPath,
      nodeExecutable,
      exists,
      platform,
      env,
      resolved: resolvedPaths(launchId),
      logPath: componentLogPath(logs, 'daemon'),
    });
    const slot = bindSlot('daemon', child, launchId);
    persist();
    logger.info('daemon-spawn', `launchId=${launchId} pid=${child.pid ?? 'unknown'}`);
    try {
      const health = await waitForSourceDaemon(slot, options.healthWaitMs ?? HEALTH_WAIT_MS);
      slot.startInFlight = false;
      slot.healthySince = now();
      return health;
    } catch (error) {
      slot.startInFlight = false;
      if (!slot.expectedExit && daemonSlot === slot && !slot.failureCounted) {
        slot.failureCounted = true;
        if (!childHasExited(child)) {
          slot.expectedExit = true;
          try { await stopChildFn(child); } catch { /* owned child cleanup */ }
          if (daemonSlot === slot) {
            daemonSlot = null;
            daemon = null;
          }
        }
        scheduleRetry('daemon', slot, error);
      }
      throw error;
    }
  }

  async function startDesktop() {
    if (desktopStart) return desktopStart;
    desktopStart = startDesktopOnce().finally(() => {
      desktopStart = null;
    });
    return desktopStart;
  }

  async function startDesktopOnce() {
    cancelRetry('desktop');
    desktopStoppedByUser = false;
    mkdirSync(logs, { recursive: true });
    const launchId = makeLaunchId();
    const child = spawnDesktop({
      checkout,
      nodeExecutable,
      exists,
      platform,
      env,
      resolved: resolvedPaths(launchId),
      logPath: componentLogPath(logs, 'desktop'),
    });
    const slot = bindSlot('desktop', child, launchId);
    persist();
    logger.info('desktop-spawn', `launchId=${launchId} pid=${child.pid ?? 'unknown'}`);
    const deadline = now() + (options.desktopReadyMs ?? 45_000);
    try {
      while (now() < deadline) {
        if (currentDesktopSession()?.launchId === launchId) {
          slot.startInFlight = false;
          slot.healthySince = now();
          return;
        }
        if (childHasExited(child) || desktopSlot !== slot) {
          throw fail(ERRORS.internal, `Desktop exited before registering with the supervisor (launchId ${launchId}, code ${child.exitCode ?? 'unknown'})`);
        }
        await wait(200);
      }
      throw fail(ERRORS.internal, `Desktop did not register with the supervisor (launchId ${launchId})`);
    } catch (error) {
      slot.startInFlight = false;
      if (!slot.expectedExit && desktopSlot === slot && !slot.failureCounted) {
        slot.failureCounted = true;
        if (!childHasExited(child)) {
          slot.expectedExit = true;
          try { await stopChildFn(child); } catch { /* owned child cleanup */ }
          if (desktopSlot === slot) {
            desktopSlot = null;
            desktop = null;
          }
        }
        scheduleRetry('desktop', slot, error);
      }
      throw error;
    }
  }

  async function ensureReleaseDesktopCleared() {
    const gate = await gateReleaseDesktop({
      killDesktop,
      inspect: inspectReleaseDesktop,
      terminate: terminateReleaseDesktop,
      stdout: (line) => {
        logger.info('release-desktop', line);
        options.stdout?.(line);
      },
      sleep: options.sleep,
      now: options.now,
      timeoutMs: options.desktopKillWaitMs ?? DESKTOP_KILL_WAIT_MS,
    });
    if (gate.action !== 'continue') {
      throw fail(ERRORS.desktopRunning, gate.message);
    }
  }

  async function handoverInstalled() {
    let health;
    try {
      health = await pingDaemon();
    } catch {
      return { switched: false, token: null };
    }
    const identity = sourceIdentityFromHealth(health);
    if (identity.mode === 'source') {
      if (identity.instanceId === instanceId) return { switched: false, self: true, token: null };
      throw fail(ERRORS.wrongCheckout, `A source-development instance is already running for ${identity.checkout ?? 'another checkout'}`);
    }
    const block = dispatchBlocksNewWork(health);
    if (health?.dispatch?.mode === 'planned_restart' || health?.dispatch?.recovery_required) {
      throw fail(ERRORS.busy, `cannot take over installed Wrenyard: ${block.reason}`);
    }
    logger.info('switching', 'Installed Wrenyard is running; switching to the source environment');
    let token;
    try {
      token = await freezeAndDrain(DRAIN_TIMEOUT_MS, { ignoreDesktop: true });
    } catch (error) {
      throw error;
    }
    try {
      await stopDaemon();
    } catch (error) {
      const unrestored = await restoreAdmissionSafe(token);
      if (unrestored) error.message = `${error.message}; ${unrestored}`;
      throw error;
    }
    try {
      const again = await pingDaemon();
      throw fail(
        ERRORS.internal,
        `Installed Desktop appears to have restarted the daemon (${sourceIdentityFromHealth(again).mode}). Quit 啾啾工坊 from the tray (full quit, not hide) and run pnpm dev again. Processes were not killed by name.`,
      );
    } catch (error) {
      if (error.code === ERRORS.internal && String(error.message).includes('restarted the daemon')) {
        const unrestored = await restoreAdmissionSafe(token);
        if (unrestored) error.message = `${error.message}; ${unrestored}`;
        throw error;
      }
    }
    return { switched: true, token };
  }

  async function applyGeneration(generation, mode) {
    const components = expandDependents(generation.components);
    if (components.includes(COMPONENTS.manifest)) {
      logger.warn('manifest-changed', 'package manifest or lockfile changed. Stop the stack, run pnpm install --frozen-lockfile, then pnpm build && pnpm dev. node_modules was not modified.');
      return { applied: false, reason: 'manifest' };
    }
    if (components.includes(COMPONENTS.supervisor)) {
      logger.warn('supervisor-changed', 'dev supervisor/build tooling changed. Run pnpm dev:stop then pnpm dev to load it.');
      return { applied: false, reason: 'supervisor' };
    }

    if (!queue.beginApply(generation)) {
      logger.info('stale-generation', `${generation.id} is no longer the latest successful generation`);
      return { applied: false, reason: 'stale' };
    }

    try {
      if (generation.artifacts?.runtimeBin) {
        currentRuntimeBin = generation.artifacts.runtimeBin;
        if (generation.artifacts.runtimeGeneration) usedRuntimeGens.add(generation.artifacts.runtimeGeneration);
      }

      const needsDaemon = components.includes(COMPONENTS.daemon)
        || components.includes(COMPONENTS.runtime)
        || components.includes(COMPONENTS.cli)
        || mode === 'restart';
      const needsDesktop = components.includes(COMPONENTS.desktopMain)
        || components.includes(COMPONENTS.desktopPreload)
        || components.includes(COMPONENTS.pet)
        || mode === 'restart';
      const rendererOnly = mode !== 'restart' && isRendererOnly(components);

      if (rendererOnly && desktop && !desktopStoppedByUser) {
        const activity = await readDesktopActivity();
        if (activity.busy || activity.modalOpen) {
          logger.info('pending', 'renderer update waiting because a conversation or modal is active');
          queue.finishApply(generation, false);
          return { applied: false, reason: 'busy' };
        }
        const ui = await captureDesktopUi();
        await reloadDesktopRenderer();
        await restoreDesktopUi(ui);
        queue.finishApply(generation, true);
        return { applied: true, action: 'reload' };
      }

      if (needsDaemon || needsDesktop) {
        if (mode === 'auto') {
          const health = await pingDaemon().catch(() => null);
          const activity = combineActivity({
            daemonHealth: health,
            desktopActivity: await readDesktopActivity(),
            desktopRequired: Boolean(desktop) && !desktopStoppedByUser,
          });
          if (activity.busy) {
            logger.info('pending', 'update waiting for idle work');
            queue.finishApply(generation, false);
            return { applied: false, reason: 'busy' };
          }
        }
        const ui = needsDesktop ? await captureDesktopUi() : null;
        // Snapshot the pre-switch status so a busy/blocked drain restores the
        // real status instead of leaving `waiting-for-idle` behind.
        const priorStatus = status;
        let token;
        try {
          token = await freezeAndDrain();
        } catch (error) {
          restoreStatusAfterFailure(priorStatus, 'update aborted before stopping components');
          throw error;
        }
        try {
          if (needsDesktop) await quitDesktop();
          if (needsDaemon) await stopDaemon();
          if (needsDaemon) await startDaemon();
          if (needsDesktop && !desktopStoppedByUser) {
            await startDesktop();
            await restoreDesktopUi(ui);
          }
          await finalizeAdmission({ token });
        } catch (error) {
          const unrestored = await restoreAdmissionSafe(token);
          if (unrestored) error.message = `${error.message}; ${unrestored}`;
          restoreStatusAfterFailure(priorStatus, 'component switch failed');
          throw error;
        }
      }
      queue.finishApply(generation, true);
      return { applied: true, action: needsDaemon ? 'restart-stack' : needsDesktop ? 'restart-desktop' : 'noop' };
    } catch (error) {
      queue.finishApply(generation, false);
      throw error;
    }
  }

  async function runBuildAndApply(reason, applyOptions = {}) {
    const generation = queue.takeBuild();
    if (!generation) return;
    logger.info('building', `${generation.id} components=${generation.components.join(',')}`);
    buildAbort = new AbortController();
    let result;
    try {
      result = await buildGeneration({
        checkout,
        generation,
        nodeExecutable,
        platform,
        env,
        exists,
        currentRuntimeBin,
        signal: buildAbort.signal,
      });
    } finally {
      buildAbort = null;
    }
    const completed = queue.completeBuild(generation, result);
    if (completed.stale || completed.failed) {
      if (completed.failed) logger.error('build-failed', result.error ?? 'build failed');
      return;
    }
    generation.artifacts = result.artifacts;
    if (queue.isStale(generation) && applyOptions.apply !== false) {
      logger.info('stale-generation', `${generation.id} skipped because a newer generation exists`);
      return;
    }
    if (applyOptions.apply === false) {
      logger.info('built', `${generation.id} apply deferred to restart`);
      return;
    }
    try {
      const applied = await applyGeneration(generation, reason === 'restart' ? 'restart' : 'auto');
      if (applied.applied) {
        logger.info('applied', `${generation.id} ${applied.action}`);
        setStatus('ready');
      } else if (applied.reason === 'busy') {
        setStatus('pending', generation.id);
        queue.enqueue(generation.components, generation.files);
      }
    } catch (error) {
      setStatus('degraded', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function explicitRestart() {
    const priorStatus = status;
    setStatus('restarting');
    return withBuildLock(async () => {
      retries.daemon = 0;
      retries.desktop = 0;
      cancelRetry('daemon');
      cancelRetry('desktop');
      if (queue.pending || queue.building) {
        await runBuildAndApply('restart', { apply: false });
      }
      const generation = queue.current ?? { id: 'explicit', components: [COMPONENTS.daemon, COMPONENTS.desktopMain], files: [] };
      desktopStoppedByUser = false;
      let applied;
      try {
        applied = await applyGeneration({
          ...generation,
          components: [COMPONENTS.daemon, COMPONENTS.desktopMain, COMPONENTS.desktopPreload, COMPONENTS.renderer],
          artifacts: { runtimeBin: currentRuntimeBin },
        }, 'restart');
      } catch (error) {
        restoreStatusAfterFailure(priorStatus, 'restart aborted before stopping components');
        throw error;
      }
      if (!applied.applied && applied.reason === 'busy') {
        // Idle wait timed out with components untouched: keep truthful status
        // and preserve the still-pending generation instead of claiming ready.
        if (queue.pending || queue.building) setStatus('pending', queue.pending?.id ?? queue.building?.id);
        else restoreStatusAfterFailure(priorStatus, 'restart waiting for idle work timed out');
        throw fail(ERRORS.busy, 'restart waiting for idle work timed out');
      }
      setStatus('ready');
      return snapshot();
    });
  }

  async function explicitStop() {
    const priorStatus = status;
    stopping = true;
    cancelRetry('daemon');
    cancelRetry('desktop');
    setStatus('stopping');
    buildAbort?.abort();
    await buildLock.catch(() => undefined);
    // The watcher stays alive until the stop fully succeeds: a failed drain or
    // component stop must leave a usable supervisor, not a dead one. The
    // `stopping` flag keeps new file changes from being applied meanwhile.
    let token;
    try {
      const health = await pingDaemon().catch(() => null);
      if (health) token = await freezeAndDrain();
      await quitDesktop();
      await stopDaemon();
    } catch (error) {
      // Nothing is reported as stopped: restore admission so the still-running
      // stack is controllable, clear `stopping`, and publish the real status.
      const unrestored = await restoreAdmissionSafe(token);
      stopping = false;
      restoreStatusAfterFailure(priorStatus, 'stop aborted; supervisor remains usable');
      if (unrestored) error.message = `${error.message}; ${unrestored}`;
      throw error;
    }
    try {
      watcher?.close();
      watcher = null;
      setStatus('stopped');
      server?.close();
    } catch {
      // ignore
    }
    return snapshot();
  }

  const handlers = {
    async status() {
      return snapshot();
    },
    async restart() {
      const result = requests.submit('restart');
      pumpRequests();
      return result;
    },
    async stop() {
      const result = requests.submit('stop');
      pumpRequests();
      return result;
    },
    async 'component.hello'(params, session) {
      if (params?.role === 'desktop') {
        session.launchId = desktopSlot?.launchId;
        if (desktopSlot) desktopSession = session;
      }
      return { ok: true, instanceId, status };
    },
    async 'component.event'(params, session) {
      if (session?.launchId && desktopSlot?.launchId && session.launchId !== desktopSlot.launchId) {
        return { ok: true, ignored: 'stale' };
      }
      return { ok: true, received: params?.type };
    },
  };

  function pumpRequests() {
    const kind = requests.take();
    if (!kind) return;
    const work = kind === 'stop' ? explicitStop() : explicitRestart();
    work.then((value) => {
      requests.finish({ ok: true, result: value });
      if (kind === 'stop') {
        options.onStopped?.();
      } else {
        pumpRequests();
      }
    }).catch((error) => {
      requests.finish({
        ok: false,
        code: error.code ?? ERRORS.internal,
        message: error instanceof Error ? error.message : String(error),
        data: error.data ?? error.blocking,
      });
      if (kind !== 'stop') setStatus('degraded', error instanceof Error ? error.message : String(error));
      else stopping = false;
      pumpRequests();
    });
  }

  async function claim() {
    mkdirSync(logs, { recursive: true });
    try {
      server = await listenControl(controlEndpoint, { platform, retryStale: platform !== 'win32' });
      attachHandler(server, handlers, (session) => sessions.add(session));
      return { role: 'owner' };
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      const existing = readInstanceFile(instanceFile);
      try {
        const client = await connectControl(controlEndpoint);
        const peer = await client.request('status', {});
        client.close();
        if (sameCheckout(peer.checkout, checkout, platform)) {
          return { role: 'same', peer };
        }
        return { role: 'other', peer };
      } catch (connectError) {
        if (existing && processAlive(existing.supervisorPid)) {
          throw fail(ERRORS.internal, `A Wrenyard source-development instance may still be running (pid ${existing.supervisorPid}, checkout ${existing.checkout}). Control endpoint ${controlEndpoint} is unreachable. Stop it from that checkout or recover manually; unknown processes were not killed.`);
        }
        throw fail(ERRORS.internal, `Control endpoint ${controlEndpoint} is busy but no supervisor answered (${connectError instanceof Error ? connectError.message : String(connectError)}).`);
      }
    }
  }

  async function start() {
    setStatus('preparing');
    const toolErrors = checkToolchain({ checkout, platform, exists });
    const artifacts = checkBuildArtifacts({ checkout, platform, exists });
    if (toolErrors.length > 0 || artifacts.errors.length > 0) {
      throw fail(ERRORS.internal, [...toolErrors, ...artifacts.errors].join('\n'));
    }
    currentRuntimeBin = artifacts.runtimeBin;
    const claimed = await claim();
    if (claimed.role === 'same') {
      logger.info('already-running', `source-development already ready for this checkout. logs: ${claimed.peer.paths?.logs ?? logger.path}`);
      options.stdout?.(`already running\n${JSON.stringify(claimed.peer, null, 2)}`);
      return { alreadyRunning: true, snapshot: claimed.peer };
    }
    if (claimed.role === 'other') {
      throw fail(ERRORS.wrongCheckout, `A source-development instance already owns this user-data domain from ${claimed.peer.checkout}. Stop it there with pnpm dev:stop.`);
    }

    try {
      await ensureReleaseDesktopCleared();
    } catch (error) {
      server?.close();
      throw error;
    }

    persist();
    let handover = { switched: false, token: null };
    try {
      handover = await handoverInstalled();
    } catch (error) {
      server?.close();
      throw error;
    }

    setStatus('starting');
    try {
      await startDaemon();
    } catch (error) {
      const unrestored = await restoreAdmissionSafe(handover?.token);
      if (unrestored) {
        logger.error('admission-unrestored', unrestored);
        error.message = `${error.message}; ${unrestored}`;
      } else if (shouldAutoThaw(handover?.token)) {
        logger.error('admission-unrestored', `source daemon did not start; dispatch may remain frozen. ${DISPATCH_THAW_HINT}`);
        options.stdout?.(`source daemon did not start. ${DISPATCH_THAW_HINT}`);
      }
      throw error;
    }
    const admission = await finalizeAdmission(handover);
    await startDesktop();
    watcher = createWatcher({
      checkout,
      onChange: ({ files, components }) => {
        if (components.length === 0) return;
        logger.info('changed', `files=${files.join(', ')} components=${expandDependents(components).join(',')}`);
        queue.enqueue(expandDependents(components), files);
        void withBuildLock(() => runBuildAndApply('watch')).catch((error) => {
          logger.error('apply-failed', error instanceof Error ? error.message : String(error));
        });
      },
    });
    setStatus('ready');
    printReady(admission);
    return { alreadyRunning: false, snapshot: snapshot() };
  }

  async function handleSignal() {
    try {
      await explicitStop();
      options.onStopped?.();
    } catch (error) {
      logger.error('signal-stop-blocked', error instanceof Error ? error.message : String(error));
      options.stdout?.(`Cannot stop while work is active: ${error instanceof Error ? error.message : String(error)}\nSupervisor remains running. Finish or cancel the work, then pnpm dev:stop.`);
    }
  }

  return {
    start,
    snapshot,
    handleSignal,
    get status() {
      return status;
    },
    get instanceId() {
      return instanceId;
    },
    get daemonSlot() {
      return daemonSlot;
    },
    get desktopSlot() {
      return desktopSlot;
    },
    get retries() {
      return { daemon: retries.daemon, desktop: retries.desktop };
    },
    handoverInstalled,
    startDaemon,
    startDesktop,
    stopDaemon,
    quitDesktop,
    freezeAndDrain,
    finalizeAdmission,
    restoreAdmission,
    applyGeneration,
    explicitRestart,
    explicitStop,
    helloDesktop(session) {
      return handlers['component.hello']({ role: 'desktop' }, session);
    },
    desktopEvent(params, session) {
      return handlers['component.event'](params, session);
    },
  };
}

export { sourceChildEnv };
