import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { buildGeneration, checkBuildArtifacts, checkToolchain, COMPONENT_BUILD_TARGETS, desktopBuildArgs } from './builder.mjs';
import { childHasExited, componentLogPath, spawnDaemonProcess, spawnDesktopProcess, stopChild, stopOwnedDesktopTree } from './children.mjs';
import { attachHandler, connectControl, ERRORS, isAddrInUse, listenControl } from './control.mjs';
import { COMPONENTS, createWatcher, expandDependents, significantComponents } from './graph.mjs';
import {
  createInstanceRecord,
  formatGitRevision,
  newInstanceId,
  newLaunchId,
  processAlive,
  readGitRevision,
  readInstanceFile,
  startIdentity,
  writeInstanceFile,
} from './identity.mjs';
import {
  businessIpcPath,
  configDir,
  controlEndpoint as resolveControlEndpoint,
  defaultRuntimeBin,
  desktopUserData,
  instancePath as resolveInstancePath,
  logDir as resolveLogDir,
  normalizeCheckout,
  sameCheckout,
  stateRoot,
} from './paths.mjs';
import {
  createInspectReleaseDesktop,
  createTerminateReleaseDesktop,
  DESKTOP_KILL_WAIT_MS,
  gateReleaseDesktop,
  runExecFile,
} from './release-desktop.mjs';
import {
  DISPATCH_THAW_HINT,
  dispatchBlocksNewWork,
  identityMatchesSource,
  sourceIdentityFromHealth,
  withDaemon,
} from './rpc.mjs';
import { pnpmInvocation, sourceCliInvocation, spawnArgv } from './spawn.mjs';

const HEALTH_WAIT_MS = 20_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 3;
const SECRET_LINE = /(token|secret|password|authorization|api[_-]?key|bearer\s+[a-z0-9._-]+)/iu;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(code, message) {
  return Object.assign(new Error(message), { code, ok: false, message });
}

function createLogger(options) {
  const dir = options.dir;
  const fileName = options.fileName ?? 'supervisor.log';
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);

  function rotateIfNeeded() {
    try {
      if (statSync(path).size < (options.maxBytes ?? LOG_MAX_BYTES)) return;
    } catch {
      return;
    }
    const max = options.maxFiles ?? LOG_MAX_FILES;
    for (let index = max - 1; index >= 1; index -= 1) {
      const from = index === 1 ? path : `${path}.${index - 1}`;
      const to = `${path}.${index}`;
      try {
        renameSync(from, to);
      } catch {
        // Missing older files are expected.
      }
    }
  }

  function write(level, event, detail = '') {
    const raw = detail ? `${event} ${detail}` : event;
    const safe = SECRET_LINE.test(raw) ? `${event} [redacted]` : raw;
    const line = `${now()} ${level} ${safe}`;
    rotateIfNeeded();
    try {
      writeFileSync(path, `${line}\n`, { flag: 'a' });
    } catch {
      // Logging must never crash the supervisor.
    }
    if (level !== 'debug') stdout(line);
    return line;
  }

  return {
    path,
    info: (event, detail) => write('info', event, detail),
    warn: (event, detail) => write('warn', event, detail),
    error: (event, detail) => write('error', event, detail),
    debug: (event, detail) => write('debug', event, detail),
  };
}

function createGenerationQueue(options = {}) {
  let seq = options.initialSeq ?? 0;
  let pending = null;
  let active = null;

  function merge(base, next) {
    return {
      id: next.id,
      seq: next.seq,
      components: [...new Set([...base.components, ...next.components])],
      files: [...new Set([...base.files, ...next.files])],
      reason: next.reason,
      superseded: base.id,
    };
  }

  return {
    get pending() {
      return pending;
    },
    get active() {
      return active;
    },
    enqueue(reason, components, files) {
      seq += 1;
      const generation = {
        id: `g${seq}`,
        seq,
        components: [...new Set(components ?? [])],
        files: [...new Set(files ?? [])],
        reason: reason ?? 'watch',
      };
      pending = pending ? merge(pending, generation) : generation;
      return pending;
    },
    takeRestart() {
      if (!pending) return null;
      active = pending;
      pending = null;
      return active;
    },
    completeBuild(generation) {
      if (active?.id === generation?.id) active = null;
    },
    failBuild(generation) {
      if (active?.id === generation?.id) active = null;
    },
    isStale(generation) {
      return Boolean(pending && generation && pending.seq > generation.seq);
    },
  };
}

