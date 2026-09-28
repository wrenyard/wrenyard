/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UPDATE_FEED_SCHEMA_VERSION,
  channelDocumentUrl,
  channelForVersion,
  compareVersions,
  installerAssetName,
  parseUpdateFeedJson,
  updateAssetName,
  updateDocumentUrl,
} from './update-feed.ts';

const VERSION = '1.0.0-dev.41';
const TRIPLET = 'darwin-arm64';
const INSTALLER_SHA = 'a'.repeat(64);
const UPDATE_SHA = 'b'.repeat(64);

interface FeedAsset {
  name: string;
  url: string;
  sha256: string;
}

interface FeedOptions {
  version?: string;
  schema?: string;
  assets?: FeedAsset[];
}

function asset(name: string, sha256: string, url = `https://example.test/${name}`): FeedAsset {
  return { name, url, sha256 };
}

function feed({ version = VERSION, assets, schema = UPDATE_FEED_SCHEMA_VERSION }: FeedOptions = {}) {
  return JSON.stringify({
    schema_version: schema,
    version,
    published_at: '2026-09-25T00:00:00.000Z',
    assets:
      assets ??
      [
        asset(installerAssetName(version, 'darwin-arm64'), INSTALLER_SHA),
        asset(updateAssetName(version, 'darwin-arm64'), UPDATE_SHA),
        asset(installerAssetName(version, 'win32-x64'), 'c'.repeat(64)),
      ],
  });
}

test('accepts a canonical document and resolves both host assets', () => {
  const parsed = parseUpdateFeedJson(feed(), { triplet: TRIPLET });
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.channel, 'dev');
  assert.equal(parsed.triplet, TRIPLET);
  assert.equal(parsed.installer.name, installerAssetName(VERSION, TRIPLET));
  assert.equal(parsed.installer.sha256, INSTALLER_SHA);
  assert.equal(parsed.update.name, updateAssetName(VERSION, TRIPLET));
  assert.equal(parsed.update.sha256, UPDATE_SHA);
  assert.equal(parsed.document.schema_version, UPDATE_FEED_SCHEMA_VERSION);
});

test('rejects a non-v1 schema', () => {
  assert.throws(
    () => parseUpdateFeedJson(feed({ schema: 'wrenyard.update.v0' }), { triplet: TRIPLET }),
    /unsupported update feed schema/,
  );
});

test('rejects a non-semver document version', () => {
  assert.throws(
    () => parseUpdateFeedJson(feed({ version: 'not-a-version' }), { triplet: TRIPLET }),
    /not valid semver/,
  );
});

test('rejects a missing host asset', () => {
  const withoutUpdate = feed({
    assets: [
      asset(installerAssetName(VERSION, 'darwin-arm64'), INSTALLER_SHA),
      asset(installerAssetName(VERSION, 'win32-x64'), 'c'.repeat(64)),
    ],
  });
  assert.throws(() => parseUpdateFeedJson(withoutUpdate, { triplet: TRIPLET }), /has no asset/);
});

test('rejects an invalid digest', () => {
  const malformed = feed({
    assets: [
      asset(installerAssetName(VERSION, 'darwin-arm64'), 'sha256:not-a-digest'),
      asset(updateAssetName(VERSION, 'darwin-arm64'), UPDATE_SHA),
    ],
  });
  assert.throws(() => parseUpdateFeedJson(malformed, { triplet: TRIPLET }), /invalid sha256 digest/);
});

test('derives canonical asset names and normalizes a leading v', () => {
  assert.equal(installerAssetName(VERSION, TRIPLET), `wrenyard-desktop-${VERSION}-darwin-arm64.dmg`);
  assert.equal(updateAssetName(VERSION, TRIPLET), `wrenyard-desktop-${VERSION}-darwin-arm64.zip`);
  assert.equal(installerAssetName(`v${VERSION}`, 'win32-x64'), `wrenyard-desktop-${VERSION}-win32-x64-setup.exe`);
  assert.equal(updateAssetName(VERSION, 'win32-x64'), installerAssetName(VERSION, 'win32-x64'));
});

test('infers the channel from the version', () => {
  assert.equal(channelForVersion('1.0.0-dev.10'), 'dev');
  assert.equal(channelForVersion('1.0.0'), 'stable');
  assert.throws(() => channelForVersion('nope'), /invalid version/);
});

test('constructs channel, version and generic document URLs', () => {
  assert.equal(channelDocumentUrl('https://feed.test/base/', 'dev'), 'https://feed.test/base/dev.json');
  assert.equal(channelDocumentUrl('https://feed.test/base', 'stable'), 'https://feed.test/base/stable.json');
  assert.equal(updateDocumentUrl('https://feed.test/base', { version: VERSION }), `https://feed.test/base/versions/${VERSION}.json`);
  assert.equal(updateDocumentUrl('https://feed.test/base', { channel: 'stable' }), 'https://feed.test/base/stable.json');
  assert.equal(updateDocumentUrl('https://feed.test/base'), 'https://feed.test/base/dev.json');
});

test('orders prereleases numerically: dev.9 is older than dev.10', () => {
  assert.ok(compareVersions('1.0.0-dev.9', '1.0.0-dev.10') < 0);
  assert.ok(compareVersions('1.0.0-dev.10', '1.0.0-dev.9') > 0);
  assert.equal(compareVersions('1.0.0-dev.10', '1.0.0-dev.10'), 0);
  assert.ok(compareVersions('1.0.0-dev.9', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.1', '1.0.0-dev.10') > 0);
  assert.ok(compareVersions('0.9.0', '1.0.0-dev.10') < 0);
  assert.throws(() => compareVersions('bad', '1.0.0'), /invalid version/);
});
