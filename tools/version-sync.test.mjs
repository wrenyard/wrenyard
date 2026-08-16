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
  'apps/desktop/package.json',
  'apps/pet/package.json',
  'services/foreman/package.json',
  'packages/control-client/package.json',
  'packages/dsh-shell/package.json',
  'packages/runtime-resolver/package.json',
  'packages/runtime-darwin-arm64/package.json',
  'packages/runtime-darwin-x64/package.json',
  'packages/runtime-linux-x64/package.json',
  'packages/runtime-win32-x64/package.json',
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
      forge: { version: ROOT_VERSION },
      foreman: { version: ROOT_VERSION },
      pet: { version: ROOT_VERSION },
      cli: { version: ROOT_VERSION },
      desktop: { version: ROOT_VERSION },
      dsh_shell: { version: ROOT_VERSION },
    },
  });
  await writeJson(dir, 'contracts/versions.json', {
    protocol_version: '1',
    desktop: ROOT_VERSION,
    dsh_shell: ROOT_VERSION,
    dsh: '0.1.0-rc.6',
  });
  await writeText(dir, 'runtime/forge/internal/forge/embed.go', `package forge\n\nconst version = "${ROOT_VERSION}"\n`);
  await writeText(
    dir,
    'runtime/forge/internal/forge/shell_grok_test.go',
    `package forge\n\nfunc TestVersionIsCurrent(t *testing.T) {\n\tif version != "${ROOT_VERSION}" {\n\t\tt.Fatalf("version = %q, want ${ROOT_VERSION}", version)\n\t}\n}\n`,
  );
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
  await writeJson(dir, 'apps/pet/package.json', { name: '@wrenyard/pet', version: '0.1.1' });
  await writeText(dir, 'runtime/forge/internal/forge/embed.go', 'package forge\n\nconst version = "0.7.18"\n');
  await writeText(
    dir,
    'runtime/forge/internal/forge/shell_grok_test.go',
    'package forge\n\nfunc TestVersionIsCurrent(t *testing.T) {\n\tif version != "0.7.18" {\n\t\tt.Fatalf("version = %q, want 0.7.18", version)\n\t}\n}\n',
  );
  try {
    let threw = false;
    try {
      runTool(dir, '--check');
    } catch (error) {
      threw = true;
      const out = String(error.stdout) + String(error.stderr);
      assert.match(out, /apps\/pet\/package\.json/);
      assert.match(out, /embed\.go/);
      assert.match(out, /shell_grok_test\.go/);
    }
    assert.equal(threw, true, '--check must exit non-zero on drift');
    // No file was mutated by --check.
    const pet = JSON.parse(await readFile(join(dir, 'apps/pet/package.json'), 'utf8'));
    assert.equal(pet.version, '0.1.1');
    const embed = await readFile(join(dir, 'runtime/forge/internal/forge/embed.go'), 'utf8');
    assert.match(embed, /const version = "0\.7\.18"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version-sync --write repairs drifted files and becomes stable', async () => {
  const dir = await buildFixture();
  await writeJson(dir, 'apps/pet/package.json', { name: '@wrenyard/pet', version: '0.1.1' });
  await writeText(dir, 'runtime/forge/internal/forge/embed.go', 'package forge\n\nconst version = "0.7.18"\n');
  await writeText(
    dir,
    'runtime/forge/internal/forge/shell_grok_test.go',
    'package forge\n\nfunc TestVersionIsCurrent(t *testing.T) {\n\tif version != "0.7.18" {\n\t\tt.Fatalf("version = %q, want 0.7.18", version)\n\t}\n}\n',
  );
  await writeText(dir, 'apps/desktop/src/profile.ts', "const manifest = {\n  name: '@wrenyard/dsh-profile',\n  version: '0.1.0-dev.0',\n};\n");
  try {
    const out = runTool(dir, '--write');
    assert.match(out, /updated 4 file\(s\)/);
    assert.match(out, /apps\/pet\/package\.json/);
    assert.match(out, /embed\.go/);
    assert.match(out, /shell_grok_test\.go/);
    assert.match(out, /profile\.ts/);

    const pet = JSON.parse(await readFile(join(dir, 'apps/pet/package.json'), 'utf8'));
    assert.equal(pet.version, ROOT_VERSION);
    const embed = await readFile(join(dir, 'runtime/forge/internal/forge/embed.go'), 'utf8');
    assert.match(embed, new RegExp(`const version = "${ROOT_VERSION}"`));
    const forgeVersionTest = await readFile(join(dir, 'runtime/forge/internal/forge/shell_grok_test.go'), 'utf8');
    assert.match(forgeVersionTest, new RegExp(`want ${ROOT_VERSION}`));
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

test('version-sync accepts and preserves a CRLF shell_grok_test.go (Windows checkout)', async () => {
  const dir = await buildFixture();
  const testPath = join(dir, 'runtime/forge/internal/forge/shell_grok_test.go');
  const crlfTest = (v) =>
    [
      'package forge',
      '',
      'func TestVersionIsCurrent(t *testing.T) {',
      `\tif version != "${v}" {`,
      `\t\tt.Fatalf("version = %q, want ${v}", version)`,
      '\t}',
      '}',
      '',
    ].join('\r\n');
  try {
    // A CRLF checkout at the current fixture version must be recognized.
    await writeFile(testPath, crlfTest(ROOT_VERSION), 'utf8');
    const checkOut = runTool(dir, '--check');
    assert.match(checkOut, new RegExp(`all first-party files in sync at ${ROOT_VERSION}`));

    // A drifted version inside the CRLF file is repaired by --write.
    await writeFile(testPath, crlfTest('0.7.18'), 'utf8');
    const writeOut = runTool(dir, '--write');
    assert.match(writeOut, /shell_grok_test\.go/);

    // The version is restored and the file is still pure CRLF (no mixed endings).
    const repaired = await readFile(testPath, 'utf8');
    assert.match(repaired, new RegExp(`want ${ROOT_VERSION}`));
    const withoutCrlf = repaired.replace(/\r\n/g, '');
    assert.ok(!withoutCrlf.includes('\n'), 'repaired file must not contain bare LF');
    assert.ok(!withoutCrlf.includes('\r'), 'repaired file must not contain bare CR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
