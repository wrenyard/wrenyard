import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DesktopUpdateController,
  type DesktopUpdateControllerOptions,
  type UpdateScheduler,
} from '../src/update-controller.js';

const DIGEST = 'a'.repeat(64);
const BASE_URL = 'https://feed.test/updates';

function feedAsset(version: string, name: string) {
  return { name, url: `https://feed.test/${name}`, sha256: DIGEST };
}

/** The complete production feed schema, carrying both assets for both triplets. */
function feedJson(version: string): string {
  return JSON.stringify({
    schema_version: 'wrenyard.update.v1',
    version,
    published_at: '2026-01-01T00:00:00Z',
    assets: [
      feedAsset(version, `wrenyard-desktop-${version}-darwin-arm64.zip`),
      feedAsset(version, `wrenyard-${version}-darwin-arm64-suite.zip`),
      feedAsset(version, `wrenyard-desktop-${version}-win32-x64.zip`),
      feedAsset(version, `wrenyard-${version}-win32-x64-suite.zip`),
    ],
  });
}

function metadataResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface SuiteFixture {
  root: string;
  prefix: string;
  userData: string;
  cliExecutable: string;
  runtimePath: string;
}

/** A real on-disk suite: <prefix>/versions/<v>/wrenyard + runtime/node. */
function suiteFixture(version = '1.0.0-dev.25'): SuiteFixture {
  const base = mkdtempSync(join(tmpdir(), 'wrenyard-update-'));
  const prefix = join(base, 'prefix');
  const root = join(prefix, 'versions', version);
  const runtimePath = join(root, 'runtime', 'node');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'wrenyard'), 'sea');
  writeFileSync(runtimePath, 'node');
  const userData = join(base, 'userData');
  mkdirSync(userData, { recursive: true });
  return { root, prefix, userData, cliExecutable: join(root, 'wrenyard'), runtimePath };
}

function baseOptions(
  fixture: SuiteFixture,
  overrides: Partial<DesktopUpdateControllerOptions> = {},
): DesktopUpdateControllerOptions {
  return {
    currentVersion: '1.0.0-dev.25',
    userDataPath: fixture.userData,
    platform: 'darwin',
    arch: 'arm64',
    updateBaseUrl: BASE_URL,
    probeInstallation: () => ({ cliPath: fixture.cliExecutable, runtimePath: fixture.runtimePath }),
    readDaemonIdle: async () => true,
    ...overrides,
  };
}

function isolatedScheduler(): UpdateScheduler & { scheduled: Array<{ id: number; callback: () => void }> } {
  const scheduled: Array<{ id: number; callback: () => void }> = [];
  let id = 0;
  const drop = (handle: unknown): void => {
    const index = scheduled.findIndex((entry) => entry.id === handle);
    if (index >= 0) scheduled.splice(index, 1);
  };
  const push = (callback: () => void): number => {
    id += 1;
    const handle = id;
    scheduled.push({ id: handle, callback: () => { drop(handle); callback(); } });
    return handle;
  };
  return { scheduled, setTimeout: push, clearTimeout: drop, setInterval: push, clearInterval: drop };
}

