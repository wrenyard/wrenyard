import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  channelForVersion,
  prepareMetadata,
  renderDocument,
} from './update-feed.mjs';

const REPOSITORY = 'wrenyard/wrenyard';
const PUBLISHED_AT = '2026-09-14T00:00:00.000Z';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-update-feed-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assetNames(version) {
  return [
    `wrenyard-desktop-${version}-darwin-arm64.dmg`,
    `wrenyard-desktop-${version}-darwin-arm64.zip`,
    `wrenyard-desktop-${version}-win32-x64-setup.exe`,
  ];
}

function writeAssets(dir, version, contents = {}) {
  const assetsDir = join(dir, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const name of assetNames(version)) {
    writeFileSync(join(assetsDir, name), contents[name] ?? `payload:${name}`);
  }
  return assetsDir;
}

function expectedSha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('generates a channel head and immutable snapshot for the three assets', () => {
  withTempDir((dir) => {
    const version = '1.0.0-dev.10';
    const assetsDir = writeAssets(dir, version);
    const metadataDir = join(dir, 'updates');
    const result = prepareMetadata({
      assetsDir,
      version,
      repository: REPOSITORY,
      publishedAt: PUBLISHED_AT,
      metadataDir,
    });

    const channel = JSON.parse(readFileSync(join(metadataDir, 'dev.json'), 'utf8'));
    const snapshot = JSON.parse(readFileSync(join(metadataDir, 'versions', `${version}.json`), 'utf8'));
    assert.equal(result.channel, 'dev');
    assert.deepEqual(channel, snapshot);
    assert.equal(channel.schema_version, 'wrenyard.update.v1');
    assert.equal(channel.version, version);
    assert.equal(channel.published_at, PUBLISHED_AT);
    assert.equal(channel.assets.length, 3);
    for (const name of assetNames(version)) {
      assert.ok(channel.assets.some((asset) => asset.name === name), `missing ${name}`);
    }
  });
});

test('stores an accurate sha256 and canonical release download url per asset', () => {
  withTempDir((dir) => {
    const version = '1.0.0-dev.10';
    const assetsDir = writeAssets(dir, version);
    const metadataDir = join(dir, 'updates');
    prepareMetadata({
      assetsDir,
      version,
      repository: REPOSITORY,
      publishedAt: PUBLISHED_AT,
      metadataDir,
    });
    const { assets } = JSON.parse(readFileSync(join(metadataDir, 'dev.json'), 'utf8'));
    for (const asset of assets) {
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
      assert.equal(asset.sha256, expectedSha(join(assetsDir, asset.name)));
      assert.equal(
        asset.url,
        `https://github.com/${REPOSITORY}/releases/download/v${version}/${asset.name}`,
      );
    }
  });
});

test('rejects missing, extra and malformed asset names and versions', () => {
  withTempDir((dir) => {
    const version = '1.0.0-dev.10';
    const metadataDir = join(dir, 'updates');

    const missingDir = writeAssets(join(dir, 'missing'), version);
    rmSync(join(missingDir, assetNames(version)[0]));
    assert.throws(
      () => prepareMetadata({ assetsDir: missingDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir }),
      /missing canonical public archive/,
    );

    const extraDir = writeAssets(join(dir, 'extra'), version);
    writeFileSync(join(extraDir, `wrenyard-desktop-${version}-darwin-x64.dmg`), 'nope');
    assert.throws(
      () => prepareMetadata({ assetsDir: extraDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir }),
      /not a canonical public archive/,
    );

    const malformedDir = writeAssets(join(dir, 'malformed'), version);
    writeFileSync(join(malformedDir, 'unexpected.zip'), 'nope');
    assert.throws(
      () => prepareMetadata({ assetsDir: malformedDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir }),
      /not a canonical public archive/,
    );

    const goodDir = writeAssets(join(dir, 'good'), version);
    assert.throws(
      () => prepareMetadata({ assetsDir: goodDir, version: 'not-a-version', repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir }),
      /invalid version/,
    );
    assert.throws(
      () => prepareMetadata({ assetsDir: goodDir, version, repository: 'not a repo', publishedAt: PUBLISHED_AT, metadataDir }),
      /invalid repository/,
    );
    assert.throws(
      () => prepareMetadata({ assetsDir: goodDir, version, repository: REPOSITORY, publishedAt: 'never', metadataDir }),
      /invalid published_at/,
    );
  });
});

