import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const localBuilder = readFileSync(resolve(repoRoot, 'tools', 'release', 'build-local-release.mjs'), 'utf8');

test('release workflow builds exactly the two maintained native targets', () => {
  assert.match(workflow, /- os: macos-15\s+target: darwin-arm64/);
  assert.match(workflow, /- os: windows-latest\s+target: win32-x64/);
  assert.equal(workflow.match(/^\s+target:/gm)?.length, 2);
  assert.ok(!workflow.includes('linux-x64'));
  assert.ok(!workflow.includes('darwin-x64'));
});

test('build jobs only install frozen dependencies and invoke release scripts', () => {
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  assert.ok(build.includes('pnpm install --frozen-lockfile'));
  assert.ok(build.includes('node tools/release/validate-release.mjs'));
  assert.ok(build.includes('pnpm release:local'));
  for (const forbidden of [
    'pnpm check',
    'typecheck',
    'pnpm test',
    'forge:vet',
    'pnpm audit',
    'desktop:smoke',
    'release:e2e',
    'release:check',
    'release:legal',
    'verify-manifest',
  ]) {
    assert.ok(!workflow.includes(forbidden), `workflow must not invoke ${forbidden}`);
  }
});

test('manual dispatch is build-only and retains downloadable public archives', () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  publish:\n    if: github\.event_name == 'push'/m);
  assert.ok(workflow.includes('actions/upload-artifact@v4'));
  assert.ok(workflow.includes('.artifacts/release/wrenyard-*-suite.zip'));
  assert.ok(workflow.includes('.artifacts/release/wrenyard-desktop-*.zip'));
  assert.ok(workflow.includes('retention-days: 1'));
  assert.ok(!workflow.toLowerCase().includes('preflight'));
});

test('explicit dev tags are validated without tag creation or rewriting', () => {
  assert.ok(workflow.includes("- 'v*-dev.*'"));
  assert.ok(workflow.includes('node tools/release/validate-release.mjs --tag "$GITHUB_REF_NAME"'));
  assert.ok(!workflow.includes('git tag'));
  assert.ok(!workflow.includes('git push --force'));
  assert.ok(!workflow.includes('gh release delete'));
});

test('publication is delegated to scripts in safe order', () => {
  const stage = workflow.indexOf('node tools/release/stage-public-assets.mjs');
  const release = workflow.indexOf('node tools/release/publish-github-release.mjs');
  const feed = workflow.indexOf('node tools/release/publish-update-feed.mjs');
  const cleanup = workflow.indexOf('node tools/release/cleanup-run-artifacts.mjs');
  assert.ok(stage > 0 && stage < release);
  assert.ok(release < feed);
  assert.ok(feed < cleanup);
  assert.ok(!/^\s+(?:gh|git) /m.test(workflow));
});

test('workflow permissions and artifact transport remain minimal', () => {
  assert.match(workflow, /^permissions:\n  contents: read/m);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /permissions:\n      actions: write\n      contents: write/);
  assert.ok(workflow.includes('actions/download-artifact@v4'));
  assert.ok(workflow.includes('cancel-in-progress: false'));
  assert.ok(!workflow.includes('cache: pnpm'));
  assert.ok(!workflow.includes('actions/setup-go'));
});

test('root publication commands point directly at bounded release scripts', () => {
  assert.equal(packageJson.scripts['release:validate'], 'node tools/release/validate-release.mjs');
  assert.equal(packageJson.scripts['release:stage-public'], 'node tools/release/stage-public-assets.mjs');
  assert.equal(packageJson.scripts['release:publish-github'], 'node tools/release/publish-github-release.mjs');
  assert.equal(packageJson.scripts['release:publish-feed'], 'node tools/release/publish-update-feed.mjs');
  assert.equal(packageJson.scripts['release:cleanup-artifacts'], 'node tools/release/cleanup-run-artifacts.mjs');
});

test('release:local stays build-only while retaining production build stages', () => {
  assert.ok(!localBuilder.includes("run('pnpm', ['release:check'])"));
  assert.ok(!localBuilder.includes('release:legal'));
  assert.ok(!localBuilder.includes('release:e2e'));
  assert.ok(!localBuilder.includes('desktop:smoke'));
  assert.ok(localBuilder.includes("run('pnpm', ['--filter', '@wrenyard/cli', 'build'])"));
  assert.ok(localBuilder.includes("'build-sea.mjs'"));
  assert.ok(localBuilder.includes("'generate-license-report.mjs'"));
  assert.ok(!localBuilder.includes('build-runtime-package.mjs'));
  assert.ok(!localBuilder.includes('runtimeStage'));
  assert.ok(localBuilder.includes('assertSafeReleasePayload'));
  assert.ok(localBuilder.includes('assertNoBuildPathsInStagedControl'));
});
