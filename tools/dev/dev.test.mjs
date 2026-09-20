import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPath, classifyPaths, expandDependents, isRendererOnly, shouldIgnore, COMPONENTS } from './lib/graph.mjs';
import { createGenerationQueue } from './lib/queue.mjs';
import { createRequestQueue } from './lib/requests.mjs';
import { spawnArgv, quoteCmdArg, windowsCmdInvocation, electronInvocation, electronDesktopInvocation, resolveElectronExecutable, sourceCliInvocation } from './lib/spawn.mjs';
import { stopOwnedTree, stopOwnedDesktopTree, stopChild, childHasExited, waitForChildExit } from './lib/children.mjs';
import { healthyComponentStatus, restoredStatus } from './lib/supervisor.mjs';
import { normalizeCheckout, sameCheckout, pathInside, desktopUserData, controlEndpoint, businessIpcPath, defaultRuntimeBin } from './lib/paths.mjs';
import { sourceChildEnv, isSourceDevelopment } from './lib/env.mjs';
import { combineActivity } from './lib/activity.mjs';
import { daemonBusy, sourceIdentityFromHealth } from './lib/rpc.mjs';
import { checkBuildArtifacts, checkToolchain } from './lib/prepare.mjs';
import { processAlive, parseInstanceRecord, createInstanceRecord } from './lib/identity.mjs';
import { describePeer, readInstanceFile, writeInstanceFile } from './lib/instance.mjs';
import { attachHandler, connectControl, listenControl } from './lib/control.mjs';
import { ERRORS } from './lib/protocol.mjs';
import { shouldRedact } from './lib/log.mjs';
import { buildGeneration, desktopTargetsFor } from './lib/builder.mjs';
import { leftoverControlDecision } from './lib/leftover.mjs';
import { createWatcher } from './lib/watcher.mjs';
import { EXIT } from './lib/constants.mjs';
import {
  RELEASE_DESKTOP_KILL_WARNING,
  RELEASE_DESKTOP_RUNNING_MESSAGE,
  createInspectReleaseDesktop,
  createTerminateReleaseDesktop,
  gateReleaseDesktop,
  matchReleaseDesktopProcesses,
  parseCimProcessJson,
  parseDevArgs,
  parsePsProcesses,
  resolveInstalledDesktopRoots,
  sameProcessIdentity,
  taskkillAlreadyGone,
  treeRoots,
} from './lib/release-desktop.mjs';

test('Windows checkout comparison folds case and separators', () => {
  assert.equal(
    sameCheckout('D:\\GitHub\\wrenyard', 'd:/github/wrenyard', 'win32'),
    true,
  );
  assert.equal(
    sameCheckout('/Users/a/wrenyard', '/Users/b/wrenyard', 'darwin'),
    false,
  );
});

test('control and business IPC stay on distinct endpoints', () => {
  assert.equal(controlEndpoint('win32', 'C:\\\\state'), '\\\\.\\pipe\\wrenyard-dev');
  assert.equal(businessIpcPath('win32', {}), '\\\\.\\pipe\\wrenyard');
  assert.notEqual(controlEndpoint('linux', '/state'), businessIpcPath('linux', {}));
});

