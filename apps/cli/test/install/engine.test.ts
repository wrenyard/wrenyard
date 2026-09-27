import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  UPDATE_FEED_SCHEMA_VERSION,
  desktopAssetName,
  suiteAssetName,
} from '@wrenyard/protocol/update-feed';
import type { PlatformTriplet } from '@wrenyard/protocol/update-feed';
import { runInstallEngine } from '../../src/install/engine.js';
import type { ControlBridge, InstallEngineOptions } from '../../src/install/engine.js';
import type { CommandRunner } from '../../src/install/platform.js';
import {
  MACOS_DITTO,
  DESKTOP_APP_NAME,
  desktopAppDir,
} from '../../src/install/platform.js';
import {
  InstallLockHeldError,
  acquireInstallLock,
  readCurrent,
  readInstallState,
  recoverInterrupted,
  writeInstallState,
} from '../../src/install/filesystem.js';

const FROM = '1.0.0-dev.1';
const TO = '1.0.0-dev.2';
const TRIPLET = 'darwin-arm64';
const DEAD_PID = 2_147_483_647;

interface Call {
  command: string;
  args: string[];
}

interface Harness {
  root: string;
  prefix: string;
  home: string;
  stateHome: string;
  env: NodeJS.ProcessEnv;
  logs: string[];
  calls: Call[];
  downloads: string[];
  running: { desktop: boolean; daemon: boolean };
  runner: CommandRunner;
  control: ControlBridge;
  cleanup(): void;
}

