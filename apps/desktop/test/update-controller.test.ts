import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeTaskCountFromDaemonStatus,
  DesktopUpdateController,
  compareSemver,
  parseAssetDigest,
  parseUpdateManifest,
  releaseTarget,
  resolveWindowsSystemTarPath,
  selectUpdateCandidate,
  type PreparedUpdate,
  type UpdateCandidate,
  type UpdateManifest,
  type UpdateScheduler,
} from '../src/update-controller.js';
import { readUpdateAttempt, UPDATE_ATTEMPT_FILENAME } from '../src/update-attempt.js';

const REPOSITORY = 'wrenyard/wrenyard';
const BASE_URL = 'https://metadata.test/updates';
const DIGEST = 'a'.repeat(64);

function canonicalNames(version: string): string[] {
  return [
    `wrenyard-desktop-${version}-darwin-arm64.zip`,
    `wrenyard-${version}-darwin-arm64-suite.zip`,
    `wrenyard-desktop-${version}-win32-x64.zip`,
    `wrenyard-${version}-win32-x64-suite.zip`,
  ];
}

function asset(version: string, name: string) {
  return {
    name,
    url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,
    sha256: DIGEST,
  };
}

function manifest(version: string): UpdateManifest {
  return { version, assets: canonicalNames(version).map((name) => asset(version, name)) };
}

/** The complete production manifest schema shared by both channels. */
function manifestJson(version: string): string {
  return JSON.stringify({
    schema_version: 'wrenyard.update.v1',
    version,
    published_at: '2026-01-01T00:00:00Z',
    assets: manifest(version).assets,
  });
}

function manifestDocument(version: string): Record<string, unknown> {
  return JSON.parse(manifestJson(version)) as Record<string, unknown>;
}

function metadataResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
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

test('static manifest parsing accepts the complete canonical feed for both channels', () => {
  const dev = parseUpdateManifest(manifestDocument('1.0.0-dev.16'), 'dev', REPOSITORY);
  assert.equal(dev.version, '1.0.0-dev.16');
  assert.equal(dev.publishedAt, '2026-01-01T00:00:00Z');
  assert.equal(dev.assets.length, 4, 'dev feeds carry the full canonical asset set');

  const stable = parseUpdateManifest(manifestDocument('1.0.0'), 'stable', REPOSITORY);
  assert.equal(stable.version, '1.0.0');
  assert.equal(stable.assets.length, 4, 'stable feeds share the identical schema');
});

test('static manifest parsing rejects malformed, incomplete, extra and duplicate assets', () => {
  const wrongSchema = manifestDocument('1.0.0');
  wrongSchema.schema_version = 'v0';
  assert.throws(() => parseUpdateManifest(wrongSchema, 'stable', REPOSITORY), /schema/);

  assert.throws(() => parseUpdateManifest({ schema_version: 'wrenyard.update.v1' }, 'stable', REPOSITORY), /version/);

  const badVersion = manifestDocument('1.0.0');
  badVersion.version = 'latest';
  assert.throws(() => parseUpdateManifest(badVersion, 'stable', REPOSITORY), /version/);

  const badTimestamp = manifestDocument('1.0.0');
  badTimestamp.published_at = 42;
  assert.throws(() => parseUpdateManifest(badTimestamp, 'stable', REPOSITORY), /timestamp/);

  const badDigest = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  badDigest.assets[0]!.sha256 = 'sha256:a';
  assert.throws(() => parseUpdateManifest(badDigest, 'stable', REPOSITORY), /digest/);

  const foreignUrl = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  foreignUrl.assets[0]!.url = 'https://evil.test/wrenyard-desktop-1.0.0-darwin-arm64.zip';
  assert.throws(() => parseUpdateManifest(foreignUrl, 'stable', REPOSITORY), /url/);

  const mismatchedUrl = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  mismatchedUrl.assets[0]!.url = `https://github.com/${REPOSITORY}/releases/download/v1.0.0/other.zip`;
  assert.throws(() => parseUpdateManifest(mismatchedUrl, 'stable', REPOSITORY), /url/);

  const missingAsset = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  missingAsset.assets = missingAsset.assets.filter(
    (entry) => entry.name !== 'wrenyard-desktop-1.0.0-win32-x64.zip',
  );
  assert.throws(() => parseUpdateManifest(missingAsset, 'stable', REPOSITORY), /assets/);

  const extraAsset = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  extraAsset.assets.push(asset('1.0.0', 'wrenyard-desktop-1.0.0-linux-x64.zip'));
  assert.throws(() => parseUpdateManifest(extraAsset, 'stable', REPOSITORY), /assets/);

  const duplicateAsset = manifestDocument('1.0.0') as { assets: Array<Record<string, unknown>> };
  duplicateAsset.assets[1] = { ...duplicateAsset.assets[0]! };
  assert.throws(() => parseUpdateManifest(duplicateAsset, 'stable', REPOSITORY), /duplicate/);

  assert.throws(
    () => parseUpdateManifest(manifestDocument('1.0.0-dev.16'), 'stable', REPOSITORY),
    /prerelease/,
  );
});