test('desktop userData follows the installed package identity, not the display brand', () => {
  assert.equal(
    desktopUserData('win32', { APPDATA: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming' }, 'C:\\\\Users\\\\me'),
    join('C:\\\\Users\\\\me\\\\AppData\\\\Roaming', '@wrenyard/desktop'),
  );
  assert.equal(
    desktopUserData('darwin', {}, '/Users/me'),
    join('/Users/me', 'Library', 'Application Support', '@wrenyard/desktop'),
  );
});

test('Windows .cmd is wrapped through ComSpec and never uses shell:true argv', () => {
  const invocation = spawnArgv('C:\\\\Program Files\\\\pnpm.cmd', ['restart', 'with space'], 'win32', { ComSpec: 'C:\\\\Windows\\\\system32\\\\cmd.exe' });
  assert.equal(invocation.command, 'C:\\\\Windows\\\\system32\\\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /pnpm\.cmd/);
  assert.equal(quoteCmdArg('with space'), '"with space"');
  const cmd = windowsCmdInvocation('a.cmd', ['b']);
  assert.equal(cmd.args[0], '/d');
});

test('electron and CLI invocations never point at dist or .cmd shims', () => {
  const electron = electronInvocation('D:/src', 'C:/node.exe', (path) => path.replaceAll('\\', '/').endsWith('apps/desktop/node_modules/electron/cli.js'));
  assert.equal(electron.command, 'C:/node.exe');
  assert.equal(electron.args[0].includes('cli.js'), true);
  assert.equal(electron.args.some((arg) => arg.endsWith('.cmd')), false);
  const cli = sourceCliInvocation('D:/src', ['daemon', 'stop'], 'C:/node.exe', (path) => {
    const normalized = path.replaceAll('\\', '/');
    return normalized.endsWith('tsx/dist/cli.mjs') || normalized.endsWith('apps/cli/src/index.ts') || normalized.endsWith('/tsx');
  });
  assert.equal(cli.args.some((arg) => arg.includes('apps/cli/dist')), false);
  assert.equal(cli.args.some((arg) => arg.replaceAll('\\', '/').endsWith('apps/cli/src/index.ts')), true);
});

test('watcher classification ignores output dirs and maps shared packages to Desktop consumers', () => {
  assert.equal(shouldIgnore('apps/desktop/dist/main.js'), true);
  assert.equal(shouldIgnore('node_modules/tsx/index.js'), true);
  assert.equal(shouldIgnore('.git/HEAD'), true);
  assert.deepEqual(classifyPath('apps/desktop/src/renderer/app.css'), [COMPONENTS.renderer]);
  assert.deepEqual(classifyPath('apps/desktop/src/main.ts'), [COMPONENTS.desktopMain]);
  assert.deepEqual(classifyPath('apps/desktop/src/preload.ts'), [COMPONENTS.desktopPreload]);
  assert.deepEqual(classifyPath('apps/pet/src/overlay/house/index.ts'), [COMPONENTS.pet]);
  assert.deepEqual(classifyPath('packages/dsh-shell/src/index.ts'), [COMPONENTS.shared]);
  assert.deepEqual(classifyPath('services/foreman/lib/daemon/daemon.mts'), [COMPONENTS.daemon]);
  assert.deepEqual(classifyPath('runtime/forge/cmd/forge/main.go'), [COMPONENTS.runtime]);
  assert.deepEqual(classifyPath('apps/cli/src/index.ts'), [COMPONENTS.cli]);
  assert.deepEqual(classifyPath('tools/dev/run.mjs'), [COMPONENTS.supervisor]);
  assert.deepEqual(classifyPath('pnpm-lock.yaml'), [COMPONENTS.manifest]);
  const expanded = expandDependents(classifyPaths(['packages/catalog/src/index.ts', 'apps/pet/src/main/runtime.ts']));
  assert.equal(expanded.includes(COMPONENTS.desktopMain), true);
  assert.equal(expanded.includes(COMPONENTS.renderer), true);
  assert.equal(isRendererOnly([COMPONENTS.renderer]), true);
  assert.equal(isRendererOnly([COMPONENTS.renderer, COMPONENTS.desktopMain]), false);
  assert.deepEqual(desktopTargetsFor([COMPONENTS.renderer]), ['renderer']);
});

test('generation queue never applies a stale build over a newer one', () => {
  const queue = createGenerationQueue({ initialSeq: 0, now: () => 1 });
  queue.enqueue(['renderer'], ['a.css']);
  const first = queue.takeBuild();
  queue.enqueue(['renderer'], ['b.css']);
  const firstDone = queue.completeBuild(first, { ok: true });
  assert.equal(firstDone.stale, false);
  assert.equal(queue.isStale(first), true);
  assert.equal(queue.beginApply(first), false);
  const second = queue.takeBuild();
  queue.completeBuild(second, { ok: true });
  assert.equal(queue.beginApply(second), true);
  queue.finishApply(second, true);
  assert.equal(queue.current.id, second.id);
});

test('build failure keeps the previous generation and does not apply', () => {
  const queue = createGenerationQueue();
  queue.enqueue(['daemon'], ['x.ts']);
  const gen = queue.takeBuild();
  const result = queue.completeBuild(gen, { ok: false, error: 'boom' });
  assert.equal(result.failed, true);
  assert.equal(queue.current, null);
});

test('concurrent restarts merge and stop cancels a pending restart', async () => {
  const queue = createRequestQueue();
  const first = queue.submit('restart');
  const second = queue.submit('restart');
  const stop = queue.submit('stop');
  assert.equal(queue.take(), 'stop');
  queue.finish({ ok: true, result: { stopped: true } });
  await assert.rejects(first, /cancelled/);
  await assert.rejects(second, /cancelled/);
  assert.deepEqual(await stop, { ok: true, result: { stopped: true } });
});

test('source child env overwrites inherited install paths but keeps user data homes', () => {
  const env = sourceChildEnv({
    WRENYARD_CLI: 'C:\\\\Program Files\\\\wrenyard\\\\wrenyard.exe',
    WRENYARD_RUNTIME_BIN: 'C:\\\\installed\\\\forge.exe',
    WRENYARD_NODE_BIN: 'C:\\\\installed\\\\node.exe',
    WRENYARD_DESKTOP_BIN: 'C:\\\\installed\\\\wrenyard-desktop.exe',
    WRENYARD_STATE_HOME: 'D:\\\\state',
    WRENYARD_CONFIG_HOME: 'D:\\\\config',
    PATH: 'C:\\\\installed',
  }, {
    instanceId: 'abc',
    checkout: 'D:\\\\GitHub\\\\wrenyard',
    cli: 'node tsx apps/cli/src/index.ts',
    nodeBin: 'C:\\\\nodejs\\\\node.exe',
    runtimeBin: 'D:\\\\GitHub\\\\wrenyard\\\\runtime\\\\forge\\\\.dev-gen\\\\g1\\\\forge.exe',
    desktopBin: 'node electron-cli apps/desktop',
    controlEndpoint: '\\\\.\\pipe\\wrenyard-dev',
    userData: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\啾啾工坊',
    ipcPath: '\\\\.\\pipe\\wrenyard',
  });
  assert.equal(env.WRENYARD_SOURCE_DEV, '1');
  assert.equal(env.WRENYARD_CLI.includes('apps/cli/src/index.ts'), true);
  assert.equal(env.WRENYARD_RUNTIME_BIN.includes('.dev-gen'), true);
  assert.equal(env.WRENYARD_DESKTOP_BIN.includes('wrenyard-desktop.exe'), false);
  assert.equal(env.WRENYARD_STATE_HOME, 'D:\\\\state');
  assert.equal(env.WRENYARD_CONFIG_HOME, 'D:\\\\config');
  assert.equal(isSourceDevelopment(env), true);
});

test('unknown daemon or desktop activity is treated as busy', () => {
  assert.equal(daemonBusy(null).busy, true);
  assert.equal(daemonBusy({ ok: true }).busy, true);
  assert.equal(daemonBusy({ dispatch: { activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 } }).busy, false);
  assert.equal(combineActivity({ daemonHealth: { dispatch: { activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 } }, desktopActivity: { known: false } }).busy, true);
  assert.equal(combineActivity({
    daemonHealth: { dispatch: { activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 } },
    desktopActivity: { known: true, streaming: true },
  }).busy, true);
  assert.equal(combineActivity({
    daemonHealth: { dispatch: { activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 } },
    desktopActivity: { known: true, streaming: false, running: false },
  }).busy, false);
});

test('health identity distinguishes source from installed even when a service is healthy', () => {
  assert.deepEqual(sourceIdentityFromHealth({ ok: true, uptimeMs: 12 }), { mode: 'installed', verified: false });
  const source = sourceIdentityFromHealth({
    ok: true,
    identity: { mode: 'source', checkout: '/src', instanceId: '1', node: '/node' },
  });
  assert.equal(source.mode, 'source');
  assert.equal(source.instanceId, '1');
});

test('PID liveness is not treated as ownership by itself', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(1_000_000_000), false);
  const parsed = parseInstanceRecord({ version: 1, instanceId: 'x', checkout: '/src', controlEndpoint: 'sock' });
  assert.equal(parsed.instanceId, 'x');
  assert.equal(parseInstanceRecord({ version: 2, instanceId: 'x', checkout: '/src', controlEndpoint: 'sock' }), null);
});

test('instance metadata lives under the state root and does not describe a lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-dev-instance-'));
  const path = join(dir, 'instance.json');
  writeInstanceFile(path, createInstanceRecord({
    instanceId: 'id1',
    checkout: '/src',
    controlEndpoint: 'sock',
    platform: 'linux',
  }));
  const record = readInstanceFile(path);
  assert.equal(record.mode, 'source-development');
  assert.equal(describePeer(record, '/other', () => false).kind, 'other-checkout');
  assert.equal(describePeer(record, '/src', () => true).kind, 'same-checkout');
  rmSync(dir, { recursive: true, force: true });
});

