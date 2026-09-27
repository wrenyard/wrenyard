import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DESKTOP_MANIFEST } from './version-sync.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tool = join(scriptDir, 'version-sync.mjs');

const ROOT_VERSION = '1.0.0-dev.0';
const DECOY_MANIFEST = 'packages/models/package.json';

async function writeJson(dir, rel, obj) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(obj, null, 2) + '\n');
}

async function buildFixture(desktopVersion = ROOT_VERSION) {
  const dir = await mkdtemp(join(tmpdir(), 'version-sync-fixture-'));
  await writeJson(dir, 'package.json', { name: 'wrenyard', version: ROOT_VERSION, private: true });
  await writeJson(dir, DESKTOP_MANIFEST, { name: '@wrenyard/desktop', version: desktopVersion });
  return dir;
}

function runTool(dir, mode) {
  return execFileSync(process.execPath, [tool, mode, '--root', dir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('version-sync --check passes when the Desktop manifest matches the root version', async () => {
  const dir = await buildFixture();
  try {
    const out = runTool(dir, '--check');
    assert.match(out, new RegExp(`Desktop manifest in sync at ${ROOT_VERSION}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --check reports Desktop drift without modifying any file', async () => {
  const dir = await buildFixture('0.1.1');
  await writeJson(dir, DECOY_MANIFEST, { name: '@wrenyard/models', version: '0.1.1' });
  try {
    let threw = false;
    try {
      runTool(dir, '--check');
    } catch (error) {
      threw = true;
      const out = String(error.stdout) + String(error.stderr);
      assert.match(out, /apps\/desktop\/package\.json/);
    }
    assert.equal(threw, true, '--check must exit non-zero on Desktop drift');

    const desktop = JSON.parse(await readFile(join(dir, DESKTOP_MANIFEST), 'utf8'));
    assert.equal(desktop.version, '0.1.1');
    const decoy = JSON.parse(await readFile(join(dir, DECOY_MANIFEST), 'utf8'));
    assert.equal(decoy.version, '0.1.1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --write repairs the Desktop manifest and becomes stable', async () => {
  const dir = await buildFixture('0.1.1');
  try {
    const out = runTool(dir, '--write');
    assert.match(out, /apps\/desktop\/package\.json/);

    const desktop = JSON.parse(await readFile(join(dir, DESKTOP_MANIFEST), 'utf8'));
    assert.equal(desktop.version, ROOT_VERSION);

    // A follow-up --check must pass with no further changes needed.
    runTool(dir, '--check');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync only touches the root and Desktop manifests', async () => {
  const dir = await buildFixture('0.1.1');
  await writeJson(dir, DECOY_MANIFEST, { name: '@wrenyard/models', version: '0.1.1' });
  try {
    runTool(dir, '--write');
    const decoy = JSON.parse(await readFile(join(dir, DECOY_MANIFEST), 'utf8'));
    assert.equal(decoy.version, '0.1.1', 'private internal packages must never be synced');
    // The decoy drift must not fail the check either.
    runTool(dir, '--check');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