test('selection accepts the newer feed for the channel, never downgrades and tolerates missing assets', () => {
  const devFeed = parseUpdateManifest(manifestDocument('1.0.0-dev.16'), 'dev', REPOSITORY);
  const stableFeed = parseUpdateManifest(manifestDocument('1.0.0'), 'stable', REPOSITORY);

  const newer = selectUpdateCandidate([stableFeed], '0.9.0', 'stable', 'darwin-arm64');
  assert.equal(newer.candidate?.version, '1.0.0');
  assert.equal(newer.hasChannelRelease, true);
  assert.equal(newer.candidate?.desktopUrl, stableFeed.assets[0]!.url);
  assert.equal(newer.candidate?.suiteUrl, stableFeed.assets[1]!.url);

  const current = selectUpdateCandidate([stableFeed], '1.0.0', 'stable', 'darwin-arm64');
  assert.equal(current.candidate, undefined);
  assert.equal(current.hasChannelRelease, true);

  assert.equal(
    selectUpdateCandidate([stableFeed], '1.0.0', 'stable', 'darwin-arm64').candidate,
    undefined,
    'never downgrades to an older manifest',
  );

  const dev = selectUpdateCandidate([devFeed], '1.0.0-dev.15', 'dev', 'darwin-arm64');
  assert.equal(dev.candidate?.version, '1.0.0-dev.16', 'dev channel accepts a dev/prerelease feed');
  assert.equal(dev.hasChannelRelease, true);

  const devNoUpdate = selectUpdateCandidate([devFeed], '1.0.0-dev.16', 'dev', 'darwin-arm64');
  assert.equal(devNoUpdate.candidate, undefined);
  assert.equal(devNoUpdate.hasChannelRelease, true);

  const stableRejectsPrerelease = selectUpdateCandidate([devFeed], '0.9.0', 'stable', 'darwin-arm64');
  assert.equal(stableRejectsPrerelease.candidate, undefined, 'stable never serves a prerelease');
  assert.equal(stableRejectsPrerelease.hasChannelRelease, false);

  const incomplete: UpdateManifest = { version: '1.0.0', assets: [manifest('1.0.0').assets[0]!] };
  const missing = selectUpdateCandidate([incomplete], '0.9.0', 'stable', 'darwin-arm64');
  assert.equal(missing.candidate, undefined);
  assert.equal(missing.hasChannelRelease, false);

  assert.equal(selectUpdateCandidate([], '0.9.0', 'stable', 'darwin-arm64').hasChannelRelease, false);
});

test('raw SHA-256 digest parser accepts exactly a bare 64 hex digest', () => {
  assert.equal(parseAssetDigest(DIGEST), DIGEST);
  assert.equal(parseAssetDigest(DIGEST.toUpperCase()), DIGEST);
  assert.throws(() => parseAssetDigest(`sha256:${DIGEST}`), /invalid asset digest/);
  assert.throws(() => parseAssetDigest('abc'), /invalid asset digest/);
});

function baseOptions(overrides: Partial<ConstructorParameters<typeof DesktopUpdateController>[0]> = {}): ConstructorParameters<typeof DesktopUpdateController>[0] {
  return {
    currentVersion: '1.0.0-dev.25',
    userDataPath: '/tmp/wrenyard-update-controller-fixture',
    platform: 'darwin',
    arch: 'arm64',
    updateBaseUrl: BASE_URL,
    settings: {
      loadUpdateChannel: () => 'dev',
      saveUpdateChannel: () => undefined,
    },
    ...overrides,
  } as ConstructorParameters<typeof DesktopUpdateController>[0];
}

