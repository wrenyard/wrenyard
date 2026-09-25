import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildTargets, checkToolchain, typecheckDaemon } from './build.mjs';
import { withDaemon } from './ipc.mjs';
import { acquireDevLock, readDaemonLock, readDevLock, releaseDevLock } from './locks.mjs';
import { businessIpcPath, configDir, daemonLockPath, desktopUserData, devLockPath, logDir, stateRoot } from './paths.mjs';
import { daemonInvocation, electronDesktopInvocation, sourceCliInvocation } from './spawn.mjs';
import { COMPONENTS, createWatcher } from './watch.mjs';

const checkout = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const platform = process.platform;
const env = process.env;
const nodeExecutable = process.execPath;
const print = (line) => process.stdout.write(`${line}\n`);

const PING_MS = 250, READY_TIMEOUT_MS = 60_000, RPC_TIMEOUT_MS = 2_000, IDLE_POLL_MS = 1_000;
const IDLE_NOTICE_MS = 60_000, SHUTDOWN_TIMEOUT_MS = 5_000, DRAIN_NOTICE_MS = 30_000;
const DESKTOP_TERM_MS = 10_000, DESKTOP_KILL_MS = 2_000, SINGLE_INSTANCE_MS = 5_000;
const BUILD_TAIL = 40, STARTUP_TAIL = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error) => (error instanceof Error ? error.message : String(error));
const childHasExited = (child) => !child || child.exitCode != null || child.signalCode != null;
const tail = (text, count) => String(text ?? '').split('\n').slice(-count).join('\n');
const fileTail = (path, count) => { try { return tail(readFileSync(path, 'utf8'), count); } catch { return ''; } };

function waitExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    if (childHasExited(child)) finish(true);
  });
}

