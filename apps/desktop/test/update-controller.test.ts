import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DesktopUpdateController,
  compareSemver,
  parseAssetDigest,
  releaseTarget,
  selectUpdateCandidate,
  type GithubRelease,
  type PreparedUpdate,
  type UpdateCandidate,
  type UpdateScheduler,
} from '../src/update-controller.js';

function release(version: string, prerelease: boolean, target = 'darwin-arm64'): GithubRelease {
  const desktop = `wrenyard-desktop-${version}-${target}.zip`;
  const suite = `wrenyard-${version}-${target}-suite.zip`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease,
    assets: [desktop, suite].map((name) => ({
      name,
      browser_download_url: `https://example.test/${name}`,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  };
}

test('semantic versions sort stable after prerelease and compare dev sequence numerically', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0-dev.99'), 1);
  assert.equal(compareSemver('1.0.0-dev.16', '1.0.0-dev.15'), 1);
  assert.equal(compareSemver('2.0.0-alpha.1', '2.0.0-alpha.beta'), -1);
  assert.throws(() => compareSemver('latest', '1.0.0'), /invalid semantic version/);
});

test('release target supports the shipped Desktop platforms only', () => {
  assert.equal(releaseTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(releaseTarget('win32', 'x64'), 'win32-x64');
  assert.equal(releaseTarget('darwin', 'x64'), null);
  assert.equal(releaseTarget('linux', 'x64'), null);
  assert.equal(releaseTarget('linux', 'arm64'), null);
});

test('dev channel selects the highest complete release while stable ignores prereleases', () => {
  const releases = [release('1.0.0-dev.16', true), release('1.0.0', false)];
  const dev = selectUpdateCandidate(releases, '1.0.0-dev.15', 'dev', 'darwin-arm64');
  assert.equal(dev.candidate?.version, '1.0.0');
  assert.equal(dev.hasChannelRelease, true);

  const stable = selectUpdateCandidate(releases, '0.9.0', 'stable', 'darwin-arm64');
  assert.equal(stable.candidate?.version, '1.0.0');
});

test('selection never downgrades and ignores releases missing required assets', () => {
  const incomplete = release('1.0.0-dev.17', true);
  incomplete.assets.pop();
  const selected = selectUpdateCandidate(
    [incomplete, release('1.0.0-dev.16', true)],
    '1.0.0-dev.16',
    'dev',
    'darwin-arm64',
  );
  assert.equal(selected.candidate, undefined);
  assert.equal(selected.hasChannelRelease, true);

  const noStable = selectUpdateCandidate([release('1.0.0-dev.16', true)], '1.0.0-dev.15', 'stable', 'darwin-arm64');
  assert.equal(noStable.candidate, undefined);
  assert.equal(noStable.hasChannelRelease, false);
});

test('GitHub asset digest parser accepts exactly one prefixed SHA-256 digest', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseAssetDigest(`sha256:${digest}`), digest);
  assert.throws(() => parseAssetDigest(digest), /invalid asset digest/);
});

test('controller checks the selected channel and exposes only friendly state', async () => {
  let channel: 'stable' | 'dev' = 'dev';
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: '/tmp/wrenyard-update-controller-fixture',
    platform: 'darwin',
    arch: 'arm64',
    settings: {
      loadUpdateChannel: () => channel,
      saveUpdateChannel: (next) => { channel = next; },
    },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    now: () => 123_456,
  });

  const available = await controller.check(true);
  assert.equal(available.state, 'available');
  assert.equal(available.availableVersion, '1.0.0-dev.16');
  assert.equal(available.checkedAt, 123_456);
  assert.equal(JSON.stringify(available).includes('github'), false);

  const stable = await controller.setChannel('stable');
  assert.equal(channel, 'stable');
  assert.equal(stable.state, 'stable-unavailable');
});

test('manual check failure is friendly while automatic failure stays silent', async () => {
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: '/tmp/wrenyard-update-controller-failure',
    platform: 'darwin',
    arch: 'arm64',
    settings: {
      loadUpdateChannel: () => 'dev',
      saveUpdateChannel: () => undefined,
    },
    fetcher: async () => { throw new Error('token=secret internal path'); },
    now: () => 99,
  });

  const automatic = await controller.check(false);
  assert.equal(automatic.state, 'idle');
  assert.equal(automatic.message, undefined);

  const manual = await controller.check(true);
  assert.equal(manual.state, 'check-failed');
  assert.equal(manual.message, '暂时无法检查更新，请检查网络连接后重试。');
  assert.equal(JSON.stringify(manual).includes('secret'), false);
});