test('dev channel offers the newer dev release from one complete feed document', async () => {
  const requests: string[] = [];
  const controller = new DesktopUpdateController(baseOptions({
    fetcher: async (input: string | URL | Request) => {
      requests.push(String(input));
      return metadataResponse(manifestJson('1.0.0-dev.26'));
    },
    now: () => 123_456,
  }));

  const available = await controller.check(true);
  assert.equal(available.state, 'available');
  assert.equal(available.availableVersion, '1.0.0-dev.26');
  assert.equal(available.checkedAt, 123_456);
  assert.deepEqual(requests, [`${BASE_URL}/dev.json`], 'exactly one metadata fetch');
  assert.equal(JSON.stringify(available).includes('github'), false);
});

test('stable channel offers the newer stable release from the identical schema', async () => {
  const requests: string[] = [];
  const controller = new DesktopUpdateController(baseOptions({
    settings: { loadUpdateChannel: () => 'stable', saveUpdateChannel: () => undefined },
    fetcher: async (input: string | URL | Request) => {
      requests.push(String(input));
      return metadataResponse(manifestJson('1.0.1'));
    },
  }));

  const snapshot = await controller.check(true);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.availableVersion, '1.0.1');
  assert.deepEqual(requests, [`${BASE_URL}/stable.json`]);
  assert.equal(snapshot.channel, 'stable');
});

test('a missing stable feed reports stable-unavailable instead of an error or invented release', async () => {
  const requests: string[] = [];
  const controller = new DesktopUpdateController(baseOptions({
    settings: { loadUpdateChannel: () => 'stable', saveUpdateChannel: () => undefined },
    fetcher: async (input: string | URL | Request) => {
      requests.push(String(input));
      return notFound();
    },
  }));

  const snapshot = await controller.check(true);
  assert.equal(snapshot.state, 'stable-unavailable');
  assert.equal(snapshot.availableVersion, undefined);
  assert.deepEqual(requests, [`${BASE_URL}/stable.json`]);
});

test('non-404 stable feed failure fails closed for a manual check', async () => {
  const controller = new DesktopUpdateController(baseOptions({
    settings: { loadUpdateChannel: () => 'stable', saveUpdateChannel: () => undefined },
    fetcher: async () => metadataResponse({ message: 'boom' }, 500),
  }));

  const manual = await controller.check(true);
  assert.equal(manual.state, 'check-failed');
  assert.equal(manual.availableVersion, undefined);

  const automatic = await controller.check(false);
  assert.equal(automatic.state, 'check-failed');
});

test('a malformed channel feed fails closed without inventing an update', async () => {
  const controller = new DesktopUpdateController(baseOptions({
    fetcher: async () => metadataResponse(manifestDocument('1.0.0-dev.26').assets
      ? { schema_version: 'wrenyard.update.v1', version: '1.0.0-dev.26', assets: [] }
      : {}),
  }));

  const manual = await controller.check(true);
  assert.equal(manual.state, 'check-failed');
  assert.equal(manual.availableVersion, undefined);
});

test('manual check failure is friendly while automatic failure stays silent', async () => {
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: '/tmp/wrenyard-update-controller-failure',
    fetcher: async () => { throw new Error('token=secret internal path'); },
    now: () => 99,
  }));

  const automatic = await controller.check(false);
  assert.equal(automatic.state, 'idle');
  assert.equal(automatic.message, undefined);

  const manual = await controller.check(true);
  assert.equal(manual.state, 'check-failed');
  assert.equal(manual.message, '暂时无法检查更新，请检查网络连接后重试。');
  assert.equal(JSON.stringify(manual).includes('secret'), false);
});