test('Windows prepare copies a bare forge binary to forge.exe', () => {
  const copied = [];
  const artifacts = checkBuildArtifacts({
    checkout: '/src',
    platform: 'win32',
    exists: (path) => {
      const normalized = path.replaceAll('\\', '/');
      return normalized.endsWith('apps/desktop/dist/main.js')
        || normalized.endsWith('electron/cli.js')
        || (normalized.endsWith('runtime/forge/bin/forge') && !normalized.endsWith('.exe'));
    },
    copyFile: (from, to) => {
      copied.push([from.replaceAll('\\', '/'), to.replaceAll('\\', '/')]);
    },
  });
  assert.equal(copied.length, 1);
  assert.equal(copied[0][1].endsWith('forge.exe'), true);
  assert.equal(artifacts.runtimeBin.replaceAll('\\', '/').endsWith('forge.exe'), true);
  assert.equal(artifacts.errors.length, 0);
});

test('prepare fails closed when Electron or the Windows runtime exe is missing', () => {
  const tool = checkToolchain({ checkout: '/missing', exists: () => false, nodeVersion: '20.0.0' });
  assert.equal(tool.some((item) => item.includes('Node')), true);
  const artifacts = checkBuildArtifacts({
    checkout: '/src',
    platform: 'win32',
    exists: (path) => path.endsWith('forge') && !path.endsWith('.exe'),
  });
  assert.equal(artifacts.errors.some((item) => item.includes('.exe') || item.includes('runtime')), true);
  const electronMissing = checkBuildArtifacts({
    checkout: '/src',
    platform: 'darwin',
    exists: (path) => path.endsWith('main.js') || path.endsWith('forge'),
  });
  assert.equal(electronMissing.errors.some((item) => item.includes('Electron')), true);
});

test('Windows Go generation path uses an .exe that is not the running bin/forge.exe', () => {
  const found = defaultRuntimeBin('/src', 'win32', (path) => path.replaceAll('\\', '/').endsWith('runtime/forge/bin/forge.exe'));
  assert.equal(found.replaceAll('\\', '/').endsWith('forge.exe'), true);
});

test('logs redact tokens', () => {
  assert.equal(shouldRedact('Authorization: Bearer abc.def'), true);
  assert.equal(shouldRedact('build succeeded renderer'), false);
});

