/**
 * Pure static update-feed contract.
 *
 * This is the client-side half of the `updates` branch static feed. It contains
 * no Node imports, performs no I/O and has no import side effects, so it can be
 * bundled into the Desktop main process unchanged.
 *
 * Feed layout (base URL defaults to {@link DEFAULT_UPDATE_BASE_URL}):
 *
 *   <base>/dev.json             channel head for prereleases
 *   <base>/stable.json          channel head for stable releases
 *   <base>/versions/<v>.json    immutable per-version snapshot
 *
 * Document schema `wrenyard.update.v1`:
 *
 *   { schema_version, version, published_at, assets: [{ name, url, sha256 }] }
 *
 * Client parsing rules, shared by Desktop and the release tooling:
 *
 *   - read the channel head when no version is requested, otherwise the
 *     immutable `versions/<v>.json` document;
 *   - derive the channel from the running version: a prerelease reads
 *     `dev.json`, a plain release reads `stable.json`;
 *   - validate the schema, that the version is valid SemVer, that both assets
 *     for the host triplet are present, and that every digest is 64 hex.
 *
 * Each platform publishes a first-install asset (`installer`) and an in-app
 * update asset (`update`). On Windows both resolve to the same NSIS
 * `setup.exe`; on macOS the installer is a DMG and the updater consumes a ZIP.
 *
 * Asset URLs are deliberately NOT required to be canonical GitHub download
 * URLs. The URL and digest come from the same document, so a canonical-URL
 * check adds no integrity guarantee while it prevents local end-to-end tests
 * from serving the feed over a local HTTP server. Integrity is the sha256.
 */

/** Schema identifier carried by every published update document. */
export const UPDATE_FEED_SCHEMA_VERSION = 'wrenyard.update.v1';

/** Default feed location: the root of the `updates` branch. */
const DEFAULT_UPDATE_BASE_URL =
  'https://raw.githubusercontent.com/wrenyard/wrenyard/updates';

/** Release channels. A prerelease version resolves to `dev`, a plain release to `stable`. */
type UpdateChannel = 'dev' | 'stable';

/** Host triplets that publish Desktop installer and update assets. */
export type PlatformTriplet = 'darwin-arm64' | 'win32-x64';

/** One downloadable release asset as advertised by the feed. */
interface UpdateFeedAsset {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
}

/** One immutable feed document. */
interface UpdateFeedDocument {
  readonly schema_version: string;
  readonly version: string;
  readonly published_at: string;
  readonly assets: readonly UpdateFeedAsset[];
}

/** The two resolved assets for one host triplet. */
interface PlatformAssets {
  /** First-install asset (DMG on macOS, setup.exe on Windows). */
  readonly installer: UpdateFeedAsset;
  /** In-app update asset (ZIP on macOS, setup.exe on Windows). */
  readonly update: UpdateFeedAsset;
}

/** Options for {@link parseUpdateFeed}. */
interface ParseUpdateFeedOptions {
  readonly triplet: PlatformTriplet;
  /** When set, the document version must equal this value (a leading `v` is accepted). */
  readonly expectedVersion?: string;
  /** Overrides the channel inferred from the document version. */
  readonly channel?: UpdateChannel;
}

/** A validated feed document plus the host triplet's installer and update assets. */
interface ParsedUpdateFeed extends PlatformAssets {
  readonly document: UpdateFeedDocument;
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly triplet: PlatformTriplet;
}

/** Selects the document a client should read. */
interface UpdateDocumentTarget {
  /** Explicit version: read `versions/<v>.json`. */
  readonly version?: string;
  /** Channel head to read when no version is given. Defaults to `dev`. */
  readonly channel?: UpdateChannel;
}

/** Environment slice consulted by {@link resolveUpdateBaseUrl}. */
interface UpdateBaseUrlEnvironment {
  readonly WRENYARD_UPDATE_BASE_URL?: string | undefined;
}

// Strict SemVer: no leading zero in a numeric core or numeric prerelease
// identifier, no empty identifier and no trailing dot in the prerelease. Build
// metadata (the optional `+...` suffix) is accepted but never participates in
// ordering.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// A digest is 64 hexadecimal characters; uppercase input is accepted and
// normalized to lowercase so comparisons against tool output are stable.
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

/** True when `value` is a strict SemVer string (leading `v` is not accepted). */
export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

/** Strips a single leading `v` from a version, if present. */
export function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Numeric SemVer ordering. Never compare version strings lexicographically:
 * `dev.9` sorts after `dev.10` as strings, which would let a stale release roll
 * the channel backwards. Build metadata is ignored, per the SemVer spec.
 */