test('channel switch fetches and caches each channel feed separately', async () => {
  const requests: string[] = [];
  let channel: 'stable' | 'dev' = 'dev';
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: '/tmp/wrenyard-update-controller-cache',
    settings: {
      loadUpdateChannel: () => channel,
      saveUpdateChannel: (next) => { channel = next; },
    },
    fetcher: async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const version = url.includes('dev.json') ? '1.0.0-dev.26' : '1.0.0';
      return metadataResponse(manifestJson(version));
    },
    now: () => 1_000,
  }));

  const dev = await controller.check(true);
  assert.equal(dev.availableVersion, '1.0.0-dev.26');

  const stable = await controller.setChannel('stable');
  assert.equal(channel, 'stable');
  assert.equal(stable.availableVersion, '1.0.0');
  assert.deepEqual(requests, [`${BASE_URL}/dev.json`, `${BASE_URL}/stable.json`]);

  await controller.check(true);
  await controller.check(true);
  assert.equal(requests.length, 2, 'each channel reuses its own hourly cache');
});

test('default update base url derives from the repository option', async () => {
  const requests: string[] = [];
  const controller = new DesktopUpdateController(baseOptions({
    updateBaseUrl: undefined,
    repository: 'acme/fork',
    fetcher: async (input: string | URL | Request) => {
      requests.push(String(input));
      return metadataResponse(manifestJson('1.0.0-dev.26'));
    },
  }));

  await controller.check(true);
  assert.deepEqual(
    requests,
    ['https://raw.githubusercontent.com/acme/fork/updates/dev.json'],
    'the default base url follows the repository option',
  );
});

test('atomic installation is available on the two maintained platforms only', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-platform-'));
  const base = {
    currentVersion: '1.0.0-dev.20',
    settings: {
      loadUpdateChannel: () => 'dev' as const,
      saveUpdateChannel: () => undefined,
    },
    cliPath: '/suite/wrenyard',
    helperPath: writeDummyHelper(root),
    helperRuntimePath: '/suite/node',
    userDataPath: '/user/data',
  };
  assert.equal(new DesktopUpdateController({ ...base, platform: 'darwin', arch: 'arm64' }).snapshot().installSupported, true);
  assert.equal(new DesktopUpdateController({ ...base, platform: 'win32', arch: 'x64' }).snapshot().installSupported, true);

  // An unsupported platform reports the platform reason, never a missing path.
  const linux = new DesktopUpdateController({ ...base, platform: 'linux', arch: 'x64' }).snapshot();
  assert.equal(linux.installSupported, false);
  assert.equal(linux.installReason, 'unsupported-platform');

  const noRuntime = new DesktopUpdateController({
    ...base,
    helperRuntimePath: undefined,
    platform: 'darwin',
    arch: 'arm64',
  }).snapshot();
  assert.equal(noRuntime.installSupported, false);
  assert.equal(noRuntime.installReason, 'missing-runtime');

  rmSync(root, { recursive: true, force: true });
});

test('installation capability is re-probed on every check instead of frozen at startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-reprobe-'));
  const helper = join(root, 'update-helper.cjs');
  let discovery: { cliPath?: string; runtimePath?: string; reason?: 'missing-cli' | 'missing-runtime' } = {
    reason: 'missing-cli',
  };
  // The helper is present from the start: only the CLI is missing at startup.
  writeDummyHelper(root);
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    helperPath: helper,
    probeInstallation: () => discovery,
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
  }));

  // Startup: the suite is missing, so installs are refused with the reason.
  assert.equal(controller.snapshot().installSupported, false);
  assert.equal(controller.snapshot().installReason, 'missing-cli');

  // The installation is repaired on disk after startup.
  discovery = { cliPath: '/suite/wrenyard', runtimePath: '/suite/node' };
  writeDummyHelper(root);

  // A manual check must notice and enable installation without a restart.
  const checked = await controller.check(true);
  assert.equal(checked.installSupported, true);
  assert.equal(checked.installReason, undefined);
  assert.equal(checked.state, 'available');

  // Removing the helper is detected by the next check, with the precise reason.
  rmSync(helper, { force: true });
  const removed = await controller.check(true);
  assert.equal(removed.installSupported, false);
  assert.equal(removed.installReason, 'missing-helper');

  // Restoring it is detected on the following check, without a restart.
  writeDummyHelper(root);
  const restored = await controller.check(true);
  assert.equal(restored.installSupported, true);
  assert.equal(restored.installReason, undefined);

  rmSync(root, { recursive: true, force: true });
});

