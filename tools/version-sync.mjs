#!/usr/bin/env node
// Wrenyard first-party version sync.
//
// The root package.json "version" field is the single source of truth (SSOT)
// for the first-party version contract. This tool propagates that version to
// apps/desktop/package.json, the manifest electron-builder and
// app.getVersion() read for version comparison, the settings page and the
// source-runtime version display.
//
// Every other internal package is private and pinned to "0.0.0"; protocol and
// upstream (DSH) versions are never altered. Preparing a release therefore only
// touches the root manifest and the Desktop manifest.
//
// Usage: node tools/version-sync.mjs [--check|--write] [--root <dir>]
//   --check (default) verifies the Desktop manifest matches the root version
//     and exits non-zero on drift.
//   --write rewrites the Desktop manifest to the root version.
//   --root overrides the repository root (used by tests; defaults to repo root).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(scriptDir, '..');

export const DESKTOP_MANIFEST = 'apps/desktop/package.json';

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

  const desktopPath = join(root, DESKTOP_MANIFEST);
  if (!existsSync(desktopPath)) {
    console.error(`version-sync: ${DESKTOP_MANIFEST} (missing)`);
    return 1;
  }

  const current = JSON.stringify(JSON.parse(readFileSync(desktopPath, 'utf8')), null, 2) + '\n';
  const manifest = JSON.parse(current);
  if (manifest.version === version) {
    console.log(`version-sync: Desktop manifest in sync at ${version}`);
    return 0;
  }

  if (!write) {
    console.error(
      `version-sync: ${DESKTOP_MANIFEST} is out of sync with root version ${version}: expected ${version}, got ${JSON.stringify(manifest.version)}`,
    );
    return 1;
  }

  manifest.version = version;
  writeFileSync(desktopPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`version-sync: updated ${DESKTOP_MANIFEST} to ${version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
