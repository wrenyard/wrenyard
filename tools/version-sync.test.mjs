import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tool = join(scriptDir, 'version-sync.mjs');

const ROOT_VERSION = '1.0.0-dev.0';

const FIRST_PARTY_MANIFESTS = [
  'apps/cli/package.json',
  'apps/daemon/package.json',
  'apps/desktop/package.json',
  'packages/models/package.json',
  'packages/features/auto-routing/package.json',
  'packages/control-client/package.json',
  'packages/dsh-shell/package.json',
  'packages/features/gateway/package.json',
  'packages/providers/package.json',
];

async function writeJson(dir, rel, obj) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(obj, null, 2) + '\n');
}

async function writeText(dir, rel, content) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function buildFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'version-sync-fixture-'));
  await writeJson(dir, 'package.json', { name: 'wrenyard', version: ROOT_VERSION, private: true });
  for (const rel of FIRST_PARTY_MANIFESTS) {
    await writeJson(dir, rel, { name: rel.replace(/package\.json$/, '').replace(/\/$/, ''), version: ROOT_VERSION });
  }
  await writeJson(dir, 'release-manifest.json', {
    schema_version: 'wrenyard.release-manifest.v1',
    suite_version: ROOT_VERSION,
    protocol_version: '1',
    release_status: 'development',
    publishable: false,
    components: {
      cli: { version: ROOT_VERSION },
      daemon: { version: ROOT_VERSION },
      desktop: { version: ROOT_VERSION },
    },
  });
  await writeJson(dir, 'contracts/versions.json', {
    protocol_version: '1',
    desktop: ROOT_VERSION,
    dsh_shell: ROOT_VERSION,
    dsh: '0.1.0-rc.6',
  });
  await writeText(dir, 'apps/desktop/src/profile.ts', `const manifest = {\n  name: '@wrenyard/dsh-profile',\n  version: '${ROOT_VERSION}',\n};\n`);
  return dir;
}

function runTool(dir, mode) {
  return execFileSync(process.execPath, [tool, mode, '--root', dir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('version-sync --check passes when every first-party location matches the root version', async () => {
  const dir = await buildFixture();
  try {
    const out = runTool(dir, '--check');
    assert.match(out, new RegExp(`all first-party files in sync at ${ROOT_VERSION}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --check reports drift without modifying any file', async () => {
  const dir = await buildFixture();
  await writeJson(dir, 'packages/models/package.json', { name: '@wrenyard/models', version: '0.1.1' });
  await writeJson(dir, 'packages/features/gateway/package.json', { name: '@wrenyard/gateway', version: '0.1.1' });
  await writeText(dir, 'apps/desktop/src/profile.ts', "const manifest = {\n  name: '@wrenyard/dsh-profile',\n  version: '0.7.18',\n};\n");
  try {
    let threw = false;
    try {
      runTool(dir, '--check');
    } catch (error) {
      threw = true;
      const out = String(error.stdout) + String(error.stderr);
      assert.match(out, /packages\/models\/package\.json/);
      assert.match(out, /packages\/features\/gateway\/package\.json/);
      assert.match(out, /profile\.ts/);
    }
    assert.equal(threw, true, '--check must exit non-zero on drift');
    // No file was mutated by --check.
    const models = JSON.parse(await readFile(join(dir, 'packages/models/package.json'), 'utf8'));
    assert.equal(models.version, '0.1.1');
    const gateway = JSON.parse(await readFile(join(dir, 'packages/features/gateway/package.json'), 'utf8'));
    assert.equal(gateway.version, '0.1.1');
    const profile = await readFile(join(dir, 'apps/desktop/src/profile.ts'), 'utf8');
    assert.match(profile, /version: '0\.7\.18'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --write repairs drifted files and becomes stable', async () => {
  const dir = await buildFixture();
  await writeJson(dir, 'packages/providers/package.json', { name: '@wrenyard/providers', version: '0.1.1' });
  await writeText(dir, 'apps/desktop/src/profile.ts', "const manifest = {\n  name: '@wrenyard/dsh-profile',\n  version: '0.1.0-dev.0',\n};\n");
  try {
    const out = runTool(dir, '--write');
    assert.match(out, /updated 2 file\(s\)/);
    assert.match(out, /packages\/providers\/package\.json/);
    assert.match(out, /profile\.ts/);

    const providers = JSON.parse(await readFile(join(dir, 'packages/providers/package.json'), 'utf8'));
    assert.equal(providers.version, ROOT_VERSION);
    const profile = await readFile(join(dir, 'apps/desktop/src/profile.ts'), 'utf8');
    assert.match(profile, new RegExp(`version: '${ROOT_VERSION}'`));

    // A follow-up --check must pass with no further changes needed.
    runTool(dir, '--check');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --write preserves protocol and upstream versions', async () => {
  const dir = await buildFixture();
  try {
    runTool(dir, '--write');
    const contracts = JSON.parse(await readFile(join(dir, 'contracts/versions.json'), 'utf8'));
    assert.equal(contracts.protocol_version, '1');
    assert.equal(contracts.dsh, '0.1.0-rc.6');
    assert.equal(contracts.desktop, ROOT_VERSION);
    assert.equal(contracts.dsh_shell, ROOT_VERSION);
    const manifest = JSON.parse(await readFile(join(dir, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.protocol_version, '1');
    assert.equal(manifest.suite_version, ROOT_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --check reports protocol/upstream drift as a guard failure', async () => {
  const dir = await buildFixture();
  await writeJson(dir, 'contracts/versions.json', {
    protocol_version: '1',
    desktop: ROOT_VERSION,
    dsh_shell: ROOT_VERSION,
    dsh: '0.1.0-rc.7',
  });
  try {
    let threw = false;
    try {
      runTool(dir, '--check');
    } catch (error) {
      threw = true;
      const out = String(error.stdout) + String(error.stderr);
      assert.match(out, /dsh must remain 0\.1\.0-rc\.6/);
    }
    assert.equal(threw, true, '--check must exit non-zero when upstream drift exists');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