test('an installation repaired after startup installs instead of failing on the stale verdict', async () => {
  let launched = 0;
  let preparedCount = 0;
  let discovery: { cliPath?: string; runtimePath?: string; reason?: 'missing-cli' | 'missing-runtime' } = {
    reason: 'missing-runtime',
  };
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    helperPath: ensureHelper(root),
    probeInstallation: () => discovery,
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    activeTaskCount: async () => 0,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => {
      preparedCount += 1;
      return { candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root] };
    },
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  }));

  // Startup verdict: no runtime, so an authorized install fails closed.
  await controller.check(true);
  const refused = await controller.requestInstall();
  assert.equal(refused.state, 'install-failed');
  assert.match(refused.message ?? '', /Node 运行时/u);
  assert.equal(preparedCount, 0);
  assert.equal(launched, 0);

  // The runtime is restored, then a fresh authorization must succeed.
  discovery = { cliPath: join(root, 'wrenyard'), runtimePath: join(root, 'node') };
  await controller.requestInstall();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparedCount, 1, 'the repaired installation prepares the update');
  assert.equal(launched, 1, 'the repaired installation launches the helper');
  assert.equal(controller.snapshot().state, 'installing');

  rmSync(root, { recursive: true, force: true });
});

test('a capability lost after startup blocks the launch and never installs', async () => {
  let launched = 0;
  let discovery: { cliPath?: string; runtimePath?: string; reason?: 'missing-cli' | 'missing-runtime' } = {
    cliPath: '/suite/wrenyard',
    runtimePath: '/suite/node',
  };
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    helperPath: ensureHelper(root),
    probeInstallation: () => discovery,
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    activeTaskCount: async () => 0,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  }));

  // The suite disappears between authorization and the launch.
  discovery = { cliPath: '/suite/wrenyard', reason: 'missing-runtime' };
  const installed = await controller.requestInstall();
  assert.equal(launched, 0, 'no launch without a resolvable CLI/runtime pair');
  assert.equal(installed.state, 'install-failed');
  assert.match(installed.message ?? '', /Node 运行时/u);

  rmSync(root, { recursive: true, force: true });
});

test('daemon status projects the real active task count and fails closed on other active work', () => {
  const status = {
    ok: true,
    mode: 'accepting',
    frozen: false,
    recovery_required: false,
    activeTaskCount: 2,
    activeWorkflowCount: 1,
    activeExecutionCount: 3,
  };
  assert.equal(activeTaskCountFromDaemonStatus(status, 2), 4);
  assert.equal(activeTaskCountFromDaemonStatus({
    ...status,
    activeTaskCount: 0,
    activeWorkflowCount: 0,
    activeExecutionCount: 1,
  }, 0), null);
  assert.equal(activeTaskCountFromDaemonStatus({ ...status, activeExecutionCount: -1 }, 0), null);
  assert.equal(activeTaskCountFromDaemonStatus({ ...status, mode: 'planned_restart' }, 0), null);
});