test('control server serializes requests over a local socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-dev-control-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\wrenyard-dev-test-${process.pid}`
    : join(dir, 'control.sock');
  const server = await listenControl(endpoint, { platform: process.platform });
  attachHandler(server, {
    async status() {
      return { checkout: '/src', status: 'ready' };
    },
    async restart() {
      return { ok: true, restarted: true };
    },
  });
  const client = await connectControl(endpoint);
  assert.equal((await client.request('status')).status, 'ready');
  assert.equal((await client.request('restart')).restarted, true);
  await assert.rejects(client.request('nope'), (error) => error.code === ERRORS.method);
  client.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('second listener cannot steal an occupied control endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-dev-lock-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\wrenyard-dev-lock-${process.pid}`
    : join(dir, 'control.sock');
  const server = await listenControl(endpoint, { platform: process.platform });
  attachHandler(server, {
    async status() {
      return { checkout: '/src-owner' };
    },
  });
  await assert.rejects(
    listenControl(endpoint, { platform: process.platform }),
    (error) => error.code === 'EADDRINUSE' || error.code === 'EEXIST',
  );
  const client = await connectControl(endpoint);
  assert.equal((await client.request('status')).checkout, '/src-owner');
  client.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('leftover restart fails closed and leftover stop never touches an installed daemon', () => {
  const restart = leftoverControlDecision({
    command: 'restart',
    record: null,
    checkout: '/src',
    platform: 'linux',
    healthUnreachable: true,
  });
  assert.equal(restart.exit, EXIT.failed);
  assert.equal(restart.touchInstalled, false);
  assert.match(restart.message, /pnpm dev/);

  const idle = leftoverControlDecision({
    command: 'stop',
    record: null,
    checkout: '/src',
    platform: 'linux',
    healthUnreachable: true,
  });
  assert.equal(idle.action, 'ok-idle');
  assert.equal(idle.exit, EXIT.ok);
  assert.equal(idle.touchInstalled, false);

  const installed = leftoverControlDecision({
    command: 'stop',
    record: { checkout: '/src', instanceId: 'dev-1', supervisorPid: 11, daemonPid: 12, desktopPid: 13 },
    checkout: '/src',
    platform: 'linux',
    healthUnreachable: false,
    health: { ok: true, identity: { mode: 'installed', node: '/suite/node' } },
  });
  assert.equal(installed.action, 'fail-foreign');
  assert.equal(installed.touchInstalled, false);

  const matching = leftoverControlDecision({
    command: 'stop',
    record: { checkout: '/src', instanceId: 'dev-1', supervisorPid: 11 },
    checkout: '/src',
    platform: 'linux',
    healthUnreachable: false,
    health: { ok: true, identity: { mode: 'source', instanceId: 'dev-1' } },
  });
  assert.equal(matching.action, 'shutdown-source');

  const zombiePids = leftoverControlDecision({
    command: 'stop',
    record: { checkout: '/src', instanceId: 'dev-1', supervisorPid: 99, daemonPid: 100, desktopPid: null },
    checkout: '/src',
    platform: 'linux',
    healthUnreachable: true,
    supervisorAlive: true,
    daemonAlive: false,
    desktopAlive: false,
  });
  assert.equal(zombiePids.action, 'fail-unverified');
  assert.match(zombiePids.message, /were not killed/);
});

test('watcher debounce merges burst edits and ignores dist output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-dev-watch-'));
  const handlers = [];
  const fakeWatch = (_path, opts, cb) => {
    handlers.push(typeof opts === 'function' ? opts : cb);
    return { on() {}, close() {} };
  };
  const seen = [];
  const watcher = createWatcher({
    checkout: dir,
    debounceMs: 25,
    watch: fakeWatch,
    onChange: (event) => seen.push(event),
    roots: ['apps'],
  });
  assert.equal(handlers.length > 0, true);
  handlers[0]('change', join('desktop', 'src', 'renderer', 'app.css'));
  handlers[0]('change', join('desktop', 'dist', 'renderer', 'app.js'));
  handlers[0]('change', join('desktop', 'src', 'renderer', 'app.ts'));
  assert.equal(seen.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].files.sort(), [
    'apps/desktop/src/renderer/app.css',
    'apps/desktop/src/renderer/app.ts',
  ]);
  assert.deepEqual(seen[0].components, [COMPONENTS.renderer]);
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

test('cancelled Go generation does not report success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-dev-build-'));
  const controller = new AbortController();
  const resultPromise = buildGeneration({
    checkout: dir,
    generation: { id: 'g-cancel', components: [COMPONENTS.runtime], files: ['runtime/forge/cmd/forge/main.go'] },
    platform: 'win32',
    signal: controller.signal,
    run: (_command, _args, options) => new Promise((resolve) => {
      const finish = () => resolve({ status: 1, stdout: '', stderr: 'cancelled' });
      if (options.signal.aborted) {
        finish();
        return;
      }
      options.signal.addEventListener('abort', finish);
    }),
  });
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled|failed/i);
  rmSync(dir, { recursive: true, force: true });
});

