import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');

// Every script the simplified pipeline removed. None may be referenced again.
const OBSOLETE = [
  'stage-public-assets.mjs',
  'publish-github-release.mjs',
  'publish-update-feed.mjs',
  'cleanup-run-artifacts.mjs',
  'validate-release.mjs',
  'smoke-desktop.mjs',
  'install-dev.mjs',
];

test('release workflow builds exactly the two maintained native targets', () => {
  assert.match(workflow, /os: \[macos-15, windows-latest\]/);
  assert.ok(!workflow.includes('linux-x64'));
  assert.ok(!workflow.includes('darwin-x64'));
});

test('pre-check job lints the repository before any build starts', () => {
  const preCheck = workflow.slice(workflow.indexOf('  pre-check:'), workflow.indexOf('  build:'));
  assert.ok(preCheck.includes('pnpm install --frozen-lockfile'));
  assert.match(preCheck, /- run: pnpm lint\n/);
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  assert.match(build, /needs: pre-check/);
});

test('build job installs frozen dependencies and runs the single pack script', () => {
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  assert.ok(build.includes('pnpm install --frozen-lockfile'));
  assert.ok(build.includes('node tools/release/pack.mjs'));
  assert.ok(build.includes('release/*.dmg'));
  assert.ok(build.includes('release/*.zip'));
  assert.ok(build.includes('release/*-setup.exe'));
  assert.ok(!build.includes('build-local-release.mjs'));
  assert.ok(build.includes('if-no-files-found: error'));
  for (const forbidden of [
    'pnpm check',
    'typecheck',
    'pnpm test',
    'pnpm audit',
    'desktop:smoke',
    'release:e2e',
    'release:check',
    'release:legal',
  ]) {
    assert.ok(!workflow.includes(forbidden), `workflow must not invoke ${forbidden}`);
  }
});

test('publish job runs only the single publish script after downloading artifacts', () => {
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /node tools\/release\/publish\.mjs --artifacts artifacts/);
  assert.ok(publish.includes('actions/download-artifact@v4'));
  assert.match(publish, /permissions:\n      actions: write\n      contents: write/);
  assert.ok(!/^\s+(?:gh|git) /m.test(publish));
});

test('no obsolete pipeline script is referenced anywhere', () => {
  for (const name of OBSOLETE) {
    assert.ok(!workflow.includes(name), `workflow must not reference ${name}`);
  }
});
