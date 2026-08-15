#!/usr/bin/env node
// Dependency-free node:test coverage for the release manifest verifier. Each
// case builds an isolated temporary suite fixture, copies the real verifier and
// schema contract into it, and spawns the copied verifier against a fixture
// manifest. No real manifest, network, or installed package is touched.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const realVerifier = join(here, 'verify-manifest.mjs');
const realSchema = join(here, '..', '..', 'contracts', 'suite-manifest.schema.json');

const componentSources = {
  forge: 'runtime/forge',
  foreman: 'runtime/foreman',
  pet: 'apps/pet',
  cli: 'apps/cli',
  desktop: 'apps/desktop',
  dsh_shell: 'packages/dsh-shell',
};

const fixtureRoots = [];
after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-verify-manifest-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'tools', 'release'), { recursive: true });
  mkdirSync(join(root, 'contracts'), { recursive: true });
  cpSync(realVerifier, join(root, 'tools', 'release', 'verify-manifest.mjs'));
  cpSync(realSchema, join(root, 'contracts', 'suite-manifest.schema.json'));
  for (const source of Object.values(componentSources)) {
    mkdirSync(join(root, source), { recursive: true });
  }
  writeFileSync(join(root, 'runtime', 'forge', 'go.mod'), 'module github.com/wrenyard/forge\n');
  return root;
}

function contractValues(root) {
  const schema = JSON.parse(readFileSync(join(root, 'contracts', 'suite-manifest.schema.json'), 'utf8'));
  const pick = (pattern, fallback) => {
    if (typeof pattern !== 'string') return fallback;
    const re = new RegExp(pattern);
    for (const candidate of ['0.1.0-dev.0', '0.1.0', '1.0.0', '7', '1', '0', '2026.8.15']) {
      if (re.test(candidate)) return candidate;
    }
    return fallback;
  };
  const props = schema.properties?.platform_artifacts?.patternProperties;
  const artifactNamePattern =
    props && typeof props === 'object' && !Array.isArray(props) ? Object.keys(props)[0] : undefined;
  return {
    schema_version: schema.properties?.schema_version?.const ?? '1.0',
    suite_version: pick(schema.properties?.suite_version?.pattern, '0.1.0-dev.0'),
    protocol_version: pick(schema.properties?.protocol_version?.pattern, '7'),
    component_version: pick(schema.$defs?.component?.properties?.version?.pattern, '0.1.0-dev.0'),
    artifact_name: pickArtifactName(artifactNamePattern),
  };
}

function pickArtifactName(pattern) {
  if (typeof pattern !== 'string') return 'forge-darwin-arm64.zip';
  const re = new RegExp(pattern);
  for (const candidate of [
    'forge-darwin-arm64.zip',
    'forge-macos.zip',
    'forge.dmg',
    'forge-macos',
    'forge-darwin',
    'forge',
  ]) {
    if (re.test(candidate)) return candidate;
  }
  return 'forge-darwin-arm64.zip';
}

function buildComponents(values, { sourceSha = null, sources = {} } = {}) {
  const mk = (key) => ({
    source: sources[key] ?? componentSources[key],
    version: values.component_version,
    source_sha: sourceSha,
  });
  return {
    forge: mk('forge'),
    foreman: mk('foreman'),
    pet: mk('pet'),
    cli: mk('cli'),
    desktop: mk('desktop'),
    dsh_shell: mk('dsh_shell'),
  };
}

function buildManifest(values, { status = 'development', publishable = false, components = null, artifacts = null } = {}) {
  return {
    schema_version: values.schema_version,
    suite_version: values.suite_version,
    protocol_version: values.protocol_version,
    release_status: status,
    publishable,
    components: components ?? buildComponents(values, { sourceSha: publishable ? 'a'.repeat(40) : null }),
    platform_artifacts: artifacts ?? {},
  };
}

function writeManifest(root, manifest) {
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
}

function runVerifier(root) {
  return spawnSync(process.execPath, [join(root, 'tools', 'release', 'verify-manifest.mjs')], { encoding: 'utf8' });
}

function expectOk(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release manifest OK/);
}

function expectFail(result, pattern) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, pattern);
}

function addArtifact(root, { name, path = 'dist/forge.zip', content = 'fixture payload' }) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return { [name]: { format: 'zip', path, sha256: createHash('sha256').update(content).digest('hex') } };
}

// The external target artifact index emitted by the release builder is
// validated as a separate document from the embedded development identity.
function addIndexArtifact(root, { path = 'dist/forge.zip', content = 'index payload' } = {}) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return { path, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
}

function buildIndex(values, { target = `${process.platform}-${process.arch}`, suite_version, artifacts = [] } = {}) {
  return {
    schema: 'wrenyard.local-artifacts.v1',
    suite_version: suite_version ?? values.suite_version,
    target,
    publishable: false,
    artifacts,
  };
}

function writeIndex(root, index) {
  writeFileSync(join(root, 'artifact-manifest.json'), JSON.stringify(index, null, 2));
}

test('accepts a valid development manifest', () => {
  const root = makeFixture();
  writeManifest(root, buildManifest(contractValues(root)));
  expectOk(runVerifier(root));
});

test('rejects a manifest missing a component or carrying an extra one', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const { cli, ...missingCli } = buildComponents(values);
  writeManifest(root, buildManifest(values, { components: missingCli }));
  expectFail(runVerifier(root), /components is missing "cli"/);

  const root2 = makeFixture();
  const values2 = contractValues(root2);
  const extra = buildComponents(values2);
  writeManifest(root2, buildManifest(values2, { components: { ...extra, extra: extra.cli } }));
  expectFail(runVerifier(root2), /components has unknown key "extra"/);
});