test('generation queue merges burst files under the newest id', () => {
  const queue = createGenerationQueue();
  queue.enqueue(['renderer'], ['a.css']);
  queue.enqueue(['renderer'], ['b.css']);
  const gen = queue.takeBuild();
  assert.equal(gen.id, 'g2');
  assert.deepEqual(gen.files.sort(), ['a.css', 'b.css']);
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const winOpts = { platform: 'win32', exists: () => false };
const installRoot = 'C:\\Users\\me\\AppData\\Local\\Programs\\Wrenyard Desktop';
const installExe = `${installRoot}\\wrenyard-desktop.exe`;
const checkoutRoot = 'D:\\GitHub\\wrenyard';

test('pathInside matches install trees with spaces and ignores source checkout files', () => {
  assert.equal(pathInside(installExe, installRoot, 'win32', winOpts), true);
  assert.equal(pathInside(`${installRoot}\\resources\\app.asar`, installRoot, 'win32', winOpts), true);
  assert.equal(
    pathInside(`${checkoutRoot}\\node_modules\\electron\\dist\\electron.exe`, installRoot, 'win32', winOpts),
    false,
  );
  assert.equal(pathInside(installExe, checkoutRoot, 'win32', winOpts), false);
});

test('installed Desktop roots follow LOCALAPPDATA/Applications and skip checkout overrides', () => {
  const windows = resolveInstalledDesktopRoots({
    platform: 'win32',
    home: 'C:\\Users\\me',
    checkout: checkoutRoot,
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  });
  assert.deepEqual(windows, [installRoot]);

  const custom = resolveInstalledDesktopRoots({
    platform: 'win32',
    home: 'C:\\Users\\me',
    checkout: checkoutRoot,
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      WRENYARD_DESKTOP_BIN: 'E:\\Custom Apps\\Wrenyard Desktop\\wrenyard-desktop.exe',
    },
  });
  assert.equal(custom.includes('E:\\Custom Apps\\Wrenyard Desktop'), true);

  const sourceOverride = resolveInstalledDesktopRoots({
    platform: 'win32',
    home: 'C:\\Users\\me',
    checkout: checkoutRoot,
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      WRENYARD_DESKTOP_BIN: `${checkoutRoot}\\apps\\desktop\\node_modules\\electron\\dist\\electron.exe`,
    },
  });
  assert.equal(sourceOverride.some((root) => pathInside(root, checkoutRoot, 'win32', winOpts)), false);
});

test('release Desktop matching uses install path, not process name alone', () => {
  const processes = [
    { pid: 10, ppid: 1, exe: installExe, name: 'wrenyard-desktop.exe', sessionId: 1 },
    { pid: 11, ppid: 10, exe: installExe, name: 'wrenyard-desktop.exe', sessionId: 1 },
    { pid: 20, ppid: 1, exe: `${checkoutRoot}\\node_modules\\electron\\dist\\electron.exe`, name: 'electron.exe', sessionId: 1 },
    { pid: 30, ppid: 1, exe: 'C:\\Other\\electron.exe', name: 'electron.exe', sessionId: 1 },
    { pid: 40, ppid: 1, exe: `${installRoot}\\Uninstall 啾啾工坊.exe`, name: 'Uninstall 啾啾工坊.exe', sessionId: 1 },
  ];
  const matched = matchReleaseDesktopProcesses(processes, {
    platform: 'win32',
    roots: [installRoot],
    checkout: checkoutRoot,
    sessionId: 1,
  });
  assert.equal(matched.ok, true);
  assert.deepEqual(matched.processes.map((proc) => proc.pid).sort(), [10, 11]);
  assert.deepEqual(treeRoots(matched.processes).map((proc) => proc.pid), [10]);
});

test('a Desktop-named process without an executable path is a query failure', () => {
  const matched = matchReleaseDesktopProcesses([
    { pid: 10, ppid: 1, exe: '', name: 'wrenyard-desktop.exe', sessionId: 1 },
  ], {
    platform: 'win32',
    roots: [installRoot],
    checkout: checkoutRoot,
  });
  assert.equal(matched.ok, false);
  assert.match(matched.error, /no executable path/);
});

test('parseDevArgs only enables --kill-desktop and rejects unknown flags', () => {
  assert.deepEqual(parseDevArgs([]), { killDesktop: false, unknown: [] });
  assert.deepEqual(parseDevArgs(['--kill-desktop']), { killDesktop: true, unknown: [] });
  assert.deepEqual(parseDevArgs(['--', '--kill-desktop']), { killDesktop: true, unknown: [] });
  assert.equal(parseDevArgs(['--kill-desktop', '--bogus']).unknown[0], '--bogus');
});

test('package.json dev script forwards extra args to the supervisor entry', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'node ./tools/dev/run.mjs');
  assert.equal(pkg.scripts['dev:restart'].includes('--kill-desktop'), false);
  assert.equal(pkg.scripts['dev:stop'].includes('--kill-desktop'), false);
});

test('run.mjs parses --kill-desktop and rejects unknown flags without starting', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'tools', 'dev', 'run.mjs'), '--kill-desktop', '--bogus'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, EXIT.failed);
  assert.match(result.stderr, /Unknown argument: --bogus/);
});

test('default Desktop gate reminds the caller and does not terminate or freeze', async () => {
  let terminated = 0;
  const result = await gateReleaseDesktop({
    killDesktop: false,
    inspect: async () => ({ ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] }),
    terminate: async () => {
      terminated += 1;
      return { ok: true };
    },
  });
  assert.equal(result.action, 'fail');
  assert.equal(terminated, 0);
  assert.equal(result.message.startsWith(RELEASE_DESKTOP_RUNNING_MESSAGE), true);
  assert.match(result.message, /pid 44/);
  assert.match(result.message, /pnpm dev --kill-desktop/);
});

test('Desktop gate continues when nothing is running, including with --kill-desktop', async () => {
  let terminated = 0;
  for (const killDesktop of [false, true]) {
    const result = await gateReleaseDesktop({
      killDesktop,
      inspect: async () => ({ ok: true, processes: [] }),
      terminate: async () => {
        terminated += 1;
        return { ok: true };
      },
    });
    assert.equal(result.action, 'continue');
  }
  assert.equal(terminated, 0);
});

test('Desktop query failure is not treated as not running', async () => {
  const result = await gateReleaseDesktop({
    killDesktop: true,
    inspect: async () => ({ ok: false, error: 'access denied' }),
    terminate: async () => ({ ok: true }),
  });
  assert.equal(result.action, 'fail');
  assert.match(result.message, /无法确认/);
  assert.match(result.message, /access denied/);
});