test('the channel document is derived from the running version and offers a newer release', async () => {
  const fixture = suiteFixture();
  try {
    const requests: string[] = [];
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      fetcher: async (input: string | URL | Request) => {
        requests.push(String(input));
        return metadataResponse(feedJson('1.0.0-dev.26'));
      },
      now: () => 123_456,
    }));

    const snapshot = await controller.check(true);
    assert.equal(snapshot.state, 'available');
    assert.equal(snapshot.availableVersion, '1.0.0-dev.26');
    assert.equal(snapshot.checkedAt, 123_456);
    assert.deepEqual(requests, [`${BASE_URL}/dev.json`], 'exactly one channel-head fetch');
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('a feed at the running version reports up-to-date and never downgrades', async () => {
  const fixture = suiteFixture();
  try {
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      fetcher: async () => metadataResponse(feedJson('1.0.0-dev.25')),
    }));
    const snapshot = await controller.check(true);
    assert.equal(snapshot.state, 'up-to-date');
    assert.equal(snapshot.availableVersion, undefined);
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('startup check is scheduled at 5s and rechecks hourly', async () => {
  const fixture = suiteFixture();
  try {
    type Entry = { kind: 'timeout' | 'interval'; callback: () => void; delay?: number; interval?: number };
    const scheduled: Entry[] = [];
    let checks = 0;
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      fetcher: async () => {
        checks += 1;
        return metadataResponse(feedJson('1.0.0-dev.26'));
      },
      scheduler: {
        setTimeout: (callback, delay) => { scheduled.push({ kind: 'timeout', callback, delay }); return scheduled.length; },
        clearTimeout: () => undefined,
        setInterval: (callback, interval) => { scheduled.push({ kind: 'interval', callback, interval }); return scheduled.length; },
        clearInterval: () => undefined,
      },
    }));

    controller.start();
    controller.start(); // start() is idempotent.
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.kind, 'timeout');
    assert.equal(scheduled[0]!.delay, 5_000);

    scheduled[0]!.callback();
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1]!.kind, 'interval');
    assert.equal(scheduled[1]!.interval, 60 * 60 * 1_000);
    await flush();
    assert.equal(checks, 1);

    scheduled[1]!.callback();
    await flush();
    assert.equal(checks, 2, 'the hourly timer checks again');
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('source development never polls, downloads or installs', async () => {
  const fixture = suiteFixture();
  try {
    const requests: string[] = [];
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      sourceDevelopment: true,
      fetcher: async (input: string | URL | Request) => {
        requests.push(String(input));
        return metadataResponse(feedJson('1.0.0-dev.26'));
      },
    }));

    controller.start();
    const snapshot = controller.snapshot();
    assert.equal(snapshot.installSupported, false);
    assert.equal(snapshot.installReason, 'source-development');
    assert.match(snapshot.message ?? '', /源码开发/);

    const checked = await controller.check(true);
    assert.equal(checked.state, 'idle');
    assert.equal(requests.length, 0);

    const install = await controller.requestInstall();
    assert.equal(install.state, 'error');
    assert.equal(requests.length, 0);
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('unsupported platforms and missing runtimes report precise reasons', () => {
  const fixture = suiteFixture();
  try {
    const linux = new DesktopUpdateController(baseOptions(fixture, { platform: 'linux', arch: 'x64' })).snapshot();
    assert.equal(linux.installSupported, false);
    assert.equal(linux.installReason, 'unsupported-platform');

    const missingRuntime = new DesktopUpdateController(baseOptions(fixture, {
      probeInstallation: () => ({ cliPath: fixture.cliExecutable, reason: 'missing-runtime' }),
    })).snapshot();
    assert.equal(missingRuntime.installSupported, false);
    assert.equal(missingRuntime.installReason, 'missing-runtime');
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('an authorized install spawns the installed SEA with the exact engine arguments', async () => {
  const fixture = suiteFixture();
  try {
    const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    let installed = 0;
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      fetcher: async () => metadataResponse(feedJson('1.0.0-dev.26')),
      spawnDetached: (command, args, options) => { calls.push({ command, args, options }); },
      onInstall: () => { installed += 1; },
    }));

    await controller.check(true);
    const snapshot = await controller.requestInstall();
    assert.equal(snapshot.state, 'installing');
    assert.equal(installed, 1, 'Desktop quits once the engine is launched');

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, fixture.cliExecutable);
    assert.deepEqual(call.args, [
      'update', '--version', '1.0.0-dev.26', '--wait-pid', String(process.pid),
      '--relaunch-desktop', '--result-file', join(fixture.userData, 'update-result.json'),
    ]);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.cwd, fixture.prefix, 'cwd must be the prefix, never a renamed directory');
    const env = call.options.env as NodeJS.ProcessEnv;
    for (const key of ['WRENYARD_ROOT', 'WRENYARD_CLI', 'WRENYARD_NODE_BIN', 'WRENYARD_SOURCE_DEV',
      'WRENYARD_DEV_SUPERVISED', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD']) {
      assert.equal(env[key], undefined, `${key} must be scrubbed`);
    }
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('a busy daemon defers install, retrying every 60s until it is idle', async () => {
  const fixture = suiteFixture();
  try {
    let idle = false;
    const scheduler = isolatedScheduler();
    const calls: string[] = [];
    const controller = new DesktopUpdateController(baseOptions(fixture, {
      fetcher: async () => metadataResponse(feedJson('1.0.0-dev.26')),
      readDaemonIdle: async () => idle,
      spawnDetached: (command) => { calls.push(command); },
      scheduler,
    }));

    await controller.check(true);
    const waiting = await controller.requestInstall();
    assert.equal(waiting.state, 'waiting');
    assert.match(waiting.message ?? '', /有任务运行中/);
    assert.equal(calls.length, 0, 'no launch while busy');
    assert.equal(scheduler.scheduled.length, 1, 'a 60s retry is scheduled');

    scheduler.scheduled[0]!.callback();
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(scheduler.scheduled.length, 1, 'still busy: another retry is scheduled');

    idle = true;
    scheduler.scheduled[0]!.callback();
    await flush();
    assert.equal(calls.length, 1, 'the idle retry launches the engine');
    assert.equal(controller.snapshot().state, 'installing');
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});

test('a durable failed engine result is surfaced once and then marked read', () => {
  const fixture = suiteFixture();
  try {
    writeFileSync(join(fixture.userData, 'update-result.json'), JSON.stringify({
      status: 'failed', version: '1.0.0-dev.26', message: 'Daemon 套件升级失败（退出码 7）；已恢复原 Desktop',
    }));
    const controller = new DesktopUpdateController(baseOptions(fixture));
    const snapshot = controller.snapshot();
    assert.equal(snapshot.state, 'error');
    assert.equal(snapshot.message, 'Daemon 套件升级失败（退出码 7）；已恢复原 Desktop');
    assert.equal(existsSync(join(fixture.userData, 'update-result.json')), false, 'the result is consumed once');
    assert.equal(new DesktopUpdateController(baseOptions(fixture)).snapshot().state, 'idle');
  } finally {
    rmSync(join(fixture.prefix, '..'), { recursive: true, force: true });
  }
});
