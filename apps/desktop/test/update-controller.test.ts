import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DesktopUpdateController,
  compareSemver,
  parseChecksum,
  releaseTarget,
  selectUpdateCandidate,
  type GithubRelease,
} from '../src/update-controller.js';

function release(version: string, prerelease: boolean, target = 'darwin-arm64'): GithubRelease {
  const desktop = `wrenyard-desktop-${version}-${target}.zip`;
  const suite = `wrenyard-${version}-${target}-suite.zip`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease,
    assets: [desktop, `${desktop}.sha256`, suite, `${suite}.sha256`].map((name) => ({
      name,
      browser_download_url: `https://example.test/${name}`,
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
  assert.equal(releaseTarget('darwin', 'x64'), 'darwin-x64');
  assert.equal(releaseTarget('win32', 'x64'), 'win32-x64');
  assert.equal(releaseTarget('linux', 'x64'), 'linux-x64');
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

test('checksum parser accepts exactly one SHA-256 digest', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseChecksum(`${digest}  desktop.zip\n`), digest);
  assert.throws(() => parseChecksum('not-a-checksum'), /invalid checksum/);
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

test('startup check is scheduled at 5s and rechecks every 6 hours via the injected scheduler', async () => {
  type ScheduledEntry =
    | { kind: 'timeout'; handle: number; callback: () => void; delay: number }
    | { kind: 'interval'; handle: number; callback: () => void; interval: number };

  const scheduled: ScheduledEntry[] = [];
  const cleared: unknown[] = [];
  let checkCount = 0;
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
  assert.equal(recurring.interval, 6 * 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCount, 1);

  recurring.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCount, 2);

  controller.stop();
  assert.deepEqual(cleared, [recurring.handle]);
});