test('--kill-desktop warns, terminates the verified tree, and waits for exit', async () => {
  const inspects = [
    { ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] },
    { ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] },
    { ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] },
    { ok: true, processes: [] },
  ];
  const lines = [];
  let terminated = null;
  let t = 0;
  const result = await gateReleaseDesktop({
    killDesktop: true,
    inspect: async () => inspects.shift() ?? { ok: true, processes: [] },
    terminate: async (processes) => {
      terminated = processes;
      return { ok: true };
    },
    stdout: (line) => lines.push(line),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    timeoutMs: 1000,
  });
  assert.equal(result.action, 'continue');
  assert.equal(result.killed, true);
  assert.equal(terminated[0].pid, 44);
  assert.equal(lines[0].startsWith(RELEASE_DESKTOP_KILL_WARNING), true);
  assert.match(lines[0], /pid 44/);
});

test('--kill-desktop fails closed on terminate identity errors and exit timeout', async () => {
  const identity = await gateReleaseDesktop({
    killDesktop: true,
    inspect: async () => ({ ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] }),
    terminate: async () => ({ ok: false, message: '无法确认进程身份（pid 44），已停止。请从托盘选择“退出”后重试。' }),
    stdout: () => {},
  });
  assert.equal(identity.action, 'fail');
  assert.match(identity.message, /无法确认进程身份/);

  let t = 0;
  const timeout = await gateReleaseDesktop({
    killDesktop: true,
    inspect: async () => ({ ok: true, processes: [{ pid: 44, ppid: 1, exe: installExe }] }),
    terminate: async () => ({ ok: true }),
    stdout: () => {},
    now: () => t,
    sleep: async (ms) => {
      t += ms + 1000;
    },
    timeoutMs: 1000,
  });
  assert.equal(timeout.action, 'fail');
  assert.match(timeout.message, /未能在 1 秒内退出/);
});

test('Windows terminate uses taskkill PID tree and refuses a reused PID', async () => {
  const calls = [];
  const terminate = createTerminateReleaseDesktop({
    platform: 'win32',
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === 'powershell.exe') {
        return {
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            ProcessId: 99,
            ParentProcessId: 1,
            ExecutablePath: 'C:\\Windows\\notepad.exe',
            SessionId: 1,
            Name: 'notepad.exe',
          }), 'utf8'),
          stderr: Buffer.alloc(0),
        };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    },
  });
  const reused = await terminate([{ pid: 99, ppid: 1, exe: installExe, name: 'wrenyard-desktop.exe' }]);
  assert.equal(reused.ok, false);
  assert.match(reused.message, /无法确认进程身份/);
  assert.equal(calls.some((call) => call.command === 'taskkill.exe'), false);

  const killCalls = [];
  const killer = createTerminateReleaseDesktop({
    platform: 'win32',
    run: async (command, args) => {
      killCalls.push({ command, args });
      if (command === 'powershell.exe') {
        return {
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            ProcessId: 44,
            ParentProcessId: 1,
            ExecutablePath: installExe,
            SessionId: 1,
            Name: 'wrenyard-desktop.exe',
          }), 'utf8'),
          stderr: Buffer.alloc(0),
        };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    },
  });
  const killed = await killer([{ pid: 44, ppid: 1, exe: installExe, name: 'wrenyard-desktop.exe' }]);
  assert.equal(killed.ok, true);
  const taskkill = killCalls.find((call) => call.command === 'taskkill.exe');
  assert.deepEqual(taskkill.args, ['/PID', '44', '/T', '/F']);
  assert.equal(taskkill.args.includes('/IM'), false);
});

test('process query parsers and identity helpers keep query failure distinct from empty', () => {
  assert.deepEqual(parseCimProcessJson(''), []);
  assert.equal(parseCimProcessJson('{"ProcessId":8,"ParentProcessId":1,"ExecutablePath":"C:\\\\a.exe","Name":"a.exe"}')[0].pid, 8);
  assert.equal(parsePsProcesses('  12  1 me /Applications/啾啾工坊.app/Contents/MacOS/啾啾工坊 --hidden')[0].pid, 12);
  assert.equal(sameProcessIdentity({ pid: 1, exe: installExe }, { pid: 1, exe: installExe }, 'win32'), true);
  assert.equal(sameProcessIdentity({ pid: 1, exe: installExe }, { pid: 1, exe: 'C:\\Windows\\notepad.exe' }, 'win32'), false);
  assert.equal(taskkillAlreadyGone({ status: 128, stdout: Buffer.from(''), stderr: Buffer.from('not found') }), true);
});

test('Windows process query reports success even when no Desktop is matched', { timeout: 30_000 }, async () => {
  if (process.platform !== 'win32') return;
  const inspect = createInspectReleaseDesktop({
    platform: 'win32',
    env: process.env,
    home: process.env.USERPROFILE,
    checkout: repoRoot,
    currentPid: process.pid,
  });
  const result = await inspect();
  assert.equal(result.ok, true, result.error);
  assert.equal(Array.isArray(result.processes), true);
});