test('channel changes reuse the hourly release cache instead of consuming another API request', async () => {
  let fetchCount = 0;
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: '/tmp/wrenyard-update-controller-cache',
    platform: 'darwin',
    arch: 'arm64',
    settings: {
      loadUpdateChannel: () => 'dev',
      saveUpdateChannel: () => undefined,
    },
    fetcher: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => 1_000,
  });

  await controller.check(true);
  await controller.setChannel('stable');
  assert.equal(fetchCount, 1);
});

test('atomic installation is available on the two maintained platforms only', () => {
  const base = {
    currentVersion: '1.0.0-dev.20',
    settings: {
      loadUpdateChannel: () => 'dev' as const,
      saveUpdateChannel: () => undefined,
    },
    cliPath: '/suite/wrenyard',
    helperPath: '/app/update-helper.cjs',
    helperRuntimePath: '/suite/node',
    userDataPath: '/user/data',
  };
  assert.equal(new DesktopUpdateController({ ...base, platform: 'darwin', arch: 'arm64' }).snapshot().installSupported, true);
  assert.equal(new DesktopUpdateController({ ...base, platform: 'win32', arch: 'x64' }).snapshot().installSupported, true);
  assert.equal(new DesktopUpdateController({ ...base, platform: 'linux', arch: 'x64' }).snapshot().installSupported, false);
});

test('startup check is scheduled at 5s and rechecks every hour via the injected scheduler', async () => {
  type ScheduledEntry =
    | { kind: 'timeout'; handle: number; callback: () => void; delay: number }
    | { kind: 'interval'; handle: number; callback: () => void; interval: number };

  const scheduled: ScheduledEntry[] = [];
  const cleared: unknown[] = [];
  let checkCount = 0;
  let now = 0;
  const fetcher = async () => {
    checkCount += 1;
    return new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: '/tmp/wrenyard-update-controller-scheduling',
    platform: 'darwin',
    arch: 'arm64',
    settings: {
      loadUpdateChannel: () => 'dev',
      saveUpdateChannel: () => undefined,
    },
    fetcher,
    now: () => now,
    scheduler: {
      setTimeout: (callback, delay) => {
        scheduled.push({ kind: 'timeout', handle: scheduled.length + 1, callback, delay });
        return scheduled.length;
      },
      clearTimeout: (handle) => { cleared.push(handle); },
      setInterval: (callback, interval) => {
        scheduled.push({ kind: 'interval', handle: scheduled.length + 1, callback, interval });
        return scheduled.length;
      },
      clearInterval: (handle) => { cleared.push(handle); },
    },
  });

  controller.start();
  controller.start(); // start() stays idempotent: no second handle is scheduled.
  assert.equal(scheduled.length, 1);
  const first = scheduled[0]!;
  assert.equal(first.kind, 'timeout');
  assert.equal(first.delay, 5000);
  assert.equal(checkCount, 0);

  first.callback();
  assert.equal(scheduled.length, 2);
  const recurring = scheduled[1]!;
  assert.equal(recurring.kind, 'interval');
  assert.equal(recurring.interval, 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCount, 1);

  now += 60 * 60 * 1000;
  recurring.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCount, 2);

  controller.stop();
  assert.deepEqual(cleared, [recurring.handle]);
});

