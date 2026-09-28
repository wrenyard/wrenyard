import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cleanupRunArtifacts,
  confirmCanonicalAssets,
  publishGitHubRelease,
  publishRelease,
  publishUpdateFeed,
} from './publish.mjs';
import { validateDevTag, validateNativeTarget } from './release-context.mjs';
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

// Mirror actions/download-artifact: one directory per build job, each holding
// that target's installer(s).
function createDownloadedArtifacts(root) {
  for (const name of canonicalAssetNames(VERSION)) {
    const target = name.includes('darwin-arm64') ? 'darwin-arm64' : 'win32-x64';
    const dir = join(root, 'artifacts', `wrenyard-release-${target}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `content:${name}`);
  }
  return join(root, 'artifacts');
}

function createFlatAssets(root) {
  const assetsDir = join(root, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const name of canonicalAssetNames(VERSION)) writeFileSync(join(assetsDir, name), `content:${name}`);
  return assetsDir;
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

test('canonical assets are confirmed in memory before any publication', () => {
  withTempDir((dir) => {
    const artifactsDir = createDownloadedArtifacts(dir);
    const assets = confirmCanonicalAssets({ artifactsDir, version: VERSION });
    assert.deepEqual(assets.map((asset) => asset.name), canonicalAssetNames(VERSION));
    assert.ok(assets.every((asset) => asset.path.endsWith(asset.name)));

    const extra = join(artifactsDir, 'wrenyard-release-win32-x64', `wrenyard-desktop-9.9.9-dev.1-win32-x64.zip`);
    writeFileSync(extra, 'extra');
    assert.throws(() => confirmCanonicalAssets({ artifactsDir, version: VERSION }), /not a canonical public archive/);
    rmSync(extra, { force: true });

    const incomplete = createDownloadedArtifacts(join(dir, 'other'));
    rmSync(join(incomplete, 'wrenyard-release-win32-x64', canonicalAssetNames(VERSION)[2]));
    assert.throws(() => confirmCanonicalAssets({ artifactsDir: incomplete, version: VERSION }), /missing canonical public archive/);
  });
});

test('GitHub publication creates a draft, uploads three assets, then publishes', () => {
  withTempDir((dir) => {
    const assetsDir = createFlatAssets(dir);
    const assets = canonicalAssetNames(VERSION).map((name) => join(assetsDir, name));
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      return { status: args[1] === 'view' ? 1 : 0, stdout: '', stderr: '' };
    };
    const names = publishGitHubRelease({ assets, repository: REPOSITORY, tag: TAG, sha: 'abc123', version: VERSION, run });

    assert.deepEqual(names, canonicalAssetNames(VERSION));
    assert.deepEqual(calls.map((call) => call.slice(0, 3).join(' ')), [
      'gh release view',
      'gh release create',
      'gh release upload',
      'gh release upload',
      'gh release upload',
      'gh release edit',
    ]);
    assert.ok(calls[1].includes('--draft'));
    assert.ok(calls.at(-1).includes('--draft=false'));
    assert.ok(calls.flat().some((arg) => String(arg).includes('Signing status: macOS ad-hoc; Windows unsigned.')));
    assert.ok(!calls.flat().some((arg) => String(arg).includes('--clobber')));
  });
});

test('invalid tags and existing releases stop before any mutation', () => {
  withTempDir((dir) => {
    const assetsDir = createFlatAssets(dir);
    const assets = canonicalAssetNames(VERSION).map((name) => join(assetsDir, name));

    const invalidCalls = [];
    assert.throws(
      () => publishGitHubRelease({
        assets,
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
        assets,
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

test('feed publication pushes the feed documents in one commit', () => {
  withTempDir((dir) => {
    const assetsDir = createFlatAssets(dir);
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
    assert.equal(flat.filter((call) => call.startsWith('git push')).length, 2);

    const staged = calls.filter((call) => call[0] === 'git' && call[1] === 'add')[0].slice(2);
    assert.ok(staged.includes('dev.json'));
    assert.ok(staged.some((file) => file.startsWith('versions/')));
    assert.ok(!staged.includes('install.sh'));
    assert.ok(!staged.includes('install.ps1'));

    const feed = JSON.parse(readFileSync(join(dir, 'updates-publication', 'dev.json'), 'utf8'));
    assert.equal(feed.assets.length, 3);
    assert.ok(feed.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)));
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
        return { status: 0, stdout: JSON.stringify([{ artifacts: [{ id: 101 }, { id: 202 }] }]), stderr: '' };
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

test('publishRelease fails closed before any remote mutation when an archive is missing', () => {
  withTempDir((dir) => {
    const artifactsDir = createDownloadedArtifacts(dir);
    rmSync(join(artifactsDir, 'wrenyard-release-win32-x64', canonicalAssetNames(VERSION)[2]));
    const calls = [];
    assert.throws(
      () => publishRelease({
        artifactsDir,
        repository: REPOSITORY,
        tag: TAG,
        sha: 'abc123',
        version: VERSION,
        workspace: join(dir, 'workspace'),
        publicationDir: join(dir, 'updates-publication'),
        stagingDir: join(dir, 'staging'),
        runId: '42',
        run: (...args) => {
          calls.push(args);
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
      /missing canonical public archive/,
    );
    assert.equal(calls.length, 0);
  });
});