test('blocked stop restores a truthful status instead of a stale stopping state', () => {
  // Healthy supervisor: daemon + desktop alive, neither frozen nor stopped.
  const healthy = { daemon: { exitCode: null }, desktop: { exitCode: null }, desktopStoppedByUser: false };
  assert.equal(healthyComponentStatus(healthy), 'ready');
  // A busy/blocked stop aborted before touching components: prior `ready` wins.
  assert.equal(restoredStatus('ready', healthy), 'ready');
  // A snapshot that is itself transient must not leak into the reported status.
  assert.equal(restoredStatus('stopping', healthy), 'ready');
  assert.equal(restoredStatus('waiting-for-idle', healthy), 'ready');
  assert.equal(restoredStatus('restarting', healthy), 'ready');
  assert.equal(restoredStatus(undefined, healthy), 'ready');

  // Originally frozen/degraded admission stays degraded, and a lost component
  // is reported as degraded rather than a false ready.
  assert.equal(restoredStatus('stopping', { daemon: { exitCode: null }, desktop: { exitCode: 1 }, desktopStoppedByUser: false }), 'degraded');
  assert.equal(restoredStatus('waiting-for-idle', { daemon: null, desktop: { exitCode: null }, desktopStoppedByUser: false }), 'degraded');
  assert.equal(healthyComponentStatus({ daemon: { exitCode: 0 }, desktop: null, desktopStoppedByUser: false }), 'degraded');
  // Desktop quit by the user keeps the supervisor ready even with no desktop.
  assert.equal(healthyComponentStatus({ daemon: { exitCode: null }, desktop: null, desktopStoppedByUser: true }), 'ready');
});

test('Windows owned Desktop teardown prefers the resolved Electron executable', () => {
  const full = (path) => path.replaceAll('\\', '/');
  const checkout = 'D:/src';
  const appPath = 'D:/src/apps/desktop';
  const binary = `${appPath}/node_modules/electron/dist/electron.exe`;
  const exists = (path) => {
    const normalized = full(path);
    return normalized === binary
      || normalized.endsWith('apps/desktop/node_modules/electron/path.txt')
      || normalized.endsWith('apps/desktop/node_modules/electron/dist/electron.exe');
  };
  const readText = () => 'electron.exe';
  const resolved = resolveElectronExecutable(checkout, 'win32', exists, readText);
  assert.equal(full(resolved), binary);

  const invocation = electronDesktopInvocation(checkout, 'C:/node.exe', exists, 'win32');
  assert.equal(invocation.direct, true);
  assert.equal(full(invocation.command), binary);
  assert.equal(full(invocation.args[0]), appPath);
  // Ownership tracks the real Electron main PID, not a node CLI wrapper.
  assert.equal(invocation.command.includes('node.exe'), false);
  assert.equal(invocation.args.some((arg) => arg.includes('cli.js')), false);
});

test('Desktop invocation requires a resolvable Electron binary and never uses the CLI wrapper', () => {
  const onlyCli = (path) => path.replaceAll('\\', '/').endsWith('apps/desktop/node_modules/electron/cli.js');
  assert.throws(
    () => electronDesktopInvocation('D:/src', 'C:/node.exe', onlyCli, 'win32'),
    /Electron executable was not found/,
  );

  // macOS resolves the binary inside the .app bundle via dist/path.txt.
  const full = (path) => path.replaceAll('\\', '/');
  const macRel = 'Electron.app/Contents/MacOS/Electron';
  const macBinary = `D:/src/apps/desktop/node_modules/electron/dist/${macRel}`;
  const macExists = (path) => {
    const normalized = full(path);
    return normalized.endsWith('apps/desktop/node_modules/electron/dist/path.txt')
      || normalized === macBinary;
  };
  const resolved = resolveElectronExecutable('D:/src', 'darwin', macExists, () => macRel);
  assert.equal(full(resolved), macBinary);
  const invocation = electronDesktopInvocation('D:/src', 'C:/node.exe', macExists, 'darwin');
  assert.equal(invocation.direct, true);
  assert.equal(full(invocation.command), macBinary);
  assert.equal(invocation.args.some((arg) => arg.includes('cli.js')), false);
});