test('startup surfaces a precise sanitized helper failure and rejects unsafe result text', () => {
  const root = fakeUpdateRoot();
  const userDataPath = join(root, 'data');
  mkdirSync(userDataPath, { recursive: true });
  try {
    writeFileSync(join(userDataPath, 'update-result.json'), JSON.stringify({
      status: 'failed',
      version: '1.0.0-dev.26',
      message: 'Daemon 套件升级失败（退出码 7）；已恢复原 Desktop',
    }));
    const precise = new DesktopUpdateController(baseOptions({ userDataPath })).snapshot();
    assert.equal(precise.state, 'install-failed');
    assert.equal(precise.message, 'Daemon 套件升级失败（退出码 7）；已恢复原 Desktop');

    writeFileSync(join(userDataPath, 'update-result.json'), JSON.stringify({
      status: 'failed',
      version: '1.0.0-dev.26',
      message: 'token=secret C:\\Users\\private',
    }));
    const sanitized = new DesktopUpdateController(baseOptions({ userDataPath })).snapshot();
    assert.equal(sanitized.message, '更新未完成，已恢复到当前版本，你的工作环境未受影响。');
    assert.equal(JSON.stringify(sanitized).includes('secret'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows Desktop extraction invokes SystemRoot System32 tar with safe libarchive flags and propagates failure', async () => {
  const root = fakeUpdateRoot();
  const archiveBytes = Buffer.from('not a zip');
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  const document = manifestDocument('1.0.0-dev.26') as { assets: Array<Record<string, unknown>> };
  const desktopAsset = document.assets.find((entry) => entry.name === 'wrenyard-desktop-1.0.0-dev.26-win32-x64.zip')!;
  desktopAsset.sha256 = digest;
  const invocations: Array<{ command: string; args: string[] }> = [];
  try {
    const controller = new DesktopUpdateController(baseOptions({
      userDataPath: join(root, 'data'),
      platform: 'win32',
      arch: 'x64',
      cliPath: join(root, 'wrenyard.exe'),
      helperPath: ensureHelper(root),
      helperRuntimePath: join(root, 'node.exe'),
      windowsTarPath: resolveWindowsSystemTarPath('D:\\Windows'),
      desktopPath: join(root, 'Programs', 'Wrenyard Desktop'),
      fetcher: async (input: string | URL | Request) => String(input).endsWith('.json')
        ? metadataResponse(document)
        : new Response(archiveBytes, { headers: { 'content-length': String(archiveBytes.length) } }),
      commandRunner: async (command, args) => {
        invocations.push({ command, args });
        return { status: 9, stdout: '', stderr: 'token=secret malformed archive' };
      },
    }));
    await controller.check(true);
    const failed = await controller.requestInstall();
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]!.command, 'D:\\Windows\\System32\\tar.exe');
    assert.deepEqual(invocations[0]!.args.slice(0, 4), ['-x', '--no-same-owner', '--no-same-permissions', '-f']);
    assert.ok(invocations[0]!.args.includes('-C'));
    assert.equal(failed.state, 'install-failed');
    assert.match(failed.message ?? '', /tar\.exe.*exit 9/u);
    assert.equal((failed.message ?? '').includes('secret'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hostLibarchive = process.platform === 'win32'
  ? resolveWindowsSystemTarPath(process.env.SystemRoot)
  : '/usr/bin/tar';
const hostTarVersion = existsSync(hostLibarchive)
  ? spawnSync(hostLibarchive, ['--version'], { encoding: 'utf8' })
  : null;
const hasHostLibarchive = hostTarVersion?.status === 0
  && /bsdtar|libarchive/iu.test(`${hostTarVersion.stdout}${hostTarVersion.stderr}`);

test('native libarchive really extracts a ZIP into a >277-character unicode/space path', {
  skip: hasHostLibarchive ? false : 'native libarchive tar is unavailable on this host',
}, async () => {
  const root = fakeUpdateRoot();
  try {
    const source = join(root, 'archive source', '桌面 包');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'wrenyard-desktop.exe'), 'desktop executable');
    writeFileSync(join(source, '说明 文档.txt'), 'unicode and spaces');
    const archive = join(root, 'desktop fixture.zip');
    const created = spawnSync(hostLibarchive, ['-a', '-c', '-f', archive, '-C', join(root, 'archive source'), '.'], {
      encoding: 'utf8',
    });
    assert.equal(created.status, 0, created.stderr);
    const archiveBytes = readFileSync(archive);
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    const document = manifestDocument('1.0.0-dev.26') as { assets: Array<Record<string, unknown>> };
    const desktopAsset = document.assets.find((entry) => entry.name === 'wrenyard-desktop-1.0.0-dev.26-win32-x64.zip')!;
    desktopAsset.sha256 = digest;
    const longParent = join(root,
      'long path segment 00000000000000000000000000000000000000000000000000',
      'long path segment 11111111111111111111111111111111111111111111111111',
      'long path segment 22222222222222222222222222222222222222222222222222',
      'long path segment 33333333333333333333333333333333333333333333333333');
    const userDataPath = join(longParent, '用户 数据');
    assert.ok(join(userDataPath, '.wrenyard-update-fixture', 'extract').length > 277);
    let extractionDestination = '';
    const controller = new DesktopUpdateController(baseOptions({
      userDataPath,
      platform: 'win32',
      arch: 'x64',
      cliPath: join(root, 'wrenyard.exe'),
      helperPath: ensureHelper(root),
      helperRuntimePath: join(root, 'node.exe'),
      windowsTarPath: hostLibarchive,
      desktopPath: join(longParent, 'Programs', 'Wrenyard Desktop'),
      activeTaskCount: async () => 1,
      fetcher: async (input: string | URL | Request) => String(input).endsWith('.json')
        ? metadataResponse(document)
        : new Response(archiveBytes, { headers: { 'content-length': String(archiveBytes.length) } }),
      commandRunner: async (command, args) => {
        extractionDestination = args[args.indexOf('-C') + 1]!;
        const result = spawnSync(command, args, { encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      },
      scheduler: isolatedScheduler(),
    }));
    await controller.check(true);
    const waiting = await controller.requestInstall();
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.activeTaskCount, 1);
    assert.ok(extractionDestination.length > 277, extractionDestination);
    assert.equal(readFileSync(join(extractionDestination, '桌面 包', '说明 文档.txt'), 'utf8'), 'unicode and spaces');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    return metadataResponse(manifestJson('1.0.0-dev.26'));
  };
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: '/tmp/wrenyard-update-controller-scheduling',
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
  }));

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
  assert.equal(checkCount, 2, 'the channel feed is refreshed after its hourly cache expires');

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

/** A real, empty helper file: the updater only installs from an on-disk helper. */
function writeDummyHelper(root: string, name = 'update-helper.cjs'): string {
  const helper = join(root, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(helper, '');
  return helper;
}

/** Fixture helper path: real and present, so the install capability holds. */
function ensureHelper(root: string): string {
  return writeDummyHelper(root);
}

function fakeUpdateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-test-'));
  writeDummyHelper(root);
  return root;
}

test('explicit request prepares once while busy, waits without launching, then installs when idle', async () => {
  let activeTaskCount = 3;
  let preparedCount = 0;
  let launched = 0;
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    cliPath: '/suite/wrenyard',
    helperPath: ensureHelper(root),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    activeTaskCount: async () => activeTaskCount,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => {
      preparedCount += 1;
      return { candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root] };
    },
    spawnDetached: () => { launched += 1; },
    onInstall: () => undefined,
    scheduler: isolatedScheduler(),
  }));

  const waiting = await controller.requestInstall();
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.activeTaskCount, 3);
  assert.equal(waiting.message, '正在等待 3 个活跃任务完成。');
  assert.equal(preparedCount, 1, 'prepared exactly once even while busy');
  assert.equal(launched, 0, 'must not launch while busy');

  // A second authorization while still busy must reuse the staged artifact.
  await controller.requestInstall();
  assert.equal(preparedCount, 1, 'preparation is never repeated');

  activeTaskCount = 0;
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
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    cliPath: '/suite/wrenyard',
    helperPath: ensureHelper(root),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    isBusy: async () => busy,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  }));

  const waiting = await controller.requestInstall();
  assert.equal(waiting.state, 'waiting');
  const cancelled = controller.cancelPendingInstall();
  assert.equal(cancelled.state, 'available', 'returns to available, retaining staged artifact');
  assert.notEqual(cancelled.state, 'up-to-date', 'must not report success');
  assert.equal(controller.getLastAttempt()?.status, 'cancelled', 'cancellation closes the attempt record');
  assert.equal(controller.getLastAttempt()?.phase, 'waiting');

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
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: '/tmp/wrenyard-update-controller-automatic',
    cliPath: '/suite/wrenyard',
    helperPath: '/app/update-helper.cjs',
    helperRuntimePath: '/suite/node',
    desktopPath: '/app',
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    spawnDetached: () => { launched += 1; },
    scheduler,
  }));

  const snapshot = await controller.check(false);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.availableVersion, '1.0.0-dev.26');
  assert.equal(launched, 0);
  assert.equal(controller.snapshot().state, 'available');
});

