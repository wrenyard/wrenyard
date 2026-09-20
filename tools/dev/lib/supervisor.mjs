import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  COMPONENT_RETRY_BACKOFF_MS,
  COMPONENT_RETRY_LIMIT,
  DESKTOP_KILL_WAIT_MS,
  DRAIN_TIMEOUT_MS,
  HEALTH_WAIT_MS,
} from './constants.mjs';
import { combineActivity, identityMatchesSource } from './activity.mjs';
import { buildGeneration } from './builder.mjs';
import { spawnDaemonProcess, spawnDesktopProcess, stopChild, componentLogPath } from './children.mjs';
import { attachHandler, connectControl, isAddrInUse, listenControl } from './control.mjs';
import { sourceChildEnv } from './env.mjs';
import { COMPONENTS, expandDependents, isRendererOnly } from './graph.mjs';
import { createInstanceRecord, formatGitRevision, newInstanceId, processAlive, readGitRevision, startIdentity } from './identity.mjs';
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
  let desktopSession = null;
  let desktopStoppedByUser = false;
  let currentRuntimeBin = options.runtimeBin ?? defaultRuntimeBin(checkout, platform, exists);
  let stopping = false;
  let retries = { daemon: 0, desktop: 0 };
  let buildAbort = null;
  let buildLock = Promise.resolve();
  const usedRuntimeGens = new Set();
  const sessions = new Set();

  function withBuildLock(fn) {
    const run = buildLock.then(fn, fn);
    buildLock = run.then(() => undefined, () => undefined);
    return run;
  }

  function resolvedPaths() {
    const cli = sourceCliInvocation(checkout, [], nodeExecutable, exists);
    return {
      instanceId,
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

  function printReady() {
    const snap = snapshot();
    options.stdout?.([
      'ready',
      `checkout: ${snap.checkout}`,
      `revision: ${snap.git}`,
      'mode: source-development',
      `supervisor pid: ${snap.pids.supervisor}`,
      `daemon pid: ${snap.pids.daemon ?? '—'}`,
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
    ].join('\n'));
  }

  async function pingDaemon() {
    return withDaemon(ipcPath, (client) => client.request('health.ping', {}), 1500);
  }

  async function waitForSourceDaemon(timeoutMs = HEALTH_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'daemon did not become healthy';
    while (Date.now() < deadline) {
      try {
        const health = await pingDaemon();
        if (health?.ok !== true) {
          lastError = 'health.ping did not return ok';
        } else if (!identityMatchesSource(health, { instanceId })) {
          const identity = sourceIdentityFromHealth(health);
          lastError = `daemon identity is ${identity.mode ?? 'unknown'}, not this source instance`;
        } else {
          return health;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(250);
    }
    throw fail(ERRORS.internal, lastError);
  }

  async function waitForIpcDown(timeoutMs = HEALTH_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await pingDaemon();
      } catch {
        return;
      }
      await sleep(200);
    }
    throw fail(ERRORS.internal, `business IPC still reachable at ${ipcPath}`);
  }

  async function readDesktopActivity() {
    if (!desktop || desktop.exitCode != null) return { known: true, busy: false, running: false };
    if (!desktopSession) return { known: false, busy: true };
    try {
      const activity = await desktopSession.request('desktop.activity', {});
      return { known: true, ...activity };
    } catch {
      return { known: false, busy: true };
    }
  }

  async function captureDesktopUi() {
    if (!desktopSession) return null;
    try {
      return await desktopSession.request('desktop.snapshotUi', {});
    } catch {
      return null;
    }
  }

  async function restoreDesktopUi(ui) {
    if (!desktopSession || !ui) return;
    try {
      await desktopSession.request('desktop.restoreUi', ui);
    } catch {
      // Restoration is best-effort UI state only.
    }
  }

  async function reloadDesktopRenderer() {
    if (!desktopSession) return;
    await desktopSession.request('desktop.reload', {});
  }

  async function quitDesktop() {
    if (!desktop) return;
    if (desktopSession) {
      try {
        await desktopSession.request('desktop.quit', {});
      } catch {
        // Fall through to child signal.
      }
    }
    await stopChild(desktop);
    desktop = null;
    desktopSession = null;
  }

  async function freezeAndDrain(timeoutMs = DRAIN_TIMEOUT_MS, options = {}) {
    let originalMode = 'accepting';
    let froze = false;
    setStatus('waiting-for-idle');
    try {
      await withDaemon(ipcPath, async (client) => {
        const health = await client.request('health.ping', {});
        originalMode = health?.dispatch?.mode ?? 'accepting';
        if (originalMode === 'accepting') {
          await client.request('daemon.freeze', {});
          froze = true;
        }
        const drain = await client.request('daemon.drain', { timeout_ms: timeoutMs }, timeoutMs + 5_000);
        if (!drain?.drained) {
          if (froze) await client.request('daemon.thaw', {});
          throw Object.assign(fail(ERRORS.busy, `still busy after ${timeoutMs}ms`), {
            blocking: {
              tasks: drain?.activeTasks ?? [],
              workflows: drain?.activeWorkflows ?? [],
              executions: drain?.activeExecutions ?? [],
            },
          });
        }
      }, 2000);
    } catch (error) {
      if (error.code === ERRORS.busy) throw error;
      throw fail(ERRORS.internal, `cannot confirm daemon activity: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.ignoreDesktop !== true) {
      const desktopActivity = await readDesktopActivity();
      if (desktopActivity.known === false || desktopActivity.busy) {
        if (froze && originalMode === 'accepting') {
          try {
            await withDaemon(ipcPath, (client) => client.request('daemon.thaw', {}), 2000);
          } catch {
            // Admission restoration is best-effort after a desktop busy timeout.
          }
        }
        throw fail(ERRORS.busy, desktopActivity.known === false
          ? 'cannot confirm Desktop activity; treating as busy'
          : 'Desktop still has an active conversation or tool call');
      }
    }
    return { froze, originalMode };
  }

  async function restoreAdmission(token) {
    if (!token?.froze || token.originalMode !== 'accepting') return;
    try {
      await withDaemon(ipcPath, (client) => client.request('daemon.thaw', {}), 2000);
    } catch {
      // New daemon starts accepting by default.
    }
  }

  async function stopDaemon() {
    try {
      await withDaemon(ipcPath, (client) => client.request('daemon.shutdown', { reason: 'source development supervisor' }), 2000);
    } catch {
      // Process stop below is the fallback.
    }
    if (daemon) await stopChild(daemon);
    daemon = null;
    try {
      await waitForIpcDown(8_000);
    } catch (error) {
      throw error;
    }
  }

  async function startDaemon() {
    mkdirSync(logs, { recursive: true });
    daemon = spawnDaemonProcess({
      checkout,
      configPath,
      nodeExecutable,
      exists,
      platform,
      env,
      resolved: resolvedPaths(),
      logPath: componentLogPath(logs, 'daemon'),
    });
    daemon.on('exit', (code, signal) => {
      if (stopping) return;
      onComponentExit('daemon', code, signal);
    });
    persist();
    await waitForSourceDaemon();
  }

  async function startDesktop() {
    desktopStoppedByUser = false;
    desktop = spawnDesktopProcess({
      checkout,
      nodeExecutable,
      exists,
      platform,
      env,
      resolved: resolvedPaths(),
      logPath: componentLogPath(logs, 'desktop'),
    });
    desktop.on('exit', (code, signal) => {
      desktopSession = null;
      if (stopping) return;
      if (code === 0 && !signal) {
        desktopStoppedByUser = true;
        logger.info('desktop-stopped', `Desktop exited cleanly (pid was ${desktop?.pid ?? 'unknown'}). Supervisor and daemon stay running. Use pnpm dev:restart to restore the window.`);
        desktop = null;
        persist({ desktopPid: null });
        return;
      }
      onComponentExit('desktop', code, signal);
    });
    persist();
    const deadline = Date.now() + (options.desktopReadyMs ?? 45_000);
    while (Date.now() < deadline) {
      if (desktopSession) return;
      if (!desktop || desktop.exitCode != null) {
        throw fail(ERRORS.internal, `Desktop exited before registering with the supervisor (code ${desktop?.exitCode ?? 'unknown'})`);
      }
      await sleep(200);
    }
    throw fail(ERRORS.internal, 'Desktop did not register with the supervisor');
  }

  function onComponentExit(name, code, signal) {
    if (stopping) return;
    setStatus('degraded', `${name} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
    const count = retries[name] ?? 0;
    if (count >= COMPONENT_RETRY_LIMIT) {
      logger.error('retry-exhausted', `${name} exceeded ${COMPONENT_RETRY_LIMIT} restarts`);
      return;
    }
    const delay = COMPONENT_RETRY_BACKOFF_MS[Math.min(count, COMPONENT_RETRY_BACKOFF_MS.length - 1)];
    retries[name] = count + 1;
    logger.warn('retry', `${name} restart in ${delay}ms (attempt ${count + 1}/${COMPONENT_RETRY_LIMIT})`);
    setTimeout(() => {
      if (stopping || requests.pendingStop) return;
      void (name === 'daemon' ? startDaemon() : startDesktop()).then(() => {
        retries[name] = 0;
        if (daemon && (desktop || desktopStoppedByUser)) setStatus('ready');
      }).catch((error) => {
        logger.error('retry-failed', error instanceof Error ? error.message : String(error));
      });
    }, delay).unref?.();
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
    logger.info('switching', 'Installed Wrenyard is running; switching to the source environment');
    const token = await freezeAndDrain(DRAIN_TIMEOUT_MS, { ignoreDesktop: true });
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
        const token = await freezeAndDrain();
        if (needsDesktop) await quitDesktop();
        if (needsDaemon) await stopDaemon();
        if (needsDaemon) await startDaemon();
        if (needsDesktop && !desktopStoppedByUser) {
          await startDesktop();
          await restoreDesktopUi(ui);
        }
        await restoreAdmission(token);
      }
      queue.finishApply(generation, true);
      return { applied: true, action: needsDaemon ? 'restart-stack' : needsDesktop ? 'restart-desktop' : 'noop' };
    } catch (error) {
      queue.finishApply(generation, false);
      throw error;
    }
  }

  async function runBuildAndApply(reason) {
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
    if (queue.isStale(generation)) {
      logger.info('stale-generation', `${generation.id} skipped because a newer generation exists`);
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
    setStatus('restarting');
    return withBuildLock(async () => {
      const pending = queue.pending ?? queue.building;
      if (queue.pending || queue.building) {
        await runBuildAndApply('restart');
      }
      const generation = queue.current ?? pending ?? { id: 'explicit', components: [COMPONENTS.daemon, COMPONENTS.desktopMain], files: [] };
      desktopStoppedByUser = false;
      const applied = await applyGeneration({
        ...generation,
        components: [COMPONENTS.daemon, COMPONENTS.desktopMain, COMPONENTS.desktopPreload, COMPONENTS.renderer],
        artifacts: { runtimeBin: currentRuntimeBin },
      }, 'restart');
      if (!applied.applied && applied.reason === 'busy') throw fail(ERRORS.busy, 'restart waiting for idle work timed out');
      setStatus('ready');
      return snapshot();
    });
  }

  async function explicitStop() {
    stopping = true;
    setStatus('stopping');
    buildAbort?.abort();
    await buildLock.catch(() => undefined);
    watcher?.close();
    watcher = null;
    try {
      const health = await pingDaemon().catch(() => null);
      if (health) await freezeAndDrain();
    } catch (error) {
      stopping = false;
      throw error;
    }
    await quitDesktop();
    await stopDaemon();
    setStatus('stopped');
    try {
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
        desktopSession = session;
      }
      return { ok: true, instanceId, status };
    },
    async 'component.event'(params) {
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
    try {
      await handoverInstalled();
    } catch (error) {
      server?.close();
      throw error;
    }

    setStatus('starting');
    await startDaemon();
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
    printReady();
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
  };
}

export { sourceChildEnv };