test('rejects a component source escaping the suite root', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const components = buildComponents(values, { sources: { forge: '../outside' } });
  writeManifest(root, buildManifest(values, { components }));
  expectFail(runVerifier(root), /source must be contained under the suite root/);
});

test('accepts a publishable manifest with one artifact and a computed checksum', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const artifacts = addArtifact(root, { name: values.artifact_name });
  writeManifest(root, buildManifest(values, { status: 'stable', publishable: true, artifacts }));
  expectOk(runVerifier(root));
});

test('rejects an artifact whose sha256 does not match the file bytes', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const artifacts = addArtifact(root, { name: values.artifact_name });
  artifacts[values.artifact_name].sha256 = 'f'.repeat(64);
  writeManifest(root, buildManifest(values, { status: 'stable', publishable: true, artifacts }));
  expectFail(runVerifier(root), /sha256 mismatch/);
});

test('rejects a platform artifact path escaping the suite root', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const artifacts = { [values.artifact_name]: { format: 'zip', path: '../outside.zip', sha256: 'a'.repeat(64) } };
  writeManifest(root, buildManifest(values, { status: 'stable', publishable: true, artifacts }));
  expectFail(runVerifier(root), /path must be contained under the suite root/);
});

test('rejects publishable manifests using the transitional personal Forge module namespace', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const userNs = ['d', 'l', 'u', 'c', 'k'].join('');
  writeFileSync(join(root, 'runtime', 'forge', 'go.mod'), `module github.com/${userNs}/forge\n`);
  const artifacts = addArtifact(root, { name: values.artifact_name });
  writeManifest(root, buildManifest(values, { status: 'stable', publishable: true, artifacts }));
  expectFail(runVerifier(root), /transitional personal Forge module namespace/);
});

test('rejects a platform artifact symlinked to a file outside the suite without hashing it', (t) => {
  const root = makeFixture();
  const values = contractValues(root);
  // External temp directory holds the symlink target; tracked so `after`
  // cleanup removes it alongside the fixture.
  const externalRoot = mkdtempSync(join(tmpdir(), 'wrenyard-verify-manifest-outside-'));
  fixtureRoots.push(externalRoot);
  const outsideFile = join(externalRoot, 'outside.zip');
  writeFileSync(outsideFile, 'outside payload');
  const linkPath = join(root, 'dist', 'forge.zip');
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    symlinkSync(outsideFile, linkPath);
  } catch {
    t.skip('file symlinks are unavailable on this platform');
    return;
  }
  // Lexically inside the suite, but a symlink to a regular file in another
  // temp directory; a valid-looking but wrong hash would surface a computed
  // digest only if the outside target were actually hashed.
  const artifacts = { [values.artifact_name]: { format: 'zip', path: 'dist/forge.zip', sha256: 'f'.repeat(64) } };
  writeManifest(root, buildManifest(values, { status: 'stable', publishable: true, artifacts }));
  const result = runVerifier(root);
  expectFail(result, /escapes the suite root after realpath/);
  assert.doesNotMatch(result.stderr, /sha256 mismatch|computed/);
});

test('accepts a coherent 1.0.0-dev.0 development identity', () => {
  const root = makeFixture();
  const values = { ...contractValues(root), suite_version: '1.0.0-dev.0', component_version: '1.0.0-dev.0' };
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  expectOk(runVerifier(root));
});

test('accepts a coherent external target artifact index beside a development identity', () => {
  const root = makeFixture();
  const values = contractValues(root);
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  writeIndex(root, buildIndex(values, { artifacts: [addIndexArtifact(root)] }));
  expectOk(runVerifier(root));
});

test('rejects an external artifact index whose target does not match the host', () => {
  const root = makeFixture();
  const values = contractValues(root);
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  const artifacts = [addIndexArtifact(root)];
  const wrong = process.platform === 'win32' ? 'linux-x64' : 'win32-x64';
  writeIndex(root, buildIndex(values, { target: wrong, artifacts }));
  expectFail(runVerifier(root), /does not match the host target/);
});

test('rejects an external artifact index whose suite_version differs from the identity', () => {
  const root = makeFixture();
  const values = contractValues(root);
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  const artifacts = [addIndexArtifact(root)];
  writeIndex(root, buildIndex(values, { suite_version: '9.9.9', artifacts }));
  expectFail(runVerifier(root), /does not match the release manifest suite_version/);
});

test('rejects an external artifact index with a mismatched checksum', () => {
  const root = makeFixture();
  const values = contractValues(root);
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  const artifacts = [addIndexArtifact(root)];
  artifacts[0].sha256 = 'f'.repeat(64);
  writeIndex(root, buildIndex(values, { artifacts }));
  expectFail(runVerifier(root), /sha256 mismatch/);
});

test('rejects a development identity that references the manifest itself', () => {
  const root = makeFixture();
  const values = contractValues(root);
  const manifest = buildManifest(values, { status: 'development', publishable: false });
  manifest.platform_artifacts = {
    [values.artifact_name]: { format: 'json', path: 'release-manifest.json', sha256: 'a'.repeat(64) },
  };
  writeManifest(root, manifest);
  expectFail(runVerifier(root), /self-reference/);
});

test('rejects an external artifact index that references itself', () => {
  const root = makeFixture();
  const values = contractValues(root);
  writeManifest(root, buildManifest(values, { status: 'development', publishable: false }));
  writeIndex(root, buildIndex(values, { artifacts: [{ path: 'artifact-manifest.json', size: 0, sha256: 'a'.repeat(64) }] }));
  expectFail(runVerifier(root), /must not reference itself/);
});
