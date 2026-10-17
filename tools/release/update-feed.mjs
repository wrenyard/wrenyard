import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requirePlainVersion } from './release-context.mjs';
import { REMOTE_TARGETS, remotePayloadName, remoteMetadataName } from './remote-payload.mjs';

import {
  UPDATE_FEED_SCHEMA_VERSION as SCHEMA_VERSION,
  compareVersions,
  installerAssetName,
  isSemver,
  updateAssetName,
} from '../../packages/protocol/src/update-feed.ts';

// Static update feed generator.
//
// The public client contract is one canonical metadata document plus an
// immutable snapshot per published version. Every release writes the same
// document to three paths on the `updates` branch:
//
//   updates/latest.json         canonical feed head (all current clients)
//   updates/dev.json            byte-identical compatibility alias, read by
//                               installs that predate the single-feed scheme
//   updates/versions/<v>.json   immutable snapshot for one release
//
// Shape (schema_version "wrenyard.update.v1"):
//
//   {
//     "schema_version": "wrenyard.update.v1",
//     "version": "<semver>",
//     "published_at": "<ISO-8601>",
//     "assets": [
//       { "name": "<asset name>", "url": "<release download url>", "sha256": "<64 hex>" }
//     ],
//     "remote_payloads": [
//       { "target": "<triplet>", "name": "<archive>", "url": "<url>", "sha256": "<64 hex>" }
//     ]
//   }
//
// `remote_payloads` is optional and omitted when a release has no remote daemon
// bootstrap payloads.
//
// Every release publishes exactly four Desktop assets: the macOS installer
// (DMG), the macOS in-app update (ZIP), the Windows installer/update (NSIS
// setup.exe) and the Linux installer/update (AppImage). A release may
// additionally carry target-specific remote daemon bootstrap payloads; when
// present they are listed, hashed, in the optional `remote_payloads` field,
// which clients that predate it simply ignore.
//
// Everything in this module is pure generation/preparation. It never reads
// credentials, never talks to git, and never publishes anything: the release
// workflow commits the prepared directory. The generated file is rendered with
// two-space indentation, one key per line, so the committed document is stable.

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The four canonical public asset names are derived from the requested
// version, so a wrong-version asset (e.g. dev25 names staged for a dev26
// release) or a missing/mislabeled installer can never be published.
export function canonicalAssetNames(version) {
  return [
    installerAssetName(version, 'darwin-arm64'),
    updateAssetName(version, 'darwin-arm64'),
    installerAssetName(version, 'win32-x64'),
    installerAssetName(version, 'linux-x64'),
  ];
}