// Single-process source-development supervisor (specification section 4).
// `pnpm dev` calls this once; it owns the watcher, the build/restart loop and the
// daemon and Desktop children until the first SIGINT/SIGTERM.
export async function runDev() {
  const state = stateRoot(), logs = logDir(state), devLock = devLockPath(state), daemonLock = daemonLockPath(state);
  const ipcPath = businessIpcPath(), configPath = join(configDir(), 'config.json'), userData = desktopUserData();
  const daemonLog = join(logs, 'daemon.log'), desktopLog = join(logs, 'desktop.log');
  const pending = new Set();
  const carry = new Set();
  let busy = false, stopping = false, forced = false, bootComplete = false;
  let watcher = null, workAbort = null, daemonState = null, desktopState = null, devLockHeld = false, finishRun;
  const finished = new Promise((resolve) => { finishRun = resolve; });
  function releaseLock() {
    if (!devLockHeld) return;
    devLockHeld = false;
    try { releaseDevLock(devLock); } catch { /* never throw on exit */ }
  }
  function attachLog(child, path) {
    try {
      const stream = createWriteStream(path, { flags: 'a' });
      child.stdout?.pipe(stream, { end: false });
      child.stderr?.pipe(stream, { end: false });
      child.on('close', () => stream.end());
    } catch { /* logging must not prevent spawning */ }
  }
  function childEnv() {
    const cli = sourceCliInvocation(checkout, []);
    const value = {
      ...env,
      WRENYARD_SOURCE_DEV: '1',
      WRENYARD_DEV_SUPERVISED: '1',
      WRENYARD_SOURCE_CHECKOUT: checkout,
      WRENYARD_ROOT: checkout,
      WRENYARD_CLI: [cli.command, ...cli.args].join(' '),
      WRENYARD_NODE_BIN: nodeExecutable,
      WRENYARD_DESKTOP_BIN: [nodeExecutable, join(checkout, 'apps', 'desktop')].join(' '),
      WRENYARD_DESKTOP_USER_DATA: userData,
      WRENYARD_IPC_PATH: ipcPath,
    };
    for (const key of ['WRENYARD_DEV_INSTANCE_ID', 'WRENYARD_DEV_LAUNCH_ID', 'WRENYARD_DEV_CONTROL']) delete value[key];
    return value;
  }
  const pingDaemon = (ms) => withDaemon(ipcPath, (client) => client.request('health.ping', {}, ms), ms);
  const daemonStatus = (ms = RPC_TIMEOUT_MS) => withDaemon(ipcPath, (client) => client.request('daemon.status', {}, ms), ms);
  function withAbort(fn) {
    const controller = new AbortController();
    workAbort = controller;
    return fn(controller.signal).finally(() => { if (workAbort === controller) workAbort = null; });
  }
  async function waitForDaemonIdle() {
    if (stopping || !daemonState || childHasExited(daemonState.child)) return;
    let lastNotice = 0;
    while (!stopping) {
      let status;
      try { status = await daemonStatus(); } catch { return; } // IPC unreachable: stopDaemon owns it
      const tasks = Number(status?.activeTaskCount ?? 0);
      const workflows = Number(status?.activeWorkflowCount ?? 0);
      const executions = Number(status?.activeExecutionCount ?? 0);
      const idle = typeof status?.idle === 'boolean' ? status.idle : tasks === 0 && workflows === 0 && executions === 0;
      if (idle) return;
      if (Date.now() - lastNotice >= IDLE_NOTICE_MS) {
        lastNotice = Date.now();
        print(`Waiting for active work to finish before restarting (tasks ${tasks}, workflows ${workflows}, executions ${executions}; conversations and task graphs also count).`);
      }
      await sleep(IDLE_POLL_MS);
    }
  }
  function daemonStartupError(child) {
    return new Error(`Daemon exited during startup (code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'}). Last lines of ${daemonLog}:\n${fileTail(daemonLog, STARTUP_TAIL)}`);
  }
  async function startDaemon() {
    if (stopping) return;
    mkdirSync(logs, { recursive: true });
    const invocation = daemonInvocation(checkout, configPath);
    const child = spawnProcess(invocation.command, invocation.args, { cwd: invocation.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    attachLog(child, daemonLog);
    const track = { child, expected: false, starting: true };
    daemonState = track;
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
      if (daemonState === track) daemonState = null;
    });
    child.once('exit', (code, signal) => onDaemonExit(track, code, signal));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Daemon failed to start: ${message(spawnError)}`);
      if (stopping) return;
      if (childHasExited(child)) throw daemonStartupError(child);
      try {
        const health = await pingDaemon(RPC_TIMEOUT_MS);
        if (health?.ok === true && health?.identity?.mode === 'source') { track.starting = false; return; }
      } catch { /* keep polling until the deadline */ }
      await sleep(PING_MS);
    }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await waitExit(child, DESKTOP_KILL_MS);
    throw daemonStartupError(child);
  }
  function onDaemonExit(track, code, signal) {
    if (daemonState === track) daemonState = null;
    if (track.starting || track.expected || stopping) return;
    if (code === 0 && !signal) {
      print('Daemon exited cleanly (requested outside pnpm dev); starting it again.');
      startDaemon()
        .then(() => print(`Daemon is back (pid ${daemonState?.child?.pid ?? '—'}).`))
        .catch((error) => print(`${message(error)}\nDaemon restart failed; save a file or rerun pnpm dev to retry.`));
      return;
    }
    print(`Daemon exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
    const text = fileTail(daemonLog, STARTUP_TAIL);
    if (text) print(text);
  }
  async function stopDaemon() {
    const track = daemonState;
    if (!track || childHasExited(track.child)) { daemonState = null; return; }
    track.expected = true;
    if (stopping && track.starting) {
      try { track.child.kill('SIGTERM'); } catch { /* gone */ }
      if (!(await waitExit(track.child, SHUTDOWN_TIMEOUT_MS))) {
        try { track.child.kill('SIGKILL'); } catch { /* gone */ }
        await waitExit(track.child, DESKTOP_KILL_MS);
      }
      if (!childHasExited(track.child)) throw new Error(`Cannot stop starting daemon; pid ${track.child.pid ?? 'unknown'} was left running.`);
      return;
    }
    try {
      await withDaemon(ipcPath, (client) => client.request('daemon.shutdown', { reason: 'pnpm dev restart' }, SHUTDOWN_TIMEOUT_MS), SHUTDOWN_TIMEOUT_MS);
    } catch {
      if (!childHasExited(track.child)) {
        track.expected = false;
        throw new Error(`Cannot request a graceful daemon shutdown; pid ${track.child.pid ?? 'unknown'} was left running.`);
      }
    }
    let lastNotice = Date.now();
    while (!childHasExited(track.child)) {
      await sleep(200);
      if (Date.now() - lastNotice >= DRAIN_NOTICE_MS) { lastNotice = Date.now(); print('Daemon is still draining active work.'); }
    }
    if (daemonState === track) daemonState = null;
  }

  function onDesktopExit(track, code) {
    if (desktopState === track) desktopState = null;
    if (track.starting || track.expected || stopping) return;
    print(`Desktop exited (code ${code ?? 'none'}).`);
    if (Date.now() - track.startedAt < SINGLE_INSTANCE_MS) {
      print('Another 啾啾工坊 may be running (Desktop is single-instance). Quit it, then save a file or rerun pnpm dev.');
    }
  }

  async function startDesktop() {
    if (stopping) return;
    const invocation = electronDesktopInvocation(checkout);
    const desktopEnv = childEnv();
    delete desktopEnv.ELECTRON_RUN_AS_NODE;
    const child = spawnProcess(invocation.command, invocation.args, { cwd: invocation.cwd, env: desktopEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, shell: false });
    attachLog(child, desktopLog);
    const track = { child, expected: false, starting: true, startedAt: 0 };
    desktopState = track;
    child.once('exit', (code) => onDesktopExit(track, code));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    track.starting = false;
    track.startedAt = Date.now();
  }

  function runProcess(command, args, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: 'ignore' });
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(); }, timeoutMs);
      child.on('error', done);
      child.on('close', done);
    });
  }

  async function stopDesktop() {
    const track = desktopState;
    if (!track || childHasExited(track.child)) { desktopState = null; return; }
    track.expected = true;
    const child = track.child;
    if (platform === 'win32') {
      await runProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], DESKTOP_TERM_MS);
      await waitExit(child, DESKTOP_TERM_MS);
    } else {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      if (!(await waitExit(child, DESKTOP_TERM_MS))) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        await waitExit(child, DESKTOP_KILL_MS);
      }
    }
    if (desktopState === track) desktopState = null;
  }

  async function applyChange(components) {
    if (stopping) return;
    const daemonAffected = components.has(COMPONENTS.daemon) || components.has(COMPONENTS.shared);
    await withAbort(async (signal) => {
      await buildTargets({ checkout, components, signal });
      if (daemonAffected) await typecheckDaemon({ checkout, signal });
    });
    if (stopping) return;
    if (daemonAffected) {
      await waitForDaemonIdle();
      if (stopping) return;
      await stopDaemon();
      await stopDesktop();
      await startDaemon();
      await startDesktop();
      print(`Restarted daemon (pid ${daemonState?.child?.pid ?? '—'}) and Desktop (pid ${desktopState?.child?.pid ?? '—'}).`);
    } else {
      await stopDesktop();
      await startDesktop();
      print(`Restarted Desktop (pid ${desktopState?.child?.pid ?? '—'}).`);
    }
  }

  async function processChanges() {
    if (busy || stopping) return;
    busy = true;
    try {
      while (!stopping && pending.size > 0) {
        await waitForDaemonIdle();
        if (stopping) break;
        const components = new Set([...carry, ...pending]);
        pending.clear();
        carry.clear();
        try {
          await applyChange(components);
        } catch (error) {
          for (const component of components) carry.add(component);
          print(`Restart failed: ${message(error)}\n${daemonState && !childHasExited(daemonState.child) ? 'The daemon is still running' : 'The daemon is not running'}; fix the source and save to retry.`);
        }
      }
    } finally {
      busy = false;
    }
  }

  function handleChange(files, components) {
    const restart = new Set();
    for (const component of components) {
      if (component === COMPONENTS.cli) print('CLI runs from source on every invocation; no restart needed.');
      else if (component === COMPONENTS.tooling) print(`${files.join(', ')} changed; restart pnpm dev to load it.`);
      else if (component === COMPONENTS.manifest) print('Dependencies changed; stop pnpm dev, run pnpm install --frozen-lockfile, then run pnpm dev.');
      else restart.add(component);
    }
    if (restart.size === 0) return;
    for (const component of restart) pending.add(component);
    if (bootComplete) void processChanges();
  }

  function gitShortSha() {
    try {
      const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true, shell: false });
      return result.status === 0 ? result.stdout.trim() || 'unknown' : 'unknown';
    } catch { return 'unknown'; }
  }

  function printReady(status) {
    print([
      `ready: ${checkout}`,
      `revision: ${gitShortSha()}`,
      `daemon pid: ${daemonState?.child?.pid ?? '—'}`,
      `desktop pid: ${desktopState?.child?.pid ?? '—'}`,
      `ipc: ${ipcPath}`,
      `logs: ${logs}`,
      'Edits restart the stack when the daemon is idle; stop with Ctrl+C.',
    ].join('\n'));
    if (status?.mode && status.mode !== 'accepting') print(`Dispatch is ${status.mode}; run "wrenyard daemon thaw" if that is left over.`);
  }

  async function detectRunningDaemon() {
    let health = null;
    try { health = await pingDaemon(1500); } catch { /* a live lock still counts */ }
    const lock = readDaemonLock(daemonLock);
    if (lock) return { pid: lock.pid, mode: lock.mode };
    return health ? { pid: 'unknown', mode: health.identity?.mode ?? 'unknown' } : null;
  }

  async function shutdown() {
    stopping = true;
    try { watcher?.close(); } catch { /* ignore */ }
    watcher = null;
    workAbort?.abort();
    print('Stopping; waiting for active work to finish (Ctrl+C again to force).');
    let daemonLeft = false;
    try { await stopDaemon(); } catch (error) { daemonLeft = true; print(message(error)); }
    try { await stopDesktop(); } catch (error) { print(message(error)); }
    releaseLock();
    finishRun(daemonLeft ? 1 : 0);
  }

  function onSignal() {
    if (!stopping) { void shutdown(); return; }
    if (forced) return;
    forced = true;
    print('Forcing daemon shutdown; further signals are ignored.');
    withDaemon(ipcPath, (client) => client.request('daemon.shutdown', { reason: 'pnpm dev forced stop', force: true }, SHUTDOWN_TIMEOUT_MS), SHUTDOWN_TIMEOUT_MS).catch(() => {});
  }

  process.on('exit', releaseLock);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const toolErrors = checkToolchain({ checkout });
  if (toolErrors.length > 0) {
    print(toolErrors.join('\n'));
    print('Run: pnpm install --frozen-lockfile');
    return 1;
  }
  const holder = readDevLock(devLock);
  if (holder) {
    print(`pnpm dev is already running (pid ${holder.pid}, checkout ${holder.checkout}). Stop it with Ctrl+C in its terminal first.`);
    return 1;
  }
  try {
    const cliInvocation = sourceCliInvocation(checkout, []);
    acquireDevLock(devLock, { pid: process.pid, checkout, startedAt: new Date().toISOString(), cli: [cliInvocation.command, ...cliInvocation.args] });
    devLockHeld = true;
  } catch (error) {
    print(message(error));
    return 1;
  }
  const running = await detectRunningDaemon();
  if (stopping) return finished;
  if (running) {
    releaseLock();
    print(`A Wrenyard daemon is already running (pid ${running.pid}, ${running.mode}). Quit 啾啾工坊 completely (tray → Quit) or run "wrenyard daemon stop", then run pnpm dev again.`);
    return 1;
  }
  mkdirSync(logs, { recursive: true });
  writeFileSync(daemonLog, '');
  watcher = createWatcher({ checkout, onChange: ({ files, components }) => handleChange(files, components) });

  let initialBuildOk = true;
  try {
    await withAbort((signal) => buildTargets({ checkout, components: new Set([COMPONENTS.shared]), signal }));
  } catch (error) {
    initialBuildOk = false;
    print(message(error));
    const text = tail(error?.output, BUILD_TAIL);
    if (text) print(text);
    for (const component of [COMPONENTS.shared, COMPONENTS.daemon, COMPONENTS.desktopRenderer, COMPONENTS.desktopMain, COMPONENTS.desktopPreload]) carry.add(component);
    print('Initial build failed; the watcher stays up. Fix the source and save to retry.');
  }
  if (stopping) return finished;
  if (initialBuildOk) {
    try {
      await startDaemon();
      if (stopping) return finished;
      const status = await daemonStatus().catch(() => null);
      if (stopping) return finished;
      await startDesktop();
      if (stopping) return finished;
      printReady(status);
    } catch (error) {
      if (stopping) return finished;
      print(message(error));
      print('Startup failed; the watcher stays up. Fix the source and save to retry.');
    }
  }
  bootComplete = true;
  await processChanges();
  return finished;
}
