#!/usr/bin/env node
// `pnpm release <x.y.z>`: bump the two version manifests, package this
// platform's Desktop installer through pack.mjs, and commit the version bump
// only after packaging (including the assembled-app smoke) succeeds.
//
// It never tags, pushes, installs or controls a daemon. A failed pack restores
// both manifests so no partial version commit can exist. Re-running with the
// version already in the manifests repacks without touching files or git.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { packageVersion, REPO_ROOT } from './release-context.mjs';
import { compareVersions, isSemver } from './update-feed.mjs';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
// The root manifest is the single version source; Desktop carries the one
// additional public copy. Every other workspace package stays at 0.0.0.
const VERSION_MANIFESTS = [
  path.join(REPO_ROOT, 'package.json'),
  path.join(REPO_ROOT, 'apps', 'desktop', 'package.json'),
];

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`git ${args.join(' ')} exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function assertCleanTree() {
  const status = git(['status', '--porcelain']).trim();
  if (status !== '') {
    throw new Error(`refusing to release from a dirty working tree:\n${status}`);
  }
}

function writeManifestVersion(file, version) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Root and Desktop are the two public version copies; a repack must not build a
// suite that reports one version while Desktop carries another.
function assertVersionConsistency(version) {
  for (const file of VERSION_MANIFESTS) {
    const actual = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    if (actual !== version) {
      throw new Error(`version mismatch: ${path.relative(REPO_ROOT, file)} is ${actual}, expected ${version}`);
    }
  }
}

function pack() {
  const result = spawnSync(process.execPath, [path.join(RELEASE_DIR, 'pack.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`packaging failed with exit ${result.status}`);
}

function commitVersion(version) {
  git(['add', '--', ...VERSION_MANIFESTS.map((file) => path.relative(REPO_ROOT, file))]);
  git(['commit', '-m', `release: ${version}`]);
}

function main(argv) {
  const positionals = argv.filter((arg) => arg !== '--');
  if (positionals.length !== 1 || !isSemver(positionals[0])) {
    throw new Error('usage: pnpm release <x.y.z>');
  }
  const requested = positionals[0];
  const current = packageVersion();
  if (compareVersions(requested, current) < 0) {
    throw new Error(`refusing to release ${requested}: it is older than the current version ${current}`);
  }
  assertCleanTree();

  // Equal version: repack only, never rewrite a manifest or create a commit.
  if (requested === current) {
    assertVersionConsistency(current);
    pack();
    process.stdout.write(`repacked ${requested} without a version commit\n`);
    return;
  }

  const originals = VERSION_MANIFESTS.map((file) => ({ file, content: fs.readFileSync(file, 'utf8') }));
  try {
    for (const file of VERSION_MANIFESTS) writeManifestVersion(file, requested);
    pack();
  } catch (error) {
    for (const { file, content } of originals) fs.writeFileSync(file, content);
    throw error;
  }

  commitVersion(requested);
  process.stdout.write(`committed release: ${requested}\n`);
  process.stdout.write(`push the version commit, then run:\n`);
  process.stdout.write(`git tag v${requested} && git push origin v${requested}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[release] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
