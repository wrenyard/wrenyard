import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static update feed generator.
//
// The public client contract is a single metadata document per channel plus an
// immutable snapshot per published version:
//
//   updates/<channel>.json          stable.json or dev.json (mutable channel head)
//   updates/versions/<version>.json immutable snapshot for one release
//
// Shape (schema_version "wrenyard.update.v1"):
//
//   {
//     "schema_version": "wrenyard.update.v1",
//     "version": "<semver>",
//     "published_at": "<ISO-8601>",
//     "assets": [
//       { "name": "<archive name>", "url": "<release download url>", "sha256": "<64 hex>" }
//     ]
//   }
//
// Everything in this module is pure generation/preparation. It never reads
// credentials, never talks to git, and never publishes anything: the release
// workflow commits the prepared directory. The generated file is rendered with
// two-space indentation, one key per line, so the committed document is stable.

const SCHEMA_VERSION = 'wrenyard.update.v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Strict SemVer: no leading zero in a numeric core or numeric prerelease
// identifier, no empty identifier and no trailing dot in the prerelease.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The four canonical public archive names are derived from the requested
// version, so a wrong-version asset (e.g. dev25 names staged for a dev26
// release) or a missing/wrong Desktop prefix can never be published.
function canonicalAssetNames(version) {
  return [
    `wrenyard-${version}-darwin-arm64-suite.zip`,
    `wrenyard-desktop-${version}-darwin-arm64.zip`,
    `wrenyard-${version}-win32-x64-suite.zip`,
    `wrenyard-desktop-${version}-win32-x64.zip`,
  ];
}

export function isSemver(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Numeric semver ordering. Never compare version strings lexicographically:
// "dev.9" > "dev.10" under string ordering, which would let a stale release
// roll the channel backwards.
export function compareVersions(a, b) {
  if (!isSemver(a) || !isSemver(b)) {
    throw new Error(`invalid version for ordering: ${a} / ${b}`);
  }
  const left = SEMVER_PATTERN.exec(a);
  const right = SEMVER_PATTERN.exec(b);
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(left[i]) - Number(right[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  const lp = left[4];
  const rp = right[4];
  if (lp === undefined && rp === undefined) return 0;
  if (lp === undefined) return 1; // a plain release outranks a prerelease
  if (rp === undefined) return -1;
  const lparts = lp.split('.');
  const rparts = rp.split('.');
  const len = Math.max(lparts.length, rparts.length);
  for (let i = 0; i < len; i += 1) {
    const lv = lparts[i];
    const rv = rparts[i];
    if (lv === undefined) return -1;
    if (rv === undefined) return 1;
    const ln = /^\d+$/.test(lv);
    const rn = /^\d+$/.test(rv);
    if (ln && rn) {
      const delta = Number(lv) - Number(rv);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (ln !== rn) return ln ? -1 : 1; // numeric identifiers rank below alphanumeric
    if (lv !== rv) return lv < rv ? -1 : 1;
  }
  return 0;
}

export function channelForVersion(version) {
  if (!isSemver(version)) throw new Error(`invalid version: ${version}`);
  return version.includes('-') ? 'dev' : 'stable';
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

// The four assets must be exactly the canonical names derived from the
// requested version. A missing, extra, wrong-version or malformed name is a
// hard error: a feed that advertises a partial or mislabeled archive set would
// break every client that trusts it.
export function assertAssetNames(names, version) {
  const expected = canonicalAssetNames(version);
  const expectedSet = new Set(expected);
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !expectedSet.has(name)) {
      throw new Error(`release asset is not a canonical public archive: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate release asset for ${name}`);
    }
    seen.add(name);
  }
  for (const name of expected) {
    if (!seen.has(name)) {
      throw new Error(`missing canonical public archive ending in ${name.slice(`wrenyard-${version}`.length)}`);
    }
  }
  return expected;
}

// Build one immutable version document from local release assets. `assetsDir`
// holds the four archives, which are hashed here so the manifest can never
// disagree with what was uploaded, and every asset URL is derived from the
// validated version/repository rather than being accepted from the caller.
export function buildVersionDocument({ version, repository, publishedAt, assetsDir }) {
  if (!isSemver(version)) throw new Error(`invalid version: ${version}`);
  const repo = assertRepository(repository);
  const published = assertTimestamp(publishedAt);
  const names = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.zip'))
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
  return {
    schema_version: SCHEMA_VERSION,
    version,
    published_at: published,
    assets,
  };
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

// Prepare the metadata directory without publishing anything.
//
// Returns the list of files that changed so the caller can stage exactly those:
// the immutable versions/<version>.json and the mutable channel head. Repeat
// runs with identical content are no-ops; a conflicting snapshot for an already
// published version is rejected instead of overwritten, and an older release
// never regresses the channel head.
export function prepareMetadata({ assetsDir, version, repository, publishedAt, metadataDir }) {
  const document = buildVersionDocument({ version, repository, publishedAt, assetsDir });
  const channel = channelForVersion(version);
  const versionsDir = resolve(metadataDir, 'versions');
  const versionPath = resolve(versionsDir, `${version}.json`);
  const channelPath = resolve(metadataDir, `${channel}.json`);
  const rendered = renderDocument(document);

  const existingVersion = readExisting(versionPath);
  if (existingVersion !== null && renderDocument(existingVersion) !== rendered) {
    throw new Error(`immutable version metadata already exists with different content: ${version}`);
  }

  const existingChannel = readExisting(channelPath);
  const currentVersion = existingChannel?.version;
  if (existingChannel !== null && currentVersion !== undefined) {
    if (!isSemver(currentVersion)) {
      throw new Error(`channel metadata has an invalid version: ${currentVersion}`);
    }
    if (compareVersions(version, currentVersion) < 0) {
      // An older concurrent release finished late: keep the newer channel head
      // but still record the immutable snapshot for this version.
      mkdirSync(versionsDir, { recursive: true });
      writeFileSync(versionPath, rendered);
      return { channel, files: [versionPath], updatedChannel: false, document };
    }
  }

  const channelChanged =
    existingChannel === null || renderDocument(existingChannel) !== rendered;
  const files = [versionPath];
  mkdirSync(versionsDir, { recursive: true });
  writeFileSync(versionPath, rendered);
  if (channelChanged) {
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(channelPath, rendered);
    files.unshift(channelPath);
  }
  return { channel, files, updatedChannel: channelChanged, document };
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

export { SCHEMA_VERSION };