function isolatedScheduler(): UpdateScheduler & { scheduled: Array<{ id: number; callback: () => void }> } {
  const scheduled: Array<{ id: number; callback: () => void }> = [];
  let id = 0;
  return {
    scheduled,
    setTimeout: (callback: () => void) => { id += 1; const handle = id; scheduled.push({ id: handle, callback }); return handle; },
    clearTimeout: (handle: unknown) => {
      const index = scheduled.findIndex((entry) => entry.id === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
    setInterval: (callback: () => void) => { id += 1; const handle = id; scheduled.push({ id: handle, callback }); return handle; },
    clearInterval: (handle: unknown) => {
      const index = scheduled.findIndex((entry) => entry.id === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
}

function fakeUpdateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-test-'));
  writeFileSync(join(root, 'update-helper.cjs'), '');
  return root;
}

test('explicit request prepares once while busy, waits without launching, then installs when idle', async () => {
  let busy = true;
  let preparedCount = 0;
  let launched = 0;
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: join(root, 'data'),
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: join(root, 'update-helper.cjs'),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    isBusy: async () => busy,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => {
      preparedCount += 1;
      return { candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root] };
    },
    spawnDetached: () => { launched += 1; },
    onInstall: () => undefined,
    scheduler: isolatedScheduler(),
  });

  const waiting = await controller.requestInstall();
  assert.equal(waiting.state, 'waiting');
  assert.equal(preparedCount, 1, 'prepared exactly once even while busy');
  assert.equal(launched, 0, 'must not launch while busy');

  // A second authorization while still busy must reuse the staged artifact.
  await controller.requestInstall();
  assert.equal(preparedCount, 1, 'preparation is never repeated');

  busy = false;
  controller.wake();
  await new Promise((resolve) => setImmediate(resolve));
  const installed = controller.snapshot();
  assert.equal(launched, 1, 'idle recheck launches exactly once');
  assert.equal(installed.state, 'installing');

  rmSync(root, { recursive: true, force: true });
});

test('cancelPendingInstall clears intent and prevents a later launch without reporting success', async () => {
  let busy = true;
  let launched = 0;
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: join(root, 'data'),
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: join(root, 'update-helper.cjs'),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    isBusy: async () => busy,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  });

  const waiting = await controller.requestInstall();
  assert.equal(waiting.state, 'waiting');
  const cancelled = controller.cancelPendingInstall();
  assert.equal(cancelled.state, 'available', 'returns to available, retaining staged artifact');
  assert.notEqual(cancelled.state, 'up-to-date', 'must not report success');

  busy = false;
  controller.wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launched, 0, 'cancellation prevents launch');
  assert.notEqual(controller.snapshot().state, 'installing');

  rmSync(root, { recursive: true, force: true });
});

test('automatic check discovers the candidate but never installs', async () => {
  let launched = 0;
  const scheduler = isolatedScheduler();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: '/tmp/wrenyard-update-controller-automatic',
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: '/app/update-helper.cjs',
    helperRuntimePath: '/suite/node',
    desktopPath: '/app',
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    spawnDetached: () => { launched += 1; },
    scheduler,
  });

  const snapshot = await controller.check(false);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.availableVersion, '1.0.0-dev.16');
  assert.equal(launched, 0);
  assert.equal(controller.snapshot().state, 'available');
});

test('preparation failure preserves the current version and reports a friendly error', async () => {
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: join(root, 'data'),
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: join(root, 'update-helper.cjs'),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    isBusy: async () => false,
    prepareCandidate: async () => { throw new Error('checksum mismatch internal token'); },
    scheduler: isolatedScheduler(),
  });

  await controller.check(true);
  const failed = await controller.requestInstall();
  assert.equal(failed.state, 'install-failed');
  assert.equal(failed.currentVersion, '1.0.0-dev.15');
  assert.equal(JSON.stringify(failed).includes('token'), false);

  rmSync(root, { recursive: true, force: true });
});

test('direct launchPreparedUpdate cannot bypass the busy safety gate', async () => {
  let launched = 0;
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: join(root, 'data'),
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: join(root, 'update-helper.cjs'),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    isBusy: async () => true,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  });

  await controller.requestInstall(); // busy -> waiting, prepares the artifact
  const ok = await controller.launchPreparedUpdate();
  assert.equal(ok, false);
  assert.equal(launched, 0, 'busy gate blocks the launch entirely');
  assert.equal(controller.snapshot().state, 'install-blocked');

  rmSync(root, { recursive: true, force: true });
});

test('stop clears the pending idle timer and install intent', async () => {
  let busy = true;
  const scheduler = isolatedScheduler();
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController({
    currentVersion: '1.0.0-dev.15',
    userDataPath: join(root, 'data'),
    platform: 'darwin',
    arch: 'arm64',
    cliPath: '/suite/wrenyard',
    helperPath: join(root, 'update-helper.cjs'),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    settings: { loadUpdateChannel: () => 'dev', saveUpdateChannel: () => undefined },
    fetcher: async () => new Response(JSON.stringify([release('1.0.0-dev.16', true)]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    isBusy: async () => busy,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    scheduler,
  });

  await controller.requestInstall();
  assert.equal(scheduler.scheduled.length, 1, 'idle retry timer is scheduled while waiting');
  controller.stop();
  assert.equal(scheduler.scheduled.length, 0, 'stop clears pending timers');
  busy = false;
  controller.wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().state, 'waiting', 'intent cleared, no install after stop');

  rmSync(root, { recursive: true, force: true });
});