test('owned tree stop terminates the child tree before signalling the root', async () => {
  const order = [];
  const child = fakeChild(4242, { exitCode: null, label: 'child' });
  const originalOnce = child.once;
  child.once = (event, handler) => {
    if (event === 'exit') order.push('child-exit-listener');
    return originalOnce.call(child, event, handler);
  };
  const result = await stopOwnedDesktopTree(child, {
    platform: 'win32',
    timeoutMs: 5,
    run: async (command, args) => {
      order.push(`run:${command}`);
      assert.deepEqual(args, ['/PID', '4242', '/T', '/F']);
      child.exitCode = 0;
      child.emitExit();
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  // The exit confirmed by the tree kill is proven by a listener registered up
  // front; the root child is never signalled separately on Windows.
  assert.equal(order[0], 'child-exit-listener');
  assert.equal(order[1], 'run:taskkill.exe');
  assert.deepEqual(child.signals, []);
});

test('owned tree stop is not success when taskkill succeeds but the child never exits', async () => {
  const child = fakeChild(7, { exitCode: null, confirmExit: false });
  const result = await stopOwnedTree(child, {
    platform: 'win32',
    timeoutMs: 5,
    run: async () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not exit|7/);
});

test('owned tree stop treats a not-found taskkill as unconfirmed, not success', async () => {
  const child = fakeChild(9001, { exitCode: null, confirmExit: false });
  const result = await stopOwnedTree(child, {
    platform: 'win32',
    timeoutMs: 5,
    run: async () => ({ status: 128, stdout: '', stderr: 'not found' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /9001|did not exit/);
});

test('stopChild reports failure when a signal is sent but no exit is confirmed', async () => {
  const child = fakeChild(5, { exitCode: null, confirmExit: false });
  const result = await stopChild(child, { timeoutMs: 5 });
  assert.equal(result.ok, false);
});

test('owned tree stop on POSIX does not invoke Windows taskkill', async () => {
  const calls = [];
  const child = fakeChild(55, { exitCode: null });
  const result = await stopOwnedTree(child, {
    platform: 'linux',
    timeoutMs: 5,
    run: async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(typeof result.ok, 'boolean');
});

test('stopOwnedDesktopTree itself never runs taskkill on darwin', async () => {
  const calls = [];
  const child = fakeChild(1234, { exitCode: null, confirmExit: true });
  const result = await stopOwnedDesktopTree(child, {
    platform: 'darwin',
    timeoutMs: 5,
    run: async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.ok, true);
  // The root child was signalled directly on POSIX, never tree-killed.
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Windows taskkill failure with a still-live child must not signal the root', async () => {
  const child = fakeChild(4242, { exitCode: null, confirmExit: false });
  const result = await stopOwnedDesktopTree(child, {
    platform: 'win32',
    timeoutMs: 5,
    run: async () => ({ status: 1, stdout: '', stderr: 'Access is denied.' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.forced, true);
  // A failed tree kill must not fall back to signalling only the root, which
  // would orphan the renderer/gpu/helper processes.
  assert.deepEqual(child.signals, []);
});

test('Windows taskkill not-found without a confirmed exit is unconfirmed, not success', async () => {
  const child = fakeChild(9001, { exitCode: null, confirmExit: false });
  const result = await stopOwnedDesktopTree(child, {
    platform: 'win32',
    timeoutMs: 5,
    run: async () => ({ status: 128, stdout: '', stderr: 'not found' }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(child.signals, []);
});

test('graceful RPC quit waits for an async exit without sending any signal', async () => {
  const child = fakeChild(77, { exitCode: null, confirmExit: false });
  // The Desktop acknowledges the quit RPC, then exits asynchronously.
  setTimeout(() => {
    child.exitCode = 0;
    child.emitExit();
  }, 10);
  const result = await stopOwnedDesktopTree(child, {
    platform: 'win32',
    timeoutMs: 50,
    afterGraceful: true,
    run: async () => {
      throw new Error('taskkill must not run after a graceful exit');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.deepEqual(child.signals, []);
});

test('signalCode-only exits are treated as exited and never signalled again', async () => {
  const signalled = fakeChild(31, { exitCode: null, signalCode: 'SIGTERM', confirmExit: false });
  assert.equal(childHasExited(signalled), true);
  const result = await stopOwnedDesktopTree(signalled, {
    platform: 'win32',
    timeoutMs: 5,
    run: async () => {
      throw new Error('a signalled child must not be taskkilled again');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(signalled.signals, []);
});

test('an already-exited or missing child stops as a safe no-op', async () => {
  assert.equal(childHasExited(null), true);
  assert.equal(await waitForChildExit(null, 5), true);
  const exited = fakeChild(9, { exitCode: 0 });
  assert.equal(childHasExited(exited), true);
  const result = await stopOwnedDesktopTree(exited, { platform: 'win32', timeoutMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.deepEqual(exited.signals, []);
});

test('a ready status snapshot cannot hide a missing child', () => {
  // Stopping a healthy stack, then one component dies: a stale `ready`
  // snapshot must not mask the missing child.
  assert.equal(
    restoredStatus('ready', { daemon: { exitCode: null, signalCode: null }, desktop: null, desktopStoppedByUser: false }),
    'degraded',
  );
  // A signal-killed component is dead even with a null exitCode.
  assert.equal(
    healthyComponentStatus({ daemon: { exitCode: null, signalCode: 'SIGKILL' }, desktop: { exitCode: null, signalCode: null }, desktopStoppedByUser: false }),
    'degraded',
  );
  assert.equal(
    healthyComponentStatus({ daemon: { exitCode: null, signalCode: null }, desktop: { exitCode: null, signalCode: 'SIGTERM' }, desktopStoppedByUser: false }),
    'degraded',
  );
  // All live, nothing signalled: ready stays ready.
  assert.equal(
    healthyComponentStatus({ daemon: { exitCode: null, signalCode: null }, desktop: { exitCode: null, signalCode: null }, desktopStoppedByUser: false }),
    'ready',
  );
});

/** Minimal ChildProcess stand-in: tracked kills emit `exit`; a signal exit can be simulated. */
function fakeChild(pid, { exitCode = null, signalCode = null, confirmExit = true, label = null, record = null } = {}) {
  const listeners = new Map();
  const child = {
    pid,
    label,
    killed: false,
    exitCode,
    signalCode,
    signals: [],
    once(event, handler) {
      listeners.set(event, handler);
      return child;
    },
    removeListener(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
      return child;
    },
    kill(signal) {
      child.signals.push(signal);
      record?.signals?.push(signal);
      if (confirmExit) {
        child.killed = true;
        if (signal === 'SIGKILL') child.exitCode = 1;
        else child.signalCode = signal;
        child.emitExit();
      }
      return true;
    },
    emitExit() {
      const handler = listeners.get('exit');
      listeners.delete('exit');
      handler?.();
    },
  };
  return child;
}

