import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { cleanupRunArtifacts } from './cleanup-run-artifacts.mjs';
import { publishGitHubRelease } from './publish-github-release.mjs';
import { publishUpdateFeed } from './publish-update-feed.mjs';
import { validateDevTag, validateNativeTarget } from './release-context.mjs';
import { stagePublicAssets } from './stage-public-assets.mjs';
import { canonicalAssetNames } from './update-feed.mjs';

const VERSION = '1.2.3-dev.4';
const TAG = `v${VERSION}`;
const REPOSITORY = 'wrenyard/wrenyard';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-publication-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createDownloadedArtifacts(root) {
  const inputDir = join(root, 'artifacts');
  for (const name of canonicalAssetNames(VERSION)) {
    const target = name.includes('darwin-arm64') ? 'darwin-arm64' : 'win32-x64';
    const dir = join(inputDir, `wrenyard-release-${target}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `content:${name}`);
    writeFileSync(join(dir, `${name}.sha256`), 'unused internal evidence');
  }
  return inputDir;
}

test('tag and native platform validation fail closed', () => {
  assert.equal(validateDevTag(TAG, VERSION), TAG);
  assert.throws(() => validateDevTag('v1.2.3-dev.3', VERSION), /explicit development tag/);
  assert.throws(() => validateDevTag('v1.2.3', '1.2.3'), /explicit development tag/);
  assert.equal(validateNativeTarget('darwin-arm64', 'darwin', 'arm64'), 'darwin-arm64');
  assert.equal(validateNativeTarget('win32-x64', 'win32', 'x64'), 'win32-x64');
  assert.throws(() => validateNativeTarget('win32-x64', 'darwin', 'arm64'), /got darwin-arm64/);
  assert.throws(() => validateNativeTarget('linux-x64', 'linux', 'x64'), /not a maintained/);
});

test('asset staging selects exactly four public archives and ignores internal evidence', () => {
  withTempDir((dir) => {
    const outputDir = join(dir, 'release-assets');
    const names = stagePublicAssets({
      inputDir: createDownloadedArtifacts(dir),
      outputDir,
      version: VERSION,
    });
    assert.deepEqual(names, canonicalAssetNames(VERSION));
    assert.deepEqual(readdirSync(outputDir).sort(), canonicalAssetNames(VERSION).sort());
  });
});

test('GitHub publication creates a draft, uploads all four assets, then publishes', () => {
  withTempDir((dir) => {
    const assetsDir = join(dir, 'release-assets');
    stagePublicAssets({ inputDir: createDownloadedArtifacts(dir), outputDir: assetsDir, version: VERSION });
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      return { status: args[1] === 'view' ? 1 : 0, stdout: '', stderr: '' };
    };
    publishGitHubRelease({
      assetsDir,
      repository: REPOSITORY,
      tag: TAG,
      sha: 'abc123',
      version: VERSION,
      run,
    });

    assert.deepEqual(calls.map((call) => call.slice(0, 3).join(' ')), [
      'gh release view',
      'gh release create',
      'gh release upload',
      'gh release upload',
      'gh release upload',
      'gh release upload',
      'gh release edit',
    ]);
    const uploads = calls.filter((call) => call[2] === 'upload');
    assert.deepEqual(uploads.map((call) => basename(call[4])), canonicalAssetNames(VERSION));
    assert.ok(calls[1].includes('--draft'));
    assert.ok(calls.at(-1).includes('--draft=false'));
    assert.ok(calls.flat().some((arg) => String(arg).includes('Signing status: macOS ad-hoc; Windows unsigned.')));
    assert.ok(!calls.flat().some((arg) => String(arg).includes('--clobber')));
  });
});

test('invalid tags and existing releases stop before any mutation', () => {
  withTempDir((dir) => {
    const assetsDir = join(dir, 'release-assets');
    stagePublicAssets({ inputDir: createDownloadedArtifacts(dir), outputDir: assetsDir, version: VERSION });
    const invalidCalls = [];
    assert.throws(
      () => publishGitHubRelease({
        assetsDir,
        repository: REPOSITORY,
        tag: 'v1.2.3-dev.5',
        sha: 'abc123',
        version: VERSION,
        run: (...args) => invalidCalls.push(args),
      }),
      /explicit development tag/,
    );
    assert.equal(invalidCalls.length, 0);

    const existingCalls = [];
    assert.throws(
      () => publishGitHubRelease({
        assetsDir,
        repository: REPOSITORY,
        tag: TAG,
        sha: 'abc123',
        version: VERSION,
        run: (command, args) => {
          existingCalls.push([command, ...args]);
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
      /refusing to delete or overwrite/,
    );
    assert.equal(existingCalls.length, 1);
  });
});

test('feed publication retries a rejected normal push without force or rebase', () => {
  withTempDir((dir) => {
    const assetsDir = join(dir, 'release-assets');
    stagePublicAssets({ inputDir: createDownloadedArtifacts(dir), outputDir: assetsDir, version: VERSION });
    const calls = [];
    let pushes = 0;
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'git' && args[0] === '-C') return { status: 0, stdout: 'https://github.com/wrenyard/wrenyard.git\n', stderr: '' };
      if (command === 'git' && args[0] === 'ls-remote') return { status: 0, stdout: '', stderr: '' };
      if (command === 'gh') return { status: 0, stdout: '2026-09-15T00:00:00.000Z\n', stderr: '' };
      if (command === 'git' && args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'push') {
        pushes += 1;
        return { status: pushes === 1 ? 1 : 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = publishUpdateFeed({
      assetsDir,
      publicationDir: join(dir, 'updates-publication'),
      repository: REPOSITORY,
      tag: TAG,
      workspace: join(dir, 'workspace'),
      version: VERSION,
      run,
    });
    assert.deepEqual(result, { changed: true, attempts: 2 });
    const flat = calls.map((call) => call.join(' '));
    assert.ok(flat.some((call) => call === 'git reset --hard FETCH_HEAD'));
    assert.ok(!flat.some((call) => /(?:--force|\s-f\b|rebase)/.test(call)));
    const feed = JSON.parse(readFileSync(join(dir, 'updates-publication', 'dev.json'), 'utf8'));
    assert.equal(feed.assets.length, 4);
    assert.ok(feed.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)));
  });
});

test('feed publication refuses to clean a directory inside the source workspace', () => {
  withTempDir((dir) => {
    const calls = [];
    assert.throws(
      () => publishUpdateFeed({
        assetsDir: join(dir, 'assets'),
        publicationDir: join(dir, 'updates-publication'),
        repository: REPOSITORY,
        tag: TAG,
        workspace: dir,
        version: VERSION,
        run: (...args) => calls.push(args),
      }),
      /unsafe update-feed publication directory/,
    );
    assert.equal(calls.length, 0);
  });
});

test('tagged-build cleanup deletes only artifacts returned for its workflow run', () => {
  const calls = [];
  const ids = cleanupRunArtifacts({
    repository: REPOSITORY,
    runId: '42',
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('--slurp')) {
        return {
          status: 0,
          stdout: JSON.stringify([{ artifacts: [{ id: 101 }, { id: 202 }] }]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(ids, [101, 202]);
  assert.deepEqual(calls.slice(1), [
    ['gh', 'api', '-X', 'DELETE', `repos/${REPOSITORY}/actions/artifacts/101`],
    ['gh', 'api', '-X', 'DELETE', `repos/${REPOSITORY}/actions/artifacts/202`],
  ]);
});
