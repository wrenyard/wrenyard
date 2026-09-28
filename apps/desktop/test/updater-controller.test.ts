import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { UPDATE_FEED_SCHEMA_VERSION, installerAssetName, updateAssetName } from '@wrenyard/protocol/update-feed';
import { DesktopUpdateController, type UpdateScheduler } from '../src/updater/controller.js';
import type { PlatformApplier, PreparedUpdate, UpdateBlocker } from '../src/updater/types.js';

const CURRENT = '1.0.0-dev.42';
const NEXT = '1.0.0-dev.43';
const BASE = 'https://updates.test';
const PAYLOAD = Buffer.from('verified setup payload');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-updater-'));
  tempDirs.push(dir);
  return dir;
}

function feed(version: string, sha256 = PAYLOAD_SHA): string {
  return JSON.stringify({
    schema_version: UPDATE_FEED_SCHEMA_VERSION,
    version,
    published_at: '2026-09-28T00:00:00.000Z',
    assets: [
      { name: installerAssetName(version, 'darwin-arm64'), url: `${BASE}/a.dmg`, sha256: 'a'.repeat(64) },
      { name: updateAssetName(version, 'darwin-arm64'), url: `${BASE}/a.zip`, sha256: 'b'.repeat(64) },
      { name: installerAssetName(version, 'win32-x64'), url: `${BASE}/setup.exe`, sha256 },
    ],
  });
}

function fakeFetch(feedText: string, payload = PAYLOAD): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('.json')) return new Response(feedText, { status: 200 });
    if (url.endsWith('setup.exe')) return new Response(payload, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

class FakeApplier implements PlatformApplier {
  readonly calls: string[] = [];
  blocker: UpdateBlocker | null = null;
  applied?: PreparedUpdate;

  async preflight(stage: 'startup' | 'update'): Promise<UpdateBlocker | null> {
    this.calls.push(`preflight:${stage}`);
    return this.blocker;
  }

  async prepare(assetPath: string, version: string): Promise<PreparedUpdate> {
    this.calls.push('prepare');
    assert.deepEqual(readFileSync(assetPath), PAYLOAD, 'the applier only ever sees the verified download');
    return { assetPath, version };
  }

  apply(prepared: PreparedUpdate): void {
    this.calls.push('apply');
    this.applied = prepared;
  }

  async finalize(): Promise<void> {
    this.calls.push('finalize');
  }
}

const manualScheduler: UpdateScheduler & { pending: Array<() => void> } = {
  pending: [],
  setTimeout(handler) { this.pending.push(handler); return this.pending.length; },
  clearTimeout() {},
  setInterval() { return 0; },
  clearInterval() {},
};

function controller(options: {
  dir: string;
  applier: FakeApplier;
  fetcher: typeof fetch;
  currentVersion?: string;
  idle?: () => Promise<boolean | null>;
  events?: string[];
}) {
  const events = options.events ?? [];
  return new DesktopUpdateController({
    currentVersion: options.currentVersion ?? CURRENT,
    userDataPath: options.dir,
    appPath: join(options.dir, 'app'),
    platform: 'win32',
    arch: 'x64',
    updateBaseUrl: BASE,
    applier: options.applier,
    fetcher: options.fetcher,
    scheduler: manualScheduler,
    daemonMode: () => 'supervised',
    readDaemonIdle: options.idle ?? (async () => true),
    stopDaemon: async () => { events.push('stopDaemon'); },
  });
}

test('check, download, verify, stop the owned daemon, record pending and apply', async () => {
  const dir = userData();
  const applier = new FakeApplier();
  const events: string[] = [];
  const updater = controller({ dir, applier, fetcher: fakeFetch(feed(NEXT)), events });

  const checked = await updater.checkForUpdates();
  assert.equal(checked.state, 'available');
  assert.equal(checked.availableVersion, NEXT);

  let quit = 0;
  const installed = await updater.requestInstall(() => { quit += 1; });
  assert.equal(installed.state, 'installing');
  assert.deepEqual(applier.calls, ['preflight:update', 'prepare', 'apply']);
  assert.deepEqual(events, ['stopDaemon']);
  assert.equal(applier.applied?.version, NEXT);
  assert.equal(quit, 1, 'Desktop quits once the applier handed off');
  const pending = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'));
  assert.equal(pending.from, CURRENT);
  assert.equal(pending.to, NEXT);
});

test('a newer version started from the pending record finalizes once', async () => {
  const dir = userData();
  const first = controller({ dir, applier: new FakeApplier(), fetcher: fakeFetch(feed(NEXT)) });
  await first.checkForUpdates();
  await first.requestInstall(() => undefined);

  const applier = new FakeApplier();
  const restarted = controller({ dir, applier, fetcher: fakeFetch(feed(NEXT)), currentVersion: NEXT });
  await restarted.finalizeStartup();
  assert.deepEqual(applier.calls, ['finalize']);
  assert.equal(restarted.snapshot().state, 'up-to-date');
  assert.equal(existsSync(join(dir, 'update-pending.json')), false);
});

test('a relaunch still on the old version reports the failed update once', async () => {
  const dir = userData();
  const first = controller({ dir, applier: new FakeApplier(), fetcher: fakeFetch(feed(NEXT)) });
  await first.checkForUpdates();
  await first.requestInstall(() => undefined);

  const relaunched = controller({ dir, applier: new FakeApplier(), fetcher: fakeFetch(feed(NEXT)) });
  assert.equal(relaunched.snapshot().state, 'error');
  assert.equal(existsSync(join(dir, 'update-pending.json')), false);
});

test('a busy daemon defers the install before anything is downloaded', async () => {
  const dir = userData();
  const applier = new FakeApplier();
  const events: string[] = [];
  const updater = controller({ dir, applier, fetcher: fakeFetch(feed(NEXT)), idle: async () => false, events });
  await updater.checkForUpdates();

  const waiting = await updater.requestInstall(() => assert.fail('must not quit while waiting'));
  assert.equal(waiting.state, 'waiting');
  assert.deepEqual(applier.calls, []);
  assert.deepEqual(events, []);
});

test('a digest mismatch fails closed and deletes the download', async () => {
  const dir = userData();
  const applier = new FakeApplier();
  const updater = controller({ dir, applier, fetcher: fakeFetch(feed(NEXT, 'c'.repeat(64))) });
  await updater.checkForUpdates();

  const failed = await updater.requestInstall(() => assert.fail('must not quit on a corrupt download'));
  assert.equal(failed.state, 'error');
  assert.deepEqual(applier.calls, ['preflight:update']);
  assert.equal(existsSync(join(dir, 'updates', NEXT, installerAssetName(NEXT, 'win32-x64'))), false);
  assert.equal(existsSync(join(dir, 'update-pending.json')), false);
});

test('an update blocker is acknowledged and quits without downloading', async () => {
  const dir = userData();
  const applier = new FakeApplier();
  applier.blocker = { message: 'needs administrator' };
  const updater = controller({ dir, applier, fetcher: fakeFetch(feed(NEXT)) });
  await updater.checkForUpdates();

  let quit = 0;
  await updater.requestInstall(() => { quit += 1; });
  assert.deepEqual(applier.calls, ['preflight:update']);
  assert.equal(quit, 1);
});

test('the same or an older feed version is up to date', async () => {
  const updater = controller({ dir: userData(), applier: new FakeApplier(), fetcher: fakeFetch(feed(CURRENT)) });
  assert.equal((await updater.checkForUpdates()).state, 'up-to-date');
});