test('preparation failure preserves the current version and reports a friendly error', async () => {
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    cliPath: '/suite/wrenyard',
    helperPath: ensureHelper(root),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    isBusy: async () => false,
    prepareCandidate: async () => { throw new Error('checksum mismatch internal token'); },
    scheduler: isolatedScheduler(),
  }));

  await controller.check(true);
  const failed = await controller.requestInstall();
  assert.equal(failed.state, 'install-failed');
  assert.equal(failed.currentVersion, '1.0.0-dev.25');
  assert.equal((failed.message ?? '').includes('token'), false);

  rmSync(root, { recursive: true, force: true });
});

test('a failed preparation leaves sanitized diagnostics that survive restart and later checks', async () => {
  const root = fakeUpdateRoot();
  const userDataPath = join(root, 'data');
  try {
    const controller = new DesktopUpdateController(baseOptions({
      userDataPath,
      cliPath: '/suite/wrenyard',
      helperPath: ensureHelper(root),
      helperRuntimePath: '/suite/node',
      desktopPath: join(root, 'app'),
      fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
      isBusy: async () => false,
      prepareCandidate: async () => {
        throw new Error('desktop checksum mismatch token=hunter2 Authorization: Bearer opaque-credential \"access_token\":\"json-credential\" https://github.test/a /Users/private/staged /private/var/folders/temp');
      },
      now: () => 4_000,
      scheduler: isolatedScheduler(),
    }));

    await controller.check(true);
    assert.equal(controller.getLastAttempt(), undefined, 'discovery alone never records an attempt');

    const failed = await controller.requestInstall();
    assert.equal(failed.state, 'install-failed');
    const attempt = controller.getLastAttempt()!;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.phase, 'checksum', 'the generic message hides the step; the record keeps it');
    assert.equal(attempt.sourceVersion, '1.0.0-dev.25');
    assert.equal(attempt.targetVersion, '1.0.0-dev.26');
    assert.equal(attempt.startedAt, 4_000);
    assert.equal(attempt.completedAt, 4_000);
    assert.equal(attempt.error?.includes('hunter2'), false);
    assert.equal(attempt.error?.includes('opaque-credential'), false);
    assert.equal(attempt.error?.includes('json-credential'), false);
    assert.deepEqual(failed.lastAttempt, attempt);
    assert.equal(attempt.error?.includes('github.test'), false);
    assert.equal(attempt.error?.includes('private'), false);
    assert.match(attempt.error ?? '', /desktop checksum mismatch/u);

    // The record lives in userData, outside every cleanup root the update uses.
    assert.equal(existsSync(join(userDataPath, UPDATE_ATTEMPT_FILENAME)), true);
    assert.deepEqual(readUpdateAttempt(userDataPath), attempt);

    // A restart plus a fresh version check must not erase the diagnosis.
    const restarted = new DesktopUpdateController(baseOptions({
      userDataPath,
      fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    }));
    assert.deepEqual(restarted.getLastAttempt(), attempt);
    await restarted.check(true);
    assert.deepEqual(restarted.getLastAttempt(), attempt, 'a recheck never overwrites the record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a helper that cannot be launched records the launch phase instead of vanishing', async () => {
  const root = fakeUpdateRoot();
  const userDataPath = join(root, 'data');
  try {
    const controller = new DesktopUpdateController(baseOptions({
      userDataPath,
      cliPath: '/suite/wrenyard',
      helperPath: ensureHelper(root),
      helperRuntimePath: '/suite/node',
      desktopPath: join(root, 'app'),
      fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
      activeTaskCount: async () => 0,
      prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
        candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
      }),
      spawnDetached: () => { throw new Error('spawn helper failed for /Users/private/node'); },
      scheduler: isolatedScheduler(),
    }));

    const failed = await controller.requestInstall();
    assert.equal(failed.state, 'install-failed');
    const attempt = readUpdateAttempt(userDataPath)!;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.phase, 'launch-helper');
    assert.equal(attempt.error?.includes('private'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct launchPreparedUpdate cannot bypass the busy safety gate', async () => {
  let launched = 0;
  const root = fakeUpdateRoot();
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    cliPath: '/suite/wrenyard',
    helperPath: ensureHelper(root),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    isBusy: async () => true,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    spawnDetached: () => { launched += 1; },
    scheduler: isolatedScheduler(),
  }));

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
  const controller = new DesktopUpdateController(baseOptions({
    userDataPath: join(root, 'data'),
    cliPath: '/suite/wrenyard',
    helperPath: ensureHelper(root),
    helperRuntimePath: '/suite/node',
    desktopPath: join(root, 'app'),
    fetcher: async () => metadataResponse(manifestJson('1.0.0-dev.26')),
    isBusy: async () => busy,
    prepareCandidate: async (candidate: UpdateCandidate): Promise<PreparedUpdate> => ({
      candidate, stagedDesktop: join(root, 'staged'), cleanupRoots: [root],
    }),
    scheduler,
  }));

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