function suiteVersionFromZip(zip: string): string {
  const match = /^wrenyard-(?:desktop-)?(.+?)-(?:darwin-arm64|win32-x64)(?:-suite)?\.zip$/.exec(basename(zip));
  return match?.[1] ?? TO;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-engine-'));
  const prefix = join(root, 'prefix');
  const home = join(root, 'home');
  const stateHome = join(root, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    WRENYARD_STATE_HOME: stateHome,
    PATH: '/usr/bin:/bin',
  };
  const logs: string[] = [];
  const calls: Call[] = [];
  const downloads: string[] = [];
  const running = { desktop: false, daemon: false };

  const ok = (stdout = ''): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout,
    stderr: '',
  });

  const extractInto = (dest: string, zip: string): void => {
    mkdirSync(dest, { recursive: true });
    if (basename(zip).includes('desktop')) {
      const exe = join(dest, DESKTOP_APP_NAME, 'Contents', 'MacOS', '啾啾工坊');
      mkdirSync(join(exe, '..'), { recursive: true });
      writeFileSync(exe, '#!/bin/sh\nexit 0\n');
      return;
    }
    const version = suiteVersionFromZip(zip);
    writeFileSync(join(dest, 'wrenyard'), '#!/bin/sh\necho wrenyard\n');
    mkdirSync(join(dest, 'runtime'), { recursive: true });
    writeFileSync(join(dest, 'runtime', 'node'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(dest, 'SUITE_VERSION'), `${version}\n`);
  };

  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    if (command === MACOS_DITTO) {
      extractInto(args[3] as string, args[2] as string);
      return ok();
    }
    if (command === 'codesign') return ok();
    if (command === 'pgrep') return running.desktop ? ok() : { status: 1, stdout: '', stderr: '' };
    if (command === 'tasklist') return ok();
    if (command.includes('lsregister')) return ok();
    if (command === '/usr/bin/open') return ok();
    if (command.endsWith('wrenyard') || command.endsWith('wrenyard.exe')) {
      if (args[0] === '--version') {
        const stamped = readFileSync(join(dirname(command), 'SUITE_VERSION'), 'utf8').trim();
        return ok(`${stamped}\n`);
      }
      if (args[0] === 'daemon' && args[1] === 'start') {
        running.daemon = true;
        return ok();
      }
      if (args[0] === 'service' && args[1] === 'status') {
        if (!running.daemon) return { status: 1, stdout: '', stderr: 'not running' };
        return ok(
          JSON.stringify({ ok: true, daemon: { running: true, suiteRoot: join(prefix, 'current') } }),
        );
      }
      return ok();
    }
    return ok();
  };

  const control: ControlBridge = async (args) => {
    if (args.join(' ').includes('daemon stop')) {
      running.daemon = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, daemon: { running: running.daemon, suiteRoot: join(prefix, 'current') } }),
      stderr: '',
    };
  };

  return {
    root,
    prefix,
    home,
    stateHome,
    env,
    logs,
    calls,
    downloads,
    running,
    runner,
    control,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseOptions(h: Harness): InstallEngineOptions {
  return {
    mode: 'install',
    prefix: h.prefix,
    binDir: join(h.home, '.local', 'bin'),
    env: h.env,
    platform: 'darwin',
    arch: 'arm64',
    runner: h.runner,
    control: h.control,
    log: (line) => h.logs.push(line),
    installSignalHandlers: false,
    pollIntervalMs: 5,
    healthTimeoutMs: 40,
    desktopWaitTimeoutMs: 40,
  };
}

/** Seeds `<prefix>/versions/<v>` with a suite stamp and points `current` at it. */
function seedInstalled(h: Harness, version: string): string {
  const dir = join(h.prefix, 'versions', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SUITE_VERSION'), `${version}\n`);
  writeFileSync(join(dir, 'wrenyard'), '#!/bin/sh\necho wrenyard\n');
  rmSync(join(h.prefix, 'current'), { recursive: true, force: true });
  symlinkSync(join('versions', version), join(h.prefix, 'current'));
  return join(dir, 'wrenyard');
}

function seedDesktop(h: Harness, version: string): void {
  const app = desktopAppDir(h.env, 'darwin');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', '啾啾工坊'), '#!/bin/sh\n');
  writeFileSync(join(h.prefix, 'desktop-version'), `${version}\n`);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Fake network: serves the update feed and streams digest-matching asset bodies. */
function feedFetch(h: Harness, version: string, triplet: PlatformTriplet = TRIPLET): typeof fetch {
  const suiteUrl = `https://example.test/${suiteAssetName(version, triplet)}`;
  const desktopUrl = `https://example.test/${desktopAssetName(version, triplet)}`;
  const bodies = new Map<string, string>([
    [suiteUrl, `suite:${version}:${triplet}`],
    [desktopUrl, `desktop:${version}:${triplet}`],
  ]);
  const document = {
    schema_version: UPDATE_FEED_SCHEMA_VERSION,
    version,
    published_at: '2026-09-26T00:00:00Z',
    assets: [
      {
        name: suiteAssetName(version, triplet),
        url: suiteUrl,
        sha256: sha256Hex(bodies.get(suiteUrl) as string),
      },
      {
        name: desktopAssetName(version, triplet),
        url: desktopUrl,
        sha256: sha256Hex(bodies.get(desktopUrl) as string),
      },
    ],
  };
  return (async (url: string) => {
    const body = bodies.get(url);
    if (body !== undefined) {
      h.downloads.push(url);
      return { ok: true, status: 200, body: new Blob([body]).stream() } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(document) } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('install places the suite, switches current, creates the launcher and Desktop', async (t) => {
  const h = makeHarness();
  t.after(() => h.cleanup());
  const resultFile = join(h.root, 'update-result.json');
  const outcome = await runInstallEngine({
    ...baseOptions(h),
    fetchImpl: feedFetch(h, TO),
    resultFile,
  });
  assert.equal(outcome.status, 'ok', outcome.message);
  assert.deepEqual(h.downloads, [
    `https://example.test/${suiteAssetName(TO, TRIPLET)}`,
    `https://example.test/${desktopAssetName(TO, TRIPLET)}`,
  ]);
  assert.equal(readlinkSync(join(h.prefix, 'current')), join('versions', TO));
  assert.equal(readFileSync(join(h.prefix, 'versions', TO, 'SUITE_VERSION'), 'utf8').trim(), TO);
  assert.ok(existsSync(join(h.home, '.local', 'bin', 'wrenyard')));
  assert.ok(existsSync(desktopAppDir(h.env, 'darwin')));
  assert.equal(readFileSync(join(h.prefix, 'desktop-version'), 'utf8').trim(), TO);
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).status, 'ok');
  assert.equal(readInstallState(h.prefix), null);
  assert.ok(!readdirSync(h.prefix).some((name) => name.startsWith('.staging-')));
});

test('artifacts digest mismatch rejects before any system change', async (t) => {
  const h = makeHarness();
  t.after(() => h.cleanup());
  const dir = join(h.root, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, suiteAssetName(TO, TRIPLET));
  writeFileSync(zip, 'not the real archive');
  writeFileSync(`${zip}.sha256`, `${'c'.repeat(64)}  ${basename(zip)}\n`);
  const outcome = await runInstallEngine({
    ...baseOptions(h),
    artifactsDir: dir,
    noDesktop: true,
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message ?? '', /sha256 mismatch/);
  assert.ok(!existsSync(join(h.prefix, 'versions', TO)));
  assert.equal(readCurrent(h.prefix), null);
});

test('a failed health check rolls back current, the new version and install-state', async (t) => {
  const h = makeHarness();
  t.after(() => h.cleanup());
  const exe = seedInstalled(h, FROM);
  seedDesktop(h, FROM);
  h.running.daemon = true;
  // The restarted daemon keeps reporting the old suite root.
  const runner: CommandRunner = (command, args) => {
    if (args[0] === 'service' && args[1] === 'status') {
      h.calls.push({ command, args });
      return { status: 0, stdout: JSON.stringify({ ok: true, daemon: { running: true, suiteRoot: join(h.prefix, 'versions', FROM) } }), stderr: '' };
    }
    return h.runner(command, args, {});
  };
  const outcome = await runInstallEngine({
    ...baseOptions(h),
    mode: 'update',
    execPath: exe,
    fetchImpl: feedFetch(h, TO),
    runner,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.rolledBack, true);
  assert.match(outcome.message ?? '', /identity mismatch|health check/);
  assert.equal(readlinkSync(join(h.prefix, 'current')), join('versions', FROM));
  assert.ok(!existsSync(join(h.prefix, 'versions', TO)));
  assert.equal(readInstallState(h.prefix), null);
});

test('update switches current to the new version and restarts the daemon', async (t) => {
  const h = makeHarness();
  t.after(() => h.cleanup());
  const exe = seedInstalled(h, FROM);
  seedDesktop(h, FROM);
  h.running.daemon = true;
  const outcome = await runInstallEngine({
    ...baseOptions(h),
    mode: 'update',
    execPath: exe,
    fetchImpl: feedFetch(h, TO),
  });
  assert.equal(outcome.status, 'ok', outcome.message);
  assert.equal(readlinkSync(join(h.prefix, 'current')), join('versions', TO));
  const launcher = join(h.prefix, 'current', 'wrenyard');
  const starts = h.calls.filter(
    (call) => call.command === launcher && call.args[0] === 'daemon' && call.args[1] === 'start',
  );
  assert.equal(starts.length, 1);
  assert.equal(readFileSync(join(h.prefix, 'desktop-version'), 'utf8').trim(), TO);
});

test('recovery restores current, renames .old dirs and prunes dead staging', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-recover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  for (const version of [FROM, TO]) {
    const dir = join(prefix, 'versions', version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SUITE_VERSION'), `${version}\n`);
  }
  symlinkSync(join('versions', TO), join(prefix, 'current'));
  mkdirSync(join(prefix, 'versions', '.1.2.3.old-999'), { recursive: true });
  mkdirSync(join(prefix, `.staging-${DEAD_PID}`), { recursive: true });
  mkdirSync(join(prefix, `.staging-${process.pid}`), { recursive: true });
  writeInstallState(prefix, { pid: DEAD_PID, to: TO, previous_current: join('versions', FROM) });

  await recoverInterrupted(prefix, 'darwin', () => {}, process.pid);
  assert.equal(readlinkSync(join(prefix, 'current')), join('versions', FROM));
  assert.ok(existsSync(join(prefix, 'versions', '1.2.3')));
  assert.ok(!existsSync(join(prefix, 'versions', '.1.2.3.old-999')));
  assert.ok(!existsSync(join(prefix, `.staging-${DEAD_PID}`)));
  assert.ok(existsSync(join(prefix, `.staging-${process.pid}`)), 'live staging must be skipped');
  assert.equal(readInstallState(prefix), null);
});

test('the install lock fails for a live holder and is taken over from a dead one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  const release = acquireInstallLock(prefix, process.pid, Date.now);
  t.after(() => release());
  assert.throws(() => acquireInstallLock(prefix, process.pid + 1, Date.now), InstallLockHeldError);

  writeFileSync(join(prefix, 'install.lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x' }));
  const takeover = acquireInstallLock(prefix, process.pid + 1, Date.now);
  assert.ok(existsSync(join(prefix, 'install.lock')));
  takeover();
  assert.ok(!existsSync(join(prefix, 'install.lock')));
});