function createRequestQueue() {
  let current = null;
  const stopWaiters = [];
  const replaceWaiters = [];

  function settle(list, result) {
    const waiters = list.splice(0, list.length);
    for (const waiter of waiters) waiter(result);
  }

  return {
    submit(kind) {
      if (kind !== 'stop' && kind !== 'replace') {
        throw new Error(`unsupported control kind: ${kind}`);
      }
      return new Promise((resolve, reject) => {
        const waiter = (result) => {
          if (result.ok) resolve(result);
          else reject(Object.assign(new Error(result.message), result));
        };
        if (kind === 'stop') stopWaiters.push(waiter);
        else replaceWaiters.push(waiter);
      });
    },
    take() {
      if (current) return null;
      if (replaceWaiters.length > 0) {
        settle(stopWaiters, {
          ok: false,
          code: ERRORS.cancelled,
          message: 'stop cancelled because a launcher replacement took priority',
        });
        current = 'replace';
        return 'replace';
      }
      if (stopWaiters.length > 0) {
        current = 'stop';
        return 'stop';
      }
      return null;
    },
    finish(result) {
      const kind = current;
      current = null;
      if (kind === 'stop') settle(stopWaiters, result);
      else if (kind === 'replace') settle(replaceWaiters, result);
    },
  };
}

/**
 * Components that only change how the stack is *served*, not what it serves.
 * Those are produced by `pnpm build`, never by the watcher, and a change to
 * them is applied by replacing this supervisor process.
 */
