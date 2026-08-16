#!/usr/bin/env node
// Wrenyard first-party version sync.
//
// The root package.json "version" field is the single source of truth (SSOT)
// for the first-party version contract. This tool propagates that version to:
//   - every first-party package manifest (apps/*, services/*, packages/*)
//   - release-manifest.json (suite_version + each component version)
//   - contracts/versions.json (first-party desktop and dsh_shell entries)
//   - the embedded Forge version constant (runtime/forge/internal/forge/embed.go)
//   - the Forge version contract test
//   - the Desktop profile manifest version (apps/desktop/src/profile.ts)
//
// Protocol and upstream (DSH) versions are never altered; any drift in those
// values is reported but never repaired.
//
// Usage: node tools/version-sync.mjs [--check|--write] [--root <dir>]
//   --check (default) verifies every first-party location matches the root
//     version and exits non-zero on drift.
//   --write rewrites any drifted first-party location to the root version.
//   --root overrides the repository root (used by tests; defaults to repo root).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(scriptDir, '..');

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

const RELEASE_MANIFEST = 'release-manifest.json';
const CONTRACTS = 'contracts/versions.json';
const EMBED_PATH = 'runtime/forge/internal/forge/embed.go';
const FORGE_VERSION_TEST_PATH = 'runtime/forge/internal/forge/shell_grok_test.go';
const PROFILE_PATH = 'apps/desktop/src/profile.ts';

// Protocol and upstream versions that must be preserved untouched.
const PROTOCOL_VERSION = '1';
const DSH_VERSION = '0.1.0-rc.6';

export function run(argv, cwd = process.cwd()) {
  const write = argv.includes('--write');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx !== -1 && argv[rootIdx + 1] ? resolve(cwd, argv[rootIdx + 1]) : defaultRoot;

  const rootManifestPath = join(root, 'package.json');
  if (!existsSync(rootManifestPath)) {
    throw new Error(`cannot find root package.json at ${rootManifestPath}`);
  }
  const version = JSON.parse(readFileSync(rootManifestPath, 'utf8')).version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`root package.json version is missing or empty: ${JSON.stringify(version)}`);
  }

  const drifted = [];
  const repaired = [];

  const syncJson = (rel, mutate) => {
    const abs = join(root, rel);
    const current = JSON.stringify(JSON.parse(readFileSync(abs, 'utf8')), null, 2) + '\n';
    const obj = JSON.parse(current);
    mutate(obj, version);
    const updated = JSON.stringify(obj, null, 2) + '\n';
    if (updated === current) return;
    if (write) {
      writeFileSync(abs, updated);
      repaired.push(rel);
    } else {
      drifted.push(`${rel} (expected ${version})`);
    }
  };

  for (const rel of FIRST_PARTY_MANIFESTS) {
    syncJson(rel, (pkg) => {
      pkg.version = version;
    });
  }
  syncJson(RELEASE_MANIFEST, (manifest) => {
    manifest.suite_version = version;
    for (const component of Object.values(manifest.components)) {
      component.version = version;
    }
  });
  syncJson(CONTRACTS, (contracts) => {
    contracts.desktop = version;
    contracts.dsh_shell = version;
  });

  const syncText = (rel, pattern, replacement) => {
    const abs = join(root, rel);
    const current = readFileSync(abs, 'utf8');
    if (!pattern.test(current)) {
      drifted.push(`${rel} (expected version pattern missing)`);
      return;
    }
    const updated = current.replace(pattern, replacement);
    if (updated === current) return;
    if (write) {
      writeFileSync(abs, updated);
      repaired.push(rel);
    } else {
      drifted.push(`${rel} (expected ${version})`);
    }
  };
  syncText(EMBED_PATH, /const version = "[^"]*"/, `const version = "${version}"`);
  // The Forge version test may be checked out with CRLF line endings on
  // Windows. Capture the actual EOL and indentation and rebuild the assertion
  // with a replacement callback so --write never mixes LF into a CRLF file.
  syncText(
    FORGE_VERSION_TEST_PATH,
    /if version != "[^"]*" \{(\r?\n)([ \t]*)t\.Fatalf\("version = %q, want [^"]*", version\)/,
    (_match, eol, indent) =>
      `if version != "${version}" {${eol}${indent}t.Fatalf("version = %q, want ${version}", version)`,
  );
  syncText(PROFILE_PATH, /version: '[^']*'/, `version: '${version}'`);

  // Guard rails: protocol/upstream versions must never be altered. Drift is
  // reported so the check gate catches it instead of being silently repaired.
  const releaseManifest = JSON.parse(readFileSync(join(root, RELEASE_MANIFEST), 'utf8'));
  if (releaseManifest.protocol_version !== PROTOCOL_VERSION) {
    drifted.push(
      `${RELEASE_MANIFEST}: protocol_version must remain ${PROTOCOL_VERSION}, got ${JSON.stringify(releaseManifest.protocol_version)}`,
    );
  }
  const contracts = JSON.parse(readFileSync(join(root, CONTRACTS), 'utf8'));
  if (contracts.protocol_version !== PROTOCOL_VERSION) {
    drifted.push(`${CONTRACTS}: protocol_version must remain ${PROTOCOL_VERSION}, got ${JSON.stringify(contracts.protocol_version)}`);
  }
  if (contracts.dsh !== DSH_VERSION) {
    drifted.push(`${CONTRACTS}: dsh must remain ${DSH_VERSION}, got ${JSON.stringify(contracts.dsh)}`);
  }

  if (write) {
    if (drifted.length > 0) {
      for (const line of drifted) console.error(`version-sync: guard: ${line}`);
      console.error(`version-sync: wrote ${repaired.length} file(s); guard failures remain`);
      return 1;
    }
    if (repaired.length === 0) {
      console.log(`version-sync: already in sync at ${version}`);
    } else {
      console.log(`version-sync: updated ${repaired.length} file(s) to ${version}`);
      for (const rel of repaired) console.log(`  ${rel}`);
    }
    return 0;
  }

  if (drifted.length > 0) {
    console.error(`version-sync: ${drifted.length} file(s) out of sync with root version ${version}:`);
    for (const line of drifted) console.error(`  ${line}`);
    return 1;
  }
  console.log(`version-sync: all first-party files in sync at ${version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