// The remote daemon bootstrap payloads published alongside the Desktop assets:
// one archive, its checksum sidecar and its matching-version metadata per
// supported target. They are additive to the Desktop asset contract and are
// advertised in the feed's optional `remote_payloads` digest list.
export function remotePayloadAssetNames(version) {
  requirePlainVersion(version);
  const names = [];
  for (const target of REMOTE_TARGETS) {
    const archive = remotePayloadName(version, target);
    names.push(archive, `${archive}.sha256`, remoteMetadataName(version, target));
  }
  return names;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertRepository(repository) {
  const normalized = String(repository ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!REPOSITORY_PATTERN.test(normalized)) {
    throw new Error(`invalid repository: ${repository}`);
  }
  return normalized;
}

function assertTimestamp(publishedAt) {
  const stamp = String(publishedAt ?? '');
  const parsed = new Date(stamp);
  if (stamp === '' || Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid published_at: ${publishedAt}`);
  }
  return parsed.toISOString();
}

// The assets must be exactly the canonical Desktop names derived from the
// requested version, or one of the additive remote payload artifacts. A missing,
// extra, wrong-version or malformed Desktop name is a hard error: a feed that
// advertises a partial or mislabeled asset set would break every client that
// trusts it.
export function assertAssetNames(names, version) {
  const expected = canonicalAssetNames(version);
  const expectedSet = new Set(expected);
  const allowed = new Set([...expected, ...remotePayloadAssetNames(version)]);
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !allowed.has(name)) {
      throw new Error(`release asset is not a canonical public archive: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate release asset for ${name}`);
    }
    seen.add(name);
  }
  for (const name of expectedSet) {
    if (!seen.has(name)) {
      throw new Error(`missing canonical public archive ${name}`);
    }
  }
  return expected;
}

// The matching-version remote daemon payloads present in `assetsDir`, hashed the
// same way as the Desktop assets. The list is optional: a staging directory with
// no remote payload leaves the feed document's `remote_payloads` field absent.
function collectRemotePayloads({ version, repository, assetsDir }) {
  const payloads = [];
  for (const target of REMOTE_TARGETS) {
    const name = remotePayloadName(version, target);
    const path = resolve(assetsDir, name);
    if (!existsSync(path)) continue;
    const sha256 = sha256File(path);
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`malformed sha256 for ${name}`);
    payloads.push({
      target,
      name,
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
      sha256,
    });
  }
  return payloads;
}

// Build one immutable version document from local release assets. `assetsDir`
// holds the four installers, which are hashed here so the manifest can never
// disagree with what was uploaded, and every asset URL is derived from the
// validated version/repository rather than being accepted from the caller. Any
// remote daemon payload archives present are recorded in `remote_payloads`.
export function buildVersionDocument({ version, repository, publishedAt, assetsDir }) {
  // Fail closed on prerelease or build-metadata versions before any feed file
  // is created or written; prepareMetadata and the CLI both funnel through here.
  requirePlainVersion(version);
  const repo = assertRepository(repository);
  const published = assertTimestamp(publishedAt);
  const names = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const canonical = assertAssetNames(names, version);
  const assets = canonical.map((name) => {
    const path = resolve(assetsDir, name);
    if (!existsSync(path)) throw new Error(`release asset is missing: ${name}`);
    const sha256 = sha256File(path);
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`malformed sha256 for ${name}`);
    return {
      name,
      url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
      sha256,
    };
  });
  const remotePayloads = collectRemotePayloads({ version, repository: repo, assetsDir });
  return remotePayloads.length > 0
    ? { schema_version: SCHEMA_VERSION, version, published_at: published, assets, remote_payloads: remotePayloads }
    : { schema_version: SCHEMA_VERSION, version, published_at: published, assets };
}

export function renderDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readExisting(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`existing metadata is not valid JSON at ${path}: ${error.message}`);
  }
}

// The feed head is the newest version carried by any head document. Validating
// each present head keeps a malformed legacy dev.json from being silently
// overwritten during the single-feed migration.
function newestHeadVersion(heads) {
  let newest;
  for (const [label, document] of heads) {
    if (document === null) continue;
    const version = document.version;
    if (version === undefined) continue;
    if (!isSemver(version)) {
      throw new Error(`${label} metadata has an invalid version: ${version}`);
    }
    if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

// Prepare the metadata directory without publishing anything.
//
// Returns the list of files that changed so the caller can stage exactly those:
// the immutable versions/<version>.json snapshot, the canonical latest.json head
// and its byte-identical dev.json compatibility alias. Repeat runs with
// identical content are no-ops; a conflicting snapshot for an already published
// version is rejected instead of overwritten, and an older release never
// regresses the feed head — including the first plain release, when dev.json
// (the legacy head) already carries a newer version than latest.json, which must
// not be rolled back.
export function prepareMetadata({ assetsDir, version, repository, publishedAt, metadataDir }) {
  const document = buildVersionDocument({ version, repository, publishedAt, assetsDir });
  const versionsDir = resolve(metadataDir, 'versions');
  const versionPath = resolve(versionsDir, `${version}.json`);
  const latestPath = resolve(metadataDir, 'latest.json');
  const devPath = resolve(metadataDir, 'dev.json');
  const rendered = renderDocument(document);

  const existingVersion = readExisting(versionPath);
  if (existingVersion !== null && renderDocument(existingVersion) !== rendered) {
    throw new Error(`immutable version metadata already exists with different content: ${version}`);
  }

  // The canonical head is latest.json; dev.json is a byte-identical alias. Both
  // heads are compared together so a late older release never regresses either.
  const existingLatest = readExisting(latestPath);
  const existingDev = readExisting(devPath);
  const headVersion = newestHeadVersion([['latest', existingLatest], ['dev', existingDev]]);
  if (headVersion !== undefined && compareVersions(version, headVersion) < 0) {
    // An older concurrent release finished late: keep the newer feed head but
    // still record the immutable snapshot for this version.
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(versionPath, rendered);
    return { files: [versionPath], updatedHead: false, document };
  }

  const headChanged =
    existingLatest === null || existingDev === null
    || renderDocument(existingLatest) !== rendered || renderDocument(existingDev) !== rendered;
  const files = [versionPath];
  mkdirSync(versionsDir, { recursive: true });
  writeFileSync(versionPath, rendered);
  if (headChanged) {
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(latestPath, rendered);
    writeFileSync(devPath, rendered);
    files.unshift(latestPath, devPath);
  }
  return { files, updatedHead: headChanged, document };
}

function main(argv) {
  const [metadataDir, assetsDir, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    options[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  if (!metadataDir || !assetsDir || !options.version || !options.repository) {
    throw new Error(
      'usage: node update-feed.mjs <metadata-dir> <assets-dir> --version V --repository OWNER/REPO [--published-at ISO]',
    );
  }
  const publishedAt = options['published-at'] ?? new Date().toISOString();
  const result = prepareMetadata({
    assetsDir,
    version: options.version,
    repository: options.repository,
    publishedAt,
    metadataDir,
  });
  for (const file of result.files) {
    process.stdout.write(`${file}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { SCHEMA_VERSION, isSemver, compareVersions };