const SUPERVISOR_COMPONENTS = new Set([COMPONENTS.supervisor, COMPONENTS.manifest]);

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
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const spawnDaemon = options.spawnDaemon ?? spawnDaemonProcess;
  const spawnDesktop = options.spawnDesktop ?? spawnDesktopProcess;
  const stopChildFn = options.stopChild ?? stopChild;
  const runCommand = options.runCommand ?? runExecFile;
  const spawnBuild = options.spawnProcess ?? spawnProcess;
  const makeLaunchId = options.newLaunchId ?? newLaunchId;
  const killDesktop = options.killDesktop === true;
  const installTimeoutMs = options.installTimeoutMs ?? 600_000;
  const buildTimeoutMs = options.buildTimeoutMs ?? 900_000;
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
  let replacing = false;
  let buildAbort = null;
  let pumpPromise = null;
  let reloadPromise = null;
  let buildFailure = null;
  let bootComplete = false;
  const sessions = new Set();

  function updateRuntimeBin(next) {
    if (!next) return;
    currentRuntimeBin = next;
  }

  /**
   * pnpm install/build invocations are resolved against the checkout the way
   * the source loop resolves child commands: never through a shell.
   */
  function resolveCommand(command, args, mode) {
    if (mode === 'pnpm') {
      const invocation = pnpmInvocation(checkout, args, nodeExecutable, exists);
      return { command: invocation.command, args: invocation.args, cwd: checkout };
    }
    const resolved = spawnArgv(command, args, platform, env);
    return { command: resolved.command, args: resolved.args, cwd: checkout };
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
   * transient operation status (starting / stopping / restarting).
   */
  function healthyStatus() {
    const alive = (child) => Boolean(child) && !childHasExited(child);
    if (!alive(daemon)) return 'degraded';
    if (desktopStoppedByUser) return 'ready';
    return alive(desktop) ? 'ready' : 'degraded';
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
      replacing,
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
      `edits reload the whole stack; stop with Ctrl+C`,
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

  /**
   * A local dev loop does not restart crashed components on its own: an
   * unexpected exit is reported as `degraded` and the next file save or
   * running `pnpm dev` again brings the stack back.
   */
  function onTrackedChildExit(slot, code, signal) {
    if (stopping || replacing) return;
    const current = slot.kind === 'daemon' ? daemonSlot : desktopSlot;
    if (current !== slot) {
      logger.info('stale-exit', `${slot.kind} launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'} ignored`);
      return;
    }
    if (slot.expectedExit) {
      logger.info('expected-exit', `${slot.kind} launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'} code=${code ?? 'none'} signal=${signal ?? 'none'}`);
      return;
    }
    const detail = `${slot.kind} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}) launchId=${slot.launchId} pid=${slot.child?.pid ?? 'unknown'}`;
    if (slot.kind === 'desktop' && code === 0 && !signal) {
      desktopStoppedByUser = true;
      desktopSession = null;
      desktopSlot = null;
      desktop = null;
      persist({ desktopPid: null });
      logger.info('desktop-stopped', `${detail}. Supervisor and daemon stay running; save a file or run pnpm dev again to restore the window.`);
      setStatus('ready', 'desktop stopped by the user');
      return;
    }
    logger.error('component-exited', `${detail}; no automatic restart`);
    setStatus('degraded', detail);
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

  async function quitDesktop() {
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
      run: runCommand,
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

  /**
   * Report the live dispatch state without changing it.
   *
   * Source development no longer freezes anything: an operator freeze is left
   * exactly as it was found, and it is surfaced rather than silently thawed.
   */
  async function finalizeAdmission() {
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
      if (!slot.expectedExit && daemonSlot === slot && !slot.failureCounted && !childHasExited(child)) {
        slot.failureCounted = true;
        slot.expectedExit = true;
        try { await stopChildFn(child); } catch { /* owned child cleanup */ }
        if (daemonSlot === slot) {
          daemonSlot = null;
          daemon = null;
        }
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
    try {
      // Desktop readiness only means the OS launched the process. Its UI and
      // supervisor bridge may initialize later; neither gates source dev.
      await new Promise((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const cleanup = () => {
          child.off('spawn', onSpawn);
          child.off('error', onError);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      if (childHasExited(child) || desktopSlot !== slot) {
        throw fail(ERRORS.internal, `Desktop exited during launch (launchId ${launchId}, code ${child.exitCode ?? 'unknown'})`);
      }
      slot.startInFlight = false;
      slot.healthySince = now();
    } catch (error) {
      slot.startInFlight = false;
      if (!slot.expectedExit && desktopSlot === slot && !slot.failureCounted && !childHasExited(child)) {
        slot.failureCounted = true;
        slot.expectedExit = true;
        try { await stopChildFn(child); } catch { /* owned child cleanup */ }
        if (desktopSlot === slot) {
          desktopSlot = null;
          desktop = null;
        }
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
      return { switched: false };
    }
    const identity = sourceIdentityFromHealth(health);
    if (identity.mode === 'source') {
      if (identity.instanceId === instanceId) return { switched: false, self: true };
      throw fail(ERRORS.wrongCheckout, `A source-development instance is already running for ${identity.checkout ?? 'another checkout'}`);
    }
    const block = dispatchBlocksNewWork(health);
    if (health?.dispatch?.mode === 'planned_restart' || health?.dispatch?.recovery_required) {
      throw fail(ERRORS.busy, `cannot take over installed Wrenyard: ${block.reason}`);
    }
    logger.info('switching', 'Installed Wrenyard is running; switching to the source environment');
    // The source stack replaces the installed daemon outright, so no drain wait
    // is involved and no freeze is installed: an operator freeze belongs to the
    // operator and is never created or cleared here.
    await stopDaemon();
    try {
      const again = await pingDaemon();
      throw fail(
        ERRORS.internal,
        `Installed Desktop appears to have restarted the daemon (${sourceIdentityFromHealth(again).mode}). Quit 啾啾工坊 from the tray (full quit, not hide) and run pnpm dev again. Processes were not killed by name.`,
      );
    } catch (error) {
      if (error.code === ERRORS.internal && String(error.message).includes('restarted the daemon')) throw error;
    }
    return { switched: true };
  }

  /**
   * Queue a whole-stack restart. There is exactly one in flight at a time and
   * exactly one waiting behind it, so a burst of saves costs at most two
   * restarts instead of one per edit.
   */
  function requestRestart(reason, components, files) {
    if (stopping || replacing) return Promise.resolve();
    queue.enqueue(reason, components, files);
    if (!bootComplete) return Promise.resolve();
    return pump();
  }

  function releaseBoot() {
    bootComplete = true;
    return pump();
  }

  /**
   * The single source-change path: build the affected targets, then restart the
   * complete daemon + Desktop stack. There is no renderer-only reload, no idle
   * wait (the user accepts interrupting in-flight work), and no crash retry.
   *
   * The claimed generation is passed in by `pump`; it is the *only* consumer, so
   * the generation is never taken twice (a second `takeRestart` returns null and
   * would silently turn every build into a no-op).
   */
  async function applyGeneration(generation) {
    if (!generation) return { applied: false, reason: 'coalesced' };
    const components = expandDependents(generation.components);
    const isManifest = components.includes(COMPONENTS.manifest);
    const started = now();

    buildAbort = new AbortController();
    try {
      if (isManifest) {
        // A manifest edit cannot be applied through the watcher's target list:
        // it needs a frozen install and a full build of everything.
        await buildManifest();
      } else {
        const build = options.buildGeneration ?? buildGeneration;
        const result = await build({
          checkout,
          generation: { ...generation, components },
          nodeExecutable,
          platform,
          env,
          exists,
          currentRuntimeBin,
          signal: buildAbort.signal,
        });
        if (result.ok !== true) {
          queue.failBuild(generation, result.error);
          throw fail(ERRORS.internal, result.error ?? 'build failed');
        }
        updateRuntimeBin(result.artifacts?.runtimeBin);
      }
    } catch (error) {
      queue.failBuild(generation, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      buildAbort = null;
    }
    queue.completeBuild(generation);

    // Every generation replaces the whole owned stack. A renderer change also
    // restarts the daemon, and a component that is already gone (crashed, or
    // quit by the user) is started here rather than left missing.
    await restartStack();
    logger.info('applied', `${generation.id} restart ${Math.max(0, now() - started)}ms`);
    return { applied: true, action: 'restart-stack' };
  }

  /**
   * Stop the owned daemon and Desktop, then start both again. This is a whole
   * stack restart: it runs for every component change, including renderer-only
   * edits, and it starts a component that is currently absent. There is no
   * automatic freeze: an operator freeze is preserved because this flow never
   * creates one.
   */
  async function restartStack() {
    await quitDesktop();
    await stopDaemon();
    await startDaemon();
    await startDesktop();
    return { swapped: true, daemon: daemonSlot?.launchId ?? null, desktop: desktopSlot?.launchId ?? null };
  }

  /**
   * Serialized lifecycle loop. One build/restart runs at a time; a change that
   * arrives while one is running queues exactly one follow-up generation
   * (hidden-test: changes during a build serialize into a single next restart).
   */
  function pump() {
    if (stopping || replacing) return Promise.resolve();
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      try {
        for (;;) {
          if (stopping || replacing) return;
          const generation = queue.takeRestart();
          if (!generation) return;
          setStatus('restarting', 'source change');
          try {
            await applyGeneration(generation);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            buildFailure = message;
            setStatus('degraded', message);
            logger.error('restart-failed', `${message}; still watching for the next save`);
            continue;
          }
          buildFailure = null;
          if (stopping) return;
          setStatus(healthyStatus());
        }
      } finally {
        pumpPromise = null;
      }
    })();
    return pumpPromise;
  }

  async function explicitStop() {
    stopping = true;
    setStatus('stopping');
    buildAbort?.abort();
    await (pumpPromise ?? Promise.resolve()).catch(() => undefined);
    // The watcher stays alive until the stop fully succeeds: a failed component
    // stop must leave a usable supervisor, not a dead one.
    try {
      await quitDesktop();
      await stopDaemon();
    } catch (error) {
      stopping = false;
      setStatus(healthyStatus(), 'stop aborted; supervisor remains usable');
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
    async stop() {
      const result = requests.submit('stop');
      pumpRequests();
      return result;
    },
    async replace() {
      const result = requests.submit('replace');
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
    if (kind === 'replace') {
      explicitReplace().catch((error) => {
        requests.finish({
          ok: false,
          code: error.code ?? ERRORS.internal,
          message: error instanceof Error ? error.message : String(error),
          data: error.data ?? error.blocking,
        });
        replacing = false;
        stopping = false;
        setStatus('degraded', error instanceof Error ? error.message : String(error));
        pumpRequests();
      });
      return;
    }
    explicitStop().then((value) => {
      requests.finish({ ok: true, result: value });
      options.onStopped?.();
    }).catch((error) => {
      requests.finish({
        ok: false,
        code: error.code ?? ERRORS.internal,
        message: error instanceof Error ? error.message : String(error),
        data: error.data ?? error.blocking,
      });
      stopping = false;
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
    if (toolErrors.length > 0) {
      throw fail(ERRORS.internal, toolErrors.join('\n'));
    }

    // Claim the control endpoint and clear an installed Desktop *before*
    // building: a second `pnpm dev` must not sit through a full build only to
    // discover that this checkout is already owned, and a build must never run
    // over a live stack this process does not own.
    const claimed = await claim();
    if (claimed.role === 'other') {
      throw fail(ERRORS.wrongCheckout, `A source-development instance already owns this user-data domain from ${claimed.peer.checkout}. Run pnpm dev from that checkout.`);
    }

    try {
      await ensureReleaseDesktopCleared();
    } catch (error) {
      server?.close();
      throw error;
    }

    persist();

    // The watcher starts before the first build so a failed first build can be
    // retried by saving. Restart apply waits until boot finishes so a delayed
    // artifact event cannot SIGTERM the daemon that start() is still waiting on.
    startWatcher();
    try {
      await installIfNeeded();
      const artifacts = checkBuildArtifacts({ checkout, platform, exists });
      await buildInitialArtifacts(artifacts.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('degraded', message);
      await releaseBoot();
      return { alreadyRunning: false, degraded: true, snapshot: snapshot() };
    }

    updateRuntimeBin(checkBuildArtifacts({ checkout, platform, exists }).runtimeBin);
    persist();

    let handover = { switched: false, token: null };
    try {
      handover = await handoverInstalled();
    } catch (error) {
      server?.close();
      throw error;
    }

    setStatus('starting');
    let admission = { blocked: false };
    try {
      await startDaemon();
      admission = await finalizeAdmission(handover);
      await startDesktop();
    } catch (error) {
      // The watcher still stays up: a failed component must remain fixable by
      // editing and saving, not only by stopping everything by hand.
      logger.error('start-degraded', error instanceof Error ? error.message : String(error));
      setStatus('degraded', error instanceof Error ? error.message : String(error));
      await releaseBoot();
      return { alreadyRunning: false, degraded: true, snapshot: snapshot() };
    }
    setStatus('ready');
    printReady(admission);
    await releaseBoot();
    return { alreadyRunning: false, snapshot: snapshot() };
  }

  /**
   * `pnpm install --frozen-lockfile` before a build when node_modules has never
   * been populated. Never runs for manifest edits (that would silently mutate a
   * pinned install); those are reported and await a deliberate edit.
   */
  async function installIfNeeded() {
    if (exists(join(checkout, 'node_modules'))) return;
    setStatus('preparing', 'installing dependencies');
    const result = await runExternalSteps('packages', [{
      label: 'pnpm install --frozen-lockfile',
      command: 'node',
      args: ['--version'],
      mode: 'pnpm',
      pnpmArgs: ['install', '--frozen-lockfile'],
    }]);
    if (result.ok !== true) {
      throw fail(ERRORS.internal, `pnpm install --frozen-lockfile failed before the first build:\n${result.error}`);
    }
  }

  /** Frozen install for a manifest edit; never mutates the pinned lockfile. */
  async function runFrozenInstall() {
    const result = await runExternalSteps('install', [{
      label: 'pnpm install --frozen-lockfile',
      command: 'node',
      args: ['--version'],
      mode: 'pnpm',
      pnpmArgs: ['install', '--frozen-lockfile'],
    }]);
    if (result.ok !== true) {
      throw fail(ERRORS.internal, `pnpm install --frozen-lockfile failed:\n${result.error}`);
    }
  }

  /**
   * A manifest edit (`package.json`, lockfile) is applied by a frozen install
   * followed by a full build of every target, all through the same injected run
   * seam the rest of the loop uses.
   */
  async function buildManifest() {
    await runFrozenInstall();
    await buildInitialArtifacts([]);
    updateRuntimeBin(checkBuildArtifacts({ checkout, platform, exists }).runtimeBin);
  }

  /**
   * First-startup build. Any artifact `pnpm build` produces (`shared`, `pet`,
   * `forge`) is always rebuilt because those are owned by the repository build
   * script, not by the watcher; Desktop targets are only built when missing.
   */
  async function buildInitialArtifacts(missingErrors) {
    setStatus('preparing', 'building artifacts');
    const steps = [
      { label: 'shared packages', command: 'node', args: ['--version'], mode: 'pnpm', pnpmArgs: buildPackageArgs('packages') },
      { label: 'pet', command: 'node', args: ['--version'], mode: 'pnpm', pnpmArgs: buildPackageArgs('pet') },
      { label: 'desktop', command: nodeExecutable, args: desktopBuildArgs(COMPONENT_BUILD_TARGETS, true) },
      { label: 'forge runtime', command: 'go', args: forgeBuildArgs() },
    ];
    const result = await runExternalSteps('build', steps);
    if (result.ok !== true) {
      throw fail(ERRORS.internal, `Initial build failed:\n${result.error}${missingErrors.length > 0 ? `\n${missingErrors.join('\n')}` : ''}`);
    }
  }

  function buildPackageArgs(filter) {
    if (filter === 'packages') return ['-r', '--filter', './packages/*', '--if-present', 'run', 'build'];
    return ['--filter', '@wrenyard/pet', 'run', 'build'];
  }

  function forgeBuildArgs() {
    return ['-C', join(checkout, 'runtime', 'forge'), 'build', '-o', join(checkout, 'runtime', 'forge', 'bin', platform === 'win32' ? 'forge.exe' : 'forge'), './cmd/forge'];
  }

  async function runExternalSteps(kind, steps) {
    const logs = [];
    for (const step of steps) {
      const args = step.pnpmArgs ?? step.args;
      const resolved = resolveCommand(step.command, args, step.mode);
      logger.info('external-step', `${kind}: ${step.label}`);
      let result;
      try {
        result = options.runStep
          ? await options.runStep(step, { kind, checkout, env, platform, nodeExecutable })
          : await runExternalCommand(resolved.command, resolved.args, resolved.cwd, step.mode === 'pnpm' ? installTimeoutMs : buildTimeoutMs);
      } catch (error) {
        return { ok: false, error: `${step.label}: ${error instanceof Error ? error.message : String(error)}` };
      }
      logs.push(result.stderr || result.stdout || '');
      if (result.status !== 0) {
        return { ok: false, error: `${step.label} exited ${result.status}\n${(result.stderr || result.stdout || '').trim()}` };
      }
    }
    return { ok: true, logs };
  }

  function runExternalCommand(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawnBuild(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ status: 1, stdout, stderr: `${stderr}${error.message}`, error });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status: status ?? 1, stdout, stderr });
      });
    });
  }

  function startWatcher() {
    if (watcher) return;
    watcher = createWatcher({
      checkout,
      onChange: ({ files, components }) => {
        if (components.length === 0) return;
        const affected = expandDependents(components);
        const significant = significantComponents(affected);
        if (significant.length > 0) {
          logger.warn('significant-changed', `${significant.join(', ')} changed. Those artifacts come from pnpm build; this restart rebuilds and reloads the whole stack.`);
        }
        if (affected.some((component) => SUPERVISOR_COMPONENTS.has(component))) {
          // A supervisor/tooling change cannot be applied by an in-process
          // restart, because the modules are already loaded. The owned stack is
          // stopped first, then `onReload` (which owns the fresh process) takes
          // over. There is no cache-busted in-process re-import.
          logger.info('reload-requested', `${files.join(', ')} changed: stopping the owned stack for a fresh process.`);
          requestReload(files);
          return;
        }
        if (components.includes(COMPONENTS.manifest)) {
          // A manifest edit is not a source build: run a frozen install followed
          // by a full build, then restart the whole stack.
          logger.info('manifest-changed', `files=${files.join(', ')}: frozen install then full build.`);
          requestRestart('manifest', affected, files);
          return;
        }
        logger.info('changed', `files=${files.join(', ')} components=${affected.join(',')}`);
        requestRestart('watch', affected, files);
      },
    });
  }

  /**
   * Tooling/supervisor edit: only a brand-new process can load current modules.
   * The owned stack is stopped first, then `onReload` runs the replacement.
   * Without a callback there is nothing safe to do but report it.
   */
  function requestReload(files) {
    if (stopping || replacing) return Promise.resolve();
    if (typeof options.onReload !== 'function') {
      logger.warn('reload-unavailable', `${files.join(', ')} changed: no reload callback is wired, so the running modules stay stale.`);
      return Promise.resolve();
    }
    if (reloadPromise) return reloadPromise;
    reloadPromise = (async () => {
      try {
        replacing = true;
        setStatus('stopping', 'reloading dev tooling');
        buildAbort?.abort();
        await (pumpPromise ?? Promise.resolve()).catch(() => undefined);
        await quitDesktop().catch(() => undefined);
        await stopDaemon().catch(() => undefined);
        try {
          watcher?.close();
          watcher = null;
        } catch {
          // ignore
        }
        setStatus('stopped', 'reloading dev tooling');
        options.onReload?.();
      } finally {
        reloadPromise = null;
      }
    })();
    return reloadPromise;
  }

  async function handleSignal() {
    try {
      await explicitStop();
      options.onStopped?.();
    } catch (error) {
      logger.error('signal-stop-blocked', error instanceof Error ? error.message : String(error));
      options.stdout?.(`Cannot stop while work is active: ${error instanceof Error ? error.message : String(error)}\nSupervisor remains running. Finish or cancel the work, then stop it again.`);
    }
  }

  function settleRestartWaiters() {
    requests.finish({ ok: true, result: { role: 'replace', supervisorPid: process.pid, instanceId, checkout } });
  }

  /**
   * Launcher takeover: `pnpm dev` running again for this checkout replaces this
   * stack so the newest supervisor and tooling modules are loaded.
   *
   * The acknowledgement is sent from *this* process, so it necessarily comes
   * from current protocol code; an older supervisor therefore only needs the
   * `replace` method to exist. The launcher owns the wait for this process to
   * exit and for the control endpoint to be free.
   */
  async function explicitReplace() {
    replacing = true;
    setStatus('stopping', 'replaced by a newer pnpm dev');
    // Settle the control request on the next turn: the socket closes as soon as
    // the launcher has its answer, and the launcher then waits for our exit.
    setImmediate(settleRestartWaiters);
    buildAbort?.abort();
    quitDesktop()
      .catch((error) => logger.warn('replace-desktop', error instanceof Error ? error.message : String(error)))
      .then(() => stopDaemon())
      .catch((error) => logger.warn('replace-daemon', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        try {
          watcher?.close();
          watcher = null;
        } catch {
          // ignore
        }
        try {
          server?.close();
        } catch {
          // ignore
        }
        setStatus('stopped');
        options.onReplaced?.();
      });
    return { accepted: true };
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
    get buildFailure() {
      return buildFailure;
    },
    handoverInstalled,
    startDaemon,
    startDesktop,
    stopDaemon,
    quitDesktop,
    finalizeAdmission,
    requestRestart,
    requestReload,
    applyGeneration,
    restartStack,
    explicitStop,
    explicitReplace,
    helloDesktop(session) {
      return handlers['component.hello']({ role: 'desktop' }, session);
    },
    desktopEvent(params, session) {
      return handlers['component.event'](params, session);
    },
  };
}