export function compareVersions(a: string, b: string): number {
  if (!isSemver(a) || !isSemver(b)) {
    throw new Error(`invalid version for ordering: ${a} / ${b}`);
  }
  const left = SEMVER_PATTERN.exec(a);
  const right = SEMVER_PATTERN.exec(b);
  if (left === null || right === null) {
    throw new Error(`invalid version for ordering: ${a} / ${b}`);
  }
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(left[i]) - Number(right[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  const leftPrerelease = left[4];
  const rightPrerelease = right[4];
  if (leftPrerelease === undefined && rightPrerelease === undefined) return 0;
  if (leftPrerelease === undefined) return 1; // a plain release outranks a prerelease
  if (rightPrerelease === undefined) return -1;
  const leftParts = leftPrerelease.split('.');
  const rightParts = rightPrerelease.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const leftPart = leftParts[i];
    const rightPart = rightParts[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1; // numeric ranks below alphanumeric
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Shared prefix for every Desktop distribution asset of a version and triplet. */
export function desktopAssetStem(version: string, triplet: PlatformTriplet): string {
  return `wrenyard-desktop-${normalizeVersion(version)}-${triplet}`;
}

/**
 * The canonical first-install asset name for a version and host triplet: the
 * NSIS `setup.exe` on Windows, the DMG on macOS.
 */
export function installerAssetName(version: string, triplet: PlatformTriplet): string {
  const stem = desktopAssetStem(version, triplet);
  return triplet === 'win32-x64' ? `${stem}-setup.exe` : `${stem}.dmg`;
}

/**
 * The canonical in-app update asset name for a version and host triplet: the
 * applier reuses the same NSIS `setup.exe` on Windows and a ZIP on macOS.
 */
export function updateAssetName(version: string, triplet: PlatformTriplet): string {
  const stem = desktopAssetStem(version, triplet);
  return triplet === 'win32-x64' ? `${stem}-setup.exe` : `${stem}.zip`;
}

/** Derives the release channel from a version: prereleases read `dev`. */
export function channelForVersion(version: string): UpdateChannel {
  if (!isSemver(version)) throw new Error(`invalid version: ${version}`);
  return version.includes('-') ? 'dev' : 'stable';
}

/** URL of a channel head document (`dev.json` / `stable.json`). */
export function channelDocumentUrl(baseUrl: string, channel: UpdateChannel): string {
  return `${trimTrailingSlash(baseUrl)}/${channel}.json`;
}

/**
 * URL of the document a client should read: the immutable version document
 * when a version is given, otherwise the channel head (default `dev`).
 */
export function updateDocumentUrl(baseUrl: string, target: UpdateDocumentTarget = {}): string {
  if (target.version !== undefined && target.version !== '') {
    return `${trimTrailingSlash(baseUrl)}/versions/${normalizeVersion(target.version)}.json`;
  }
  return channelDocumentUrl(baseUrl, target.channel ?? 'dev');
}

/** Resolves the feed base URL from `WRENYARD_UPDATE_BASE_URL`, else the default. */
export function resolveUpdateBaseUrl(env: UpdateBaseUrlEnvironment = {}): string {
  const override = env.WRENYARD_UPDATE_BASE_URL;
  return override !== undefined && override !== '' ? override : DEFAULT_UPDATE_BASE_URL;
}

function readAsset(record: unknown, index: number): UpdateFeedAsset {
  if (!isRecord(record)) {
    throw new Error(`update feed asset #${index} is not an object`);
  }
  const name = record.name;
  const url = record.url;
  const sha256 = record.sha256;
  if (typeof name !== 'string' || name === '') {
    throw new Error(`update feed asset #${index} has no name`);
  }
  if (typeof url !== 'string' || url === '') {
    throw new Error(`update feed asset ${name} has no url`);
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`update feed asset ${name} has an invalid sha256 digest`);
  }
  return { name, url, sha256: sha256.toLowerCase() };
}

/**
 * Validates an already-parsed feed document and resolves the host triplet's
 * installer and update assets. Throws on any schema, version, name or digest
 * violation; never touches the network or the filesystem.
 */
function parseUpdateFeed(input: unknown, options: ParseUpdateFeedOptions): ParsedUpdateFeed {
  const { triplet, expectedVersion, channel: requestedChannel } = options;
  if (!isRecord(input)) {
    throw new Error('update feed is not a JSON object');
  }
  if (input.schema_version !== UPDATE_FEED_SCHEMA_VERSION) {
    throw new Error(`unsupported update feed schema: ${String(input.schema_version)}`);
  }
  const version = input.version;
  if (!isSemver(version)) {
    throw new Error(`update feed version is not valid semver: ${String(version)}`);
  }
  if (expectedVersion !== undefined) {
    const expected = normalizeVersion(expectedVersion);
    if (version !== expected) {
      throw new Error(`update feed version mismatch (expected ${expected}, got ${version})`);
    }
  }
  if (!Array.isArray(input.assets)) {
    throw new Error('update feed has no assets array');
  }
  const assets = input.assets.map(readAsset);
  const byName = new Map<string, UpdateFeedAsset>();
  for (const asset of assets) {
    if (byName.has(asset.name)) {
      throw new Error(`update feed has duplicate asset records for ${asset.name}`);
    }
    byName.set(asset.name, asset);
  }
  // On Windows the installer and the update asset are the same setup.exe, so a
  // single lookup resolves both without duplicating the record.
  const installerName = installerAssetName(version, triplet);
  const installer = byName.get(installerName);
  if (installer === undefined) {
    throw new Error(`update feed has no asset ${installerName}`);
  }
  const updateName = updateAssetName(version, triplet);
  const update = byName.get(updateName);
  if (update === undefined) {
    throw new Error(`update feed has no asset ${updateName}`);
  }
  return {
    document: {
      schema_version: UPDATE_FEED_SCHEMA_VERSION,
      version,
      published_at: typeof input.published_at === 'string' ? input.published_at : '',
      assets,
    },
    version,
    channel: requestedChannel ?? channelForVersion(version),
    triplet,
    installer,
    update,
  };
}

/** Parses feed JSON text with {@link parseUpdateFeed}. */
export function parseUpdateFeedJson(text: string, options: ParseUpdateFeedOptions): ParsedUpdateFeed {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('update feed is not valid JSON');
  }
  return parseUpdateFeed(input, options);
}