test('rejects a conflicting document for an already published version', () => {
  withTempDir((dir) => {
    const version = '1.0.0-dev.10';
    const assetsDir = writeAssets(dir, version);
    const metadataDir = join(dir, 'updates');
    prepareMetadata({ assetsDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir });

    assert.throws(
      () => prepareMetadata({
        assetsDir,
        version,
        repository: REPOSITORY,
        publishedAt: '2026-09-15T00:00:00.000Z',
        metadataDir,
      }),
      /immutable version metadata already exists with different content/,
    );
  });
});

test('is idempotent across retries with the same caller-supplied timestamp', () => {
  withTempDir((dir) => {
    const version = '1.0.0-dev.10';
    const assetsDir = writeAssets(dir, version);
    const metadataDir = join(dir, 'updates');
    const options = { assetsDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir };
    const first = prepareMetadata(options);
    const before = renderDocument(JSON.parse(readFileSync(join(metadataDir, 'dev.json'), 'utf8')));
    const second = prepareMetadata(options);
    const after = renderDocument(JSON.parse(readFileSync(join(metadataDir, 'dev.json'), 'utf8')));
    assert.equal(before, after);
    assert.equal(first.updatedChannel, true);
    assert.equal(second.updatedChannel, false);
  });
});

test('an older release never regresses the channel head', () => {
  withTempDir((dir) => {
    const metadataDir = join(dir, 'updates');
    const newer = '1.0.0-dev.10';
    const older = '1.0.0-dev.9';

    const newerAssets = writeAssets(join(dir, 'newer'), newer);
    prepareMetadata({ assetsDir: newerAssets, version: newer, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir });
    const head = readFileSync(join(metadataDir, 'dev.json'), 'utf8');

    const olderAssets = writeAssets(join(dir, 'older'), older);
    const result = prepareMetadata({ assetsDir: olderAssets, version: older, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir });

    assert.equal(result.updatedChannel, false);
    assert.equal(readFileSync(join(metadataDir, 'dev.json'), 'utf8'), head);
    // The immutable snapshot for the older version is still recorded.
    const snapshot = JSON.parse(readFileSync(join(metadataDir, 'versions', `${older}.json`), 'utf8'));
    assert.equal(snapshot.version, older);

    const laterVersion = '1.0.0-dev.11';
    const laterAssets = writeAssets(join(dir, 'later'), laterVersion);
    const later = prepareMetadata({ assetsDir: laterAssets, version: laterVersion, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir });
    assert.equal(later.updatedChannel, true);
    assert.equal(JSON.parse(readFileSync(join(metadataDir, 'dev.json'), 'utf8')).version, laterVersion);
  });
});

test('routes stable versions to stable.json and dev prereleases to dev.json', () => {
  assert.equal(channelForVersion('1.0.0'), 'stable');
  assert.equal(channelForVersion('1.0.0-dev.10'), 'dev');
  withTempDir((dir) => {
    const version = '1.0.0';
    const assetsDir = writeAssets(dir, version);
    const metadataDir = join(dir, 'updates');
    const result = prepareMetadata({ assetsDir, version, repository: REPOSITORY, publishedAt: PUBLISHED_AT, metadataDir });
    assert.equal(result.channel, 'stable');
    assert.equal(JSON.parse(readFileSync(join(metadataDir, 'stable.json'), 'utf8')).version, version);
  });
});
