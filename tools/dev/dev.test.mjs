import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPath, classifyPaths, expandDependents, isRendererOnly, shouldIgnore, COMPONENTS } from './lib/graph.mjs';
import { createGenerationQueue } from './lib/queue.mjs';
import { createRequestQueue } from './lib/requests.mjs';
import { spawnArgv, quoteCmdArg, windowsCmdInvocation, electronInvocation, sourceCliInvocation } from './lib/spawn.mjs';
import { normalizeCheckout, sameCheckout, desktopUserData, controlEndpoint, businessIpcPath, defaultRuntimeBin } from './lib/paths.mjs';
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

test('desktop userData follows the installed product name, not Electron defaults', () => {
  assert.equal(
    desktopUserData('win32', { APPDATA: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming' }, 'C:\\\\Users\\\\me'),
    join('C:\\\\Users\\\\me\\\\AppData\\\\Roaming', '啾啾工坊'),
  );
  assert.equal(
    desktopUserData('darwin', {}, '/Users/me'),
    join('/Users/me', 'Library', 'Application Support', '啾啾工坊'),
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
  const exists = (path) => path.endsWith('cli.js') || path.endsWith('index.ts') || path.endsWith('cli.mjs') || path.endsWith('tsx');
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
