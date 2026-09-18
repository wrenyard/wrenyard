import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateChannel, UpdateInstallReason, UpdateSnapshot } from './shell-contract.js';
import {
  readUpdateAttempt,
  sanitizeUpdateAttemptDetail,
  writeUpdateAttempt,
  UPDATE_ATTEMPT_SCHEMA,
  type UpdateAttemptPhase,
  type UpdateAttemptRecord,
  type UpdateAttemptStatus,
} from './update-attempt.js';
import type { UpdateHelperConfig } from './update-helper.js';
import type { InstallationDiscovery, InstallCapabilityReason } from './installation-discovery.js';

const DEFAULT_REPOSITORY = 'wrenyard/wrenyard';
const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_IDLE_RETRY_MS = 60_000;
const MANIFEST_SCHEMA = 'wrenyard.update.v1';
const MAC_APP_NAME = '啾啾工坊.app';
const WINDOWS_APP_DIR = 'Wrenyard Desktop';
const WINDOWS_EXE_NAME = 'wrenyard-desktop.exe';

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface UpdateManifestAsset {
  name: string;
  url: string;
  sha256: string;
}

export interface UpdateManifest {
  version: string;
  publishedAt?: string;
  assets: UpdateManifestAsset[];
}

export interface UpdateCandidate {
  version: string;
  desktopUrl: string;
  desktopSha256: string;
  suiteUrl: string;
  suiteSha256: string;
}

export interface CandidateSelection {
  candidate?: UpdateCandidate;
  hasChannelRelease: boolean;
}

export interface UpdateSettingsStore {
  loadUpdateChannel(fallback: UpdateChannel): UpdateChannel;
  saveUpdateChannel(channel: UpdateChannel): void;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => Promise<CommandResult>;

export interface PreparedUpdate {
  candidate: UpdateCandidate;
  stagedDesktop: string;
  cleanupRoots: string[];
}

interface UpdateResultDocument {
  status?: unknown;
  version?: unknown;
  message?: unknown;
}

export interface UpdateScheduler {
  setTimeout(handler: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, interval: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DesktopUpdateControllerOptions {
  currentVersion: string;
  settings: UpdateSettingsStore;
  cliPath?: string;
  helperPath?: string;
  helperRuntimePath?: string;
  /**
   * Re-probe the installation whenever an installation-sensitive operation
   * runs. The updater never caches a negative startup verdict: a repaired
   * installation becomes installable without restarting Desktop.
   */
  probeInstallation?: () => InstallationDiscovery;
  windowsTarPath?: string;
  desktopPath?: string;
  userDataPath: string;
  repository?: string;
  updateBaseUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  commandRunner?: CommandRunner;
  activeTaskCount?: () => Promise<number | null>;
  isBusy?: () => Promise<boolean>;
  onChanged?: (snapshot: UpdateSnapshot) => void;
  onInstall?: () => void;
  prepareCandidate?: (candidate: UpdateCandidate) => Promise<PreparedUpdate>;
  now?: () => number;
  homePath?: string;
  spawnDetached?: (command: string, args: string[], options: SpawnOptions) => void;
  scheduler?: UpdateScheduler;
}

const defaultUpdateScheduler: UpdateScheduler = {
  setTimeout(handler, delay) {
    const handle = setTimeout(handler, delay);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval(handler, interval) {
    const handle = setInterval(handler, interval);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function parseSemver(raw: string): ParsedSemver | null {
  const match = raw.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

/**
 * The feed is a COMPLETE manifest for exactly the canonical asset set produced by
 * CI: one suite and one Desktop archive per maintained target. Anything else is
 * rejected so the updater never acts on a partial or invented feed.
 */
function canonicalAssetNames(version: string): string[] {
  return [
    `wrenyard-desktop-${version}-darwin-arm64.zip`,
    `wrenyard-${version}-darwin-arm64-suite.zip`,
    `wrenyard-desktop-${version}-win32-x64.zip`,
    `wrenyard-${version}-win32-x64-suite.zip`,
  ];
}

function manifestCandidate(manifest: UpdateManifest, target: string): UpdateCandidate | null {
  if (!parseSemver(manifest.version)) return null;
  const desktopName = `wrenyard-desktop-${manifest.version}-${target}.zip`;
  const suiteName = `wrenyard-${manifest.version}-${target}-suite.zip`;
  const desktop = manifest.assets.find((asset) => asset.name === desktopName);
  const suite = manifest.assets.find((asset) => asset.name === suiteName);
  if (!desktop || !suite) return null;
  return {
    version: manifest.version,
    desktopUrl: desktop.url,
    desktopSha256: desktop.sha256,
    suiteUrl: suite.url,
    suiteSha256: suite.sha256,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error('invalid semantic version');
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function releaseTarget(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

export function parseAssetDigest(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid asset digest');
  const match = value.match(/^([a-f0-9]{64})$/iu);
  if (!match) throw new Error('invalid asset digest');
  return match[1]!.toLowerCase();
}

/**
 * Both dev.json and stable.json (and the release manifests they point at) share
 * this exact schema: {schema_version, version, published_at, assets}. There is no
 * channel field and no secondary version fetch — the payload is the whole feed.
 */
export function parseUpdateManifest(
  payload: unknown,
  channel: UpdateChannel,
  repository: string,
): UpdateManifest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('invalid update manifest');
  }
  const document = payload as Record<string, unknown>;
  if (document.schema_version !== MANIFEST_SCHEMA) throw new Error('invalid update manifest schema');
  const rawVersion = document.version;
  if (typeof rawVersion !== 'string' || !parseSemver(rawVersion)) {
    throw new Error('invalid update manifest version');
  }
  const parsedVersion = parseSemver(rawVersion)!;
  const version = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;
  if (channel === 'stable' && parsedVersion.prerelease.length > 0) {
    throw new Error('stable channel cannot serve a prerelease');
  }
  if (document.published_at !== undefined && typeof document.published_at !== 'string') {
    throw new Error('invalid update manifest timestamp');
  }
  if (!Array.isArray(document.assets)) throw new Error('invalid update manifest assets');
  const expected = canonicalAssetNames(version);
  if (document.assets.length !== expected.length) throw new Error('invalid update manifest assets');
  const seen = new Set<string>();
  const assets = document.assets.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('invalid update manifest asset');
    }
    const asset = entry as Record<string, unknown>;
    const name = asset.name;
    if (typeof name !== 'string' || !expected.includes(name)) {
      throw new Error('invalid update manifest asset name');
    }
    if (seen.has(name)) throw new Error('duplicate update manifest asset');
    seen.add(name);
    if (typeof asset.url !== 'string') throw new Error('invalid update manifest asset url');
    const prefix = `https://github.com/${repository}/releases/download/v${version}/`;
    if (!asset.url.startsWith(prefix) || asset.url.slice(prefix.length) !== name) {
      throw new Error('invalid update manifest asset url');
    }
    return { name, url: asset.url, sha256: parseAssetDigest(asset.sha256) };
  });
  if (seen.size !== expected.length) throw new Error('invalid update manifest assets');
  return {
    version,
    assets,
    ...(typeof document.published_at === 'string' ? { publishedAt: document.published_at } : {}),
  };
}

/**
 * A channel with no published release has no manifest at all. Within a single
 * published manifest the version is unique, so selection is simply: accept the
 * manifest when it is a permitted version for the channel and is newer than the
 * installed build.
 */
export function selectUpdateCandidate(
  manifests: UpdateManifest[],
  currentVersion: string,
  channel: UpdateChannel,
  target: string,
): CandidateSelection {
  if (!parseSemver(currentVersion)) throw new Error('invalid current version');
  const candidates = manifests
    .filter((manifest) => {
      const parsed = parseSemver(manifest.version);
      if (!parsed) return false;
      return channel === 'stable' ? parsed.prerelease.length === 0 : true;
    })
    .map((manifest) => manifestCandidate(manifest, target))
    .filter((candidate): candidate is UpdateCandidate => candidate !== null);
  return {
    candidate: candidates.find((candidate) => compareSemver(candidate.version, currentVersion) > 0),
    hasChannelRelease: candidates.length > 0,
  };
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-64 * 1024);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', () => resolveCommand({ status: null, stdout, stderr }));
    child.once('close', (status) => resolveCommand({ status, stdout, stderr }));
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.once('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

function findAppBundles(root: string, depth = 0): string[] {
  if (depth > 3) return [];
  const apps: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (entry.name.endsWith('.app')) apps.push(candidate);
    else apps.push(...findAppBundles(candidate, depth + 1));
  }
  return apps;
}

function findNamedFiles(root: string, name: string, depth = 0): string[] {
  if (depth > 3) return [];
  const matches: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(candidate);
    else if (entry.isDirectory()) matches.push(...findNamedFiles(candidate, name, depth + 1));
  }
  return matches;
}

function readBundleVersion(appPath: string): string | null {
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A resolved path is not the same as an installed component: the updater only
 * treats the helper as present when a regular file is actually there.
 */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultSpawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  child.unref();
}

export class DesktopUpdateController {
  private readonly currentVersion: string;
  private readonly settings: UpdateSettingsStore;
  private cliPath?: string;
  private helperRuntimePath?: string;
  private readonly helperPath?: string;
  private readonly probeInstallation?: () => InstallationDiscovery;
  private readonly windowsTarPath: string;
  private readonly desktopPath: string;
  private readonly userDataPath: string;
  private readonly repository: string;
  private readonly updateBaseUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher: typeof fetch;
  private readonly commandRunner: CommandRunner;
  private readonly activeTaskCount: () => Promise<number | null>;
  private readonly onChanged: (snapshot: UpdateSnapshot) => void;
  private readonly now: () => number;
  private readonly homePath: string;
  private readonly spawnDetached: (command: string, args: string[], options: SpawnOptions) => void;
  private readonly scheduler: UpdateScheduler;
  private readonly prepareCandidate: (candidate: UpdateCandidate) => Promise<PreparedUpdate>;
  private readonly onInstall: () => void;
  private installIntent = false;
  private installing = false;
  private launched = false;
  private pendingTimer?: unknown;
  private readonly target: string | null;
  private readonly resultPath: string;
  private snapshotValue: UpdateSnapshot;
  private candidate?: UpdateCandidate;
  private prepared?: PreparedUpdate;
  private attempt?: UpdateAttemptRecord;
  private releaseCache?: { fetchedAt: number; channel: UpdateChannel; manifest: UpdateManifest | null };
  private checkPromise?: Promise<UpdateSnapshot>;
  private delayTimer?: unknown;
  private intervalTimer?: unknown;

  constructor(options: DesktopUpdateControllerOptions) {
    this.currentVersion = options.currentVersion;
    this.settings = options.settings;
    this.cliPath = options.cliPath;
    this.probeInstallation = options.probeInstallation;
    this.helperPath = options.helperPath;
    this.helperRuntimePath = options.helperRuntimePath;
    this.windowsTarPath = options.windowsTarPath ?? resolveWindowsSystemTarPath(process.env.SystemRoot);
    this.userDataPath = options.userDataPath;
    this.repository = options.repository ?? DEFAULT_REPOSITORY;
    this.updateBaseUrl = (
      options.updateBaseUrl ?? `https://raw.githubusercontent.com/${this.repository}/updates`
    ).replace(/\/+$/u, '');
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetcher = options.fetcher ?? fetch;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.activeTaskCount = options.activeTaskCount
      ?? (options.isBusy ? async () => await options.isBusy!() ? 1 : 0 : async () => 0);
    this.onChanged = options.onChanged ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.homePath = options.homePath ?? homedir();
    this.spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
    this.scheduler = options.scheduler ?? defaultUpdateScheduler;
    this.prepareCandidate = options.prepareCandidate ?? this.prepareDesktop.bind(this);
    this.onInstall = options.onInstall ?? (() => undefined);
    this.target = releaseTarget(this.platform, this.arch);
    const localAppData = process.env.LOCALAPPDATA ?? join(this.homePath, 'AppData', 'Local');
    this.desktopPath = options.desktopPath ?? (this.platform === 'win32'
      ? join(localAppData, 'Programs', WINDOWS_APP_DIR)
      : join(this.homePath, 'Applications', MAC_APP_NAME));
    this.resultPath = join(this.userDataPath, 'update-result.json');
    const fallback: UpdateChannel = parseSemver(this.currentVersion)?.prerelease.length ? 'dev' : 'stable';
    const capability = this.installationCapability();
    this.snapshotValue = {
      channel: this.settings.loadUpdateChannel(fallback),
      state: 'idle',
      currentVersion: this.currentVersion,
      installSupported: capability.installSupported,
      ...(capability.reason !== undefined ? { installReason: capability.reason } : {}),
    };
    // The durable attempt record outlives the transient result file: it is read
    // once here and only ever replaced by a NEW install attempt, so a failed
    // update stays diagnosable across restarts and repeated version checks.
    this.attempt = readUpdateAttempt(this.userDataPath);
    this.consumeHelperResult();
  }

  /** Diagnostics for the most recent install attempt, if one was ever made. */
  getLastAttempt(): UpdateAttemptRecord | undefined {
    return this.attempt ? { ...this.attempt } : undefined;
  }

  private beginAttempt(targetVersion: string): void {
    this.recordAttempt({
      schema: UPDATE_ATTEMPT_SCHEMA,
      sourceVersion: this.currentVersion,
      targetVersion,
      startedAt: this.now(),
      status: 'in-progress',
      phase: 'prepare',
    });
  }

  private markAttemptPhase(phase: UpdateAttemptPhase): void {
    if (this.attempt?.status !== 'in-progress') return;
    this.recordAttempt({ ...this.attempt, phase });
  }

  private settleAttempt(status: UpdateAttemptStatus, phase: UpdateAttemptPhase, error?: unknown): void {
    if (this.attempt?.status !== 'in-progress') return;
    const detail = sanitizeUpdateAttemptDetail(error instanceof Error ? error.message : error);
    this.recordAttempt({
      ...this.attempt,
      status,
      phase,
      completedAt: this.now(),
      ...(detail !== undefined ? { error: detail } : {}),
    });
  }

  private recordAttempt(record: UpdateAttemptRecord): void {
    this.attempt = record;
    try {
      writeUpdateAttempt(this.userDataPath, record);
    } catch { /* diagnostics never block or fail an install */ }
  }

  /**
   * Re-resolve the CLI/runtime pair and return the current install capability.
   * Called on every check, retry and install so a repaired installation is
   * usable without restarting Desktop, and a broken one is never assumed
   * installable. A `platform`-level reason always wins over a missing path.
   */
  private installationCapability(): { installSupported: boolean; reason?: UpdateInstallReason } {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      return { installSupported: false, reason: 'unsupported-platform' };
    }
    if (this.target === null) return { installSupported: false, reason: 'unsupported-platform' };
    if (!this.helperPath || !isRegularFile(this.helperPath)) {
      return { installSupported: false, reason: 'missing-helper' };
    }

    if (this.probeInstallation) {
      const probe = this.probeInstallation();
      this.cliPath = probe.cliPath;
      this.helperRuntimePath = probe.runtimePath;
      const reason: InstallCapabilityReason | undefined = probe.reason
        ?? (probe.cliPath === undefined
          ? 'missing-cli'
          : probe.runtimePath === undefined ? 'missing-runtime' : undefined);
      if (reason === 'unsupported-platform') return { installSupported: false, reason: 'unsupported-platform' };
      if (reason !== undefined) return { installSupported: false, reason };
      return { installSupported: true };
    }

    if (!this.cliPath) return { installSupported: false, reason: 'missing-cli' };
    if (!this.helperRuntimePath) return { installSupported: false, reason: 'missing-runtime' };
    return { installSupported: true };
  }

  /** Re-probe the installation and publish the refreshed capability. */
  private refreshInstallability(): void {
    const capability = this.installationCapability();
    if (capability.installSupported === this.snapshotValue.installSupported
      && capability.reason === this.snapshotValue.installReason) {
      return;
    }
    this.setSnapshot({
      ...this.snapshotValue,
      installSupported: capability.installSupported,
      installReason: capability.reason,
    });
  }

  snapshot(): UpdateSnapshot {
    const lastAttempt = this.getLastAttempt();
    return { ...this.snapshotValue, ...(lastAttempt ? { lastAttempt } : {}) };
  }

  start(): void {
    if (this.delayTimer || this.intervalTimer) return;
    this.delayTimer = this.scheduler.setTimeout(() => {
      this.delayTimer = undefined;
      void this.check(false);
      this.intervalTimer = this.scheduler.setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, CHECK_DELAY_MS);
  }

  stop(): void {
    this.clearPendingTimer();
    this.installIntent = false;
    this.launched = false;
    this.installing = false;
    if (this.delayTimer) this.scheduler.clearTimeout(this.delayTimer);
    if (this.intervalTimer) this.scheduler.clearInterval(this.intervalTimer);
    this.delayTimer = undefined;
    this.intervalTimer = undefined;
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateSnapshot> {
    if (this.snapshotValue.state === 'preparing' || this.snapshotValue.state === 'waiting' || this.snapshotValue.state === 'installing') {
      return this.snapshot();
    }
    this.settings.saveUpdateChannel(channel);
    this.candidate = undefined;
    this.installIntent = false;
    this.launched = false;
    this.clearPendingTimer();
    this.cleanupPrepared();
    const capability = this.installationCapability();
    this.setSnapshot({
      channel,
      state: 'idle',
      currentVersion: this.currentVersion,
      installSupported: capability.installSupported,
      ...(capability.reason !== undefined ? { installReason: capability.reason } : {}),
    });
    return this.check(true);
  }

  async check(manual = true): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck(manual);
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = undefined;
    }
  }

  private async performCheck(manual: boolean): Promise<UpdateSnapshot> {
    if (this.installIntent && this.prepared) return this.snapshot();
    if (this.snapshotValue.state === 'preparing' || this.snapshotValue.state === 'waiting' || this.snapshotValue.state === 'installing') {
      return this.snapshot();
    }
    const previous = this.snapshot();
    // Re-probe on every check: a repaired installation becomes installable
    // here without a Desktop restart.
    const capability = this.installationCapability();
    const support = {
      installSupported: capability.installSupported,
      ...(capability.reason !== undefined ? { installReason: capability.reason } : {}),
    };
    this.setSnapshot({ ...previous, state: 'checking', message: undefined, ...support });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      if (this.target === null) throw new Error('unsupported target');
      const manifest = await this.releaseManifest(controller.signal);
      const selection = selectUpdateCandidate(
        manifest ? [manifest] : [],
        this.currentVersion,
        this.snapshotValue.channel,
        this.target,
      );
      this.candidate = selection.candidate;
      const checkedAt = this.now();
      if (selection.candidate) {
        this.setSnapshot({
          channel: this.snapshotValue.channel,
          state: 'available',
          currentVersion: this.currentVersion,
          availableVersion: selection.candidate.version,
          checkedAt,
          ...support,
        });
      } else {
        this.setSnapshot({
          channel: this.snapshotValue.channel,
          state: !selection.hasChannelRelease && this.snapshotValue.channel === 'stable'
            ? 'stable-unavailable'
            : 'up-to-date',
          currentVersion: this.currentVersion,
          checkedAt,
          ...support,
        });
      }
    } catch {
      if (manual) {
        this.setSnapshot({
          ...previous,
          state: 'check-failed',
          checkedAt: this.now(),
          message: '暂时无法检查更新，请检查网络连接后重试。',
          ...support,
        });
      } else {
        this.setSnapshot({ ...previous, ...support });
      }
    } finally {
      clearTimeout(timeout);
    }
    return this.snapshot();
  }

  /**
   * Exactly one metadata fetch per channel, cached hourly. A 404 means the
   * channel simply has no published release yet (`null`); any other failure is
   * surfaced as an error so a manual check can fail closed.
   */
  private async releaseManifest(signal: AbortSignal): Promise<UpdateManifest | null> {
    const channel = this.snapshotValue.channel;
    const cached = this.releaseCache;
    if (cached && cached.channel === channel && this.now() - cached.fetchedAt < CHECK_INTERVAL_MS) {
      return cached.manifest;
    }
    const response = await this.fetcher(`${this.updateBaseUrl}/${channel}.json`, {
      headers: { 'User-Agent': 'wrenyard-desktop-updater' },
      signal,
    });
    let manifest: UpdateManifest | null;
    if (response.status === 404 && channel === 'stable') {
      manifest = null;
    } else {
      if (!response.ok) throw new Error('update metadata request failed');
      let payload: unknown;
      try {
        payload = await response.json() as unknown;
      } catch {
        throw new Error('invalid update metadata response');
      }
      manifest = parseUpdateManifest(payload, channel, this.repository);
    }
    this.releaseCache = { fetchedAt: this.now(), channel, manifest };
    return manifest;
  }

  async requestInstall(onInstall?: () => void): Promise<UpdateSnapshot> {
    this.installIntent = true;
    this.clearPendingTimer();
    return this.advanceInstall(onInstall ?? this.onInstall);
  }

  /**
   * Drives a single authorized install: download+verify+stage (once, even while
   * busy), then install only once the runtime is genuinely idle. Busy never
   * blocks preparation or interrupts work; it only defers the launch into a
   * distinct waiting-for-idle state.
   */
  private async advanceInstall(onInstall: () => void): Promise<UpdateSnapshot> {
    if (!this.installIntent || this.launched) return this.snapshot();
    // Re-probe before authorizing an install: an installation repaired after
    // startup installs here, and a broken one fails closed with a precise
    // reason instead of the earlier startup verdict.
    this.refreshInstallability();
    if (!this.snapshotValue.installSupported) {
      this.installIntent = false;
      this.cleanupPrepared();
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-failed',
        message: installUnavailableMessage(this.snapshotValue.installReason),
      });
      return this.snapshot();
    }
    if (!this.prepared) {
      if (!this.candidate) await this.check(true);
      if (!this.candidate) {
        this.installIntent = false;
        return this.snapshot();
      }
      this.beginAttempt(this.candidate.version);
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'preparing',
        stage: 'download',
        progress: 10,
        activeTaskCount: undefined,
        message: '正在下载并校验更新…',
      });
      try {
        this.prepared = await this.prepareCandidate(this.candidate);
      } catch (error) {
        this.settleAttempt('failed', prepareFailurePhase(error), error);
        this.installIntent = false;
        this.cleanupPrepared();
        this.setSnapshot({
          ...this.snapshotValue,
          state: 'install-failed',
          message: preparationFailureMessage(error),
        });
        return this.snapshot();
      }
    }
    const activeTaskCount = await this.readActiveTaskCount();
    if (activeTaskCount === null || activeTaskCount > 0) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'waiting',
        stage: 'waiting',
        progress: 85,
        ...(activeTaskCount === null ? { activeTaskCount: undefined } : { activeTaskCount }),
        availableVersion: this.prepared.candidate.version,
        message: activeTaskCount === null
          ? '暂时无法确认活跃任务数，将在状态可确认后自动安装。'
          : `正在等待 ${activeTaskCount} 个活跃任务完成。`,
      });
      this.scheduleIdleCheck();
      return this.snapshot();
    }
    if (this.installing) return this.snapshot();
    this.installing = true;
    this.clearPendingTimer();
    try {
      const launched = await this.launchPreparedUpdate();
      if (launched) {
        this.launched = true;
        this.setSnapshot({
          ...this.snapshotValue,
          state: 'installing',
          stage: 'daemon-upgrade',
          progress: 90,
          activeTaskCount: 0,
          availableVersion: this.prepared.candidate.version,
          message: '正在替换 Desktop 并升级 Daemon，完成后会自动重启。',
        });
        this.clearPendingTimer();
        onInstall();
      } else {
        const retryCount = await this.readActiveTaskCount();
        if (retryCount === 0) {
          this.installIntent = false;
          return this.snapshot();
        }
        this.setSnapshot({
          ...this.snapshotValue,
          state: 'waiting',
          stage: 'waiting',
          progress: 85,
          ...(retryCount === null ? { activeTaskCount: undefined } : { activeTaskCount: retryCount }),
          availableVersion: this.prepared.candidate.version,
          message: retryCount === null
            ? '暂时无法确认活跃任务数，将在状态可确认后自动安装。'
            : `正在等待 ${retryCount} 个活跃任务完成。`,
        });
        this.scheduleIdleCheck();
      }
    } finally {
      this.installing = false;
    }
    return this.snapshot();
  }

  cancelPendingInstall(): UpdateSnapshot {
    this.installIntent = false;
    this.launched = false;
    this.installing = false;
    this.settleAttempt('cancelled', 'waiting');
    this.clearPendingTimer();
    const version = this.prepared?.candidate.version;
    this.setSnapshot({
      ...this.snapshotValue,
      state: version ? 'available' : (this.candidate ? 'available' : this.snapshotValue.state),
      ...(version ? { availableVersion: version } : {}),
    });
    return this.snapshot();
  }

  /** Triggered by main when the runtime becomes idle. */
  wake(): void {
    if (!this.installIntent || this.launched) return;
    if (this.snapshotValue.state === 'waiting' || this.snapshotValue.state === 'install-blocked') {
      void this.advanceInstall(this.onInstall);
    }
  }

  private scheduleIdleCheck(): void {
    this.clearPendingTimer();
    this.pendingTimer = this.scheduler.setTimeout(() => {
      this.pendingTimer = undefined;
      void this.advanceInstall(this.onInstall);
    }, CHECK_IDLE_RETRY_MS);
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) {
      this.scheduler.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }

  async launchPreparedUpdate(): Promise<boolean> {
    // A direct launch re-probes as well: the safety property is that no launch
    // ever happens without a currently-resolvable CLI/runtime pair.
    this.refreshInstallability();
    if (!this.prepared || !this.helperPath || !this.helperRuntimePath || !this.cliPath) return false;
    const activeTaskCount = await this.readActiveTaskCount();
    if (activeTaskCount === null || activeTaskCount > 0) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-blocked',
        stage: 'waiting',
        progress: 85,
        ...(activeTaskCount === null ? { activeTaskCount: undefined } : { activeTaskCount }),
        message: activeTaskCount === null
          ? '无法确认活跃任务数，已安全暂停安装。'
          : `正在等待 ${activeTaskCount} 个活跃任务完成。`,
      });
      return false;
    }
    try {
      mkdirSync(this.userDataPath, { recursive: true });
      rmSync(this.resultPath, { force: true });
      this.markAttemptPhase('launch-helper');
      const configPath = join(this.prepared.cleanupRoots[0], 'helper-config.json');
      const helperCopy = join(this.prepared.cleanupRoots[0], 'update-helper.cjs');
      copyFileSync(this.helperPath, helperCopy);
      const config: UpdateHelperConfig = {
        schema: 'wrenyard.desktop-update-helper.v1',
        platform: this.platform === 'win32' ? 'win32' : 'darwin',
        parentPid: process.pid,
        version: this.prepared.candidate.version,
        stagedDesktop: this.prepared.stagedDesktop,
        destinationDesktop: this.desktopPath,
        cliPath: this.cliPath,
        userDataPath: this.userDataPath,
        resultPath: this.resultPath,
        cleanupRoots: this.prepared.cleanupRoots,
      };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.spawnDetached(this.helperRuntimePath, [helperCopy, configPath], {
        env: { ...process.env },
      });
      return true;
    } catch (error) {
      this.settleAttempt('failed', 'launch-helper', error);
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-failed',
        message: '暂时无法启动安装，更新仍已保留，可稍后重试。',
      });
      return false;
    }
  }

  private async prepareDesktop(candidate: UpdateCandidate): Promise<PreparedUpdate> {
    mkdirSync(this.userDataPath, { recursive: true });
    const destinationParent = dirname(this.desktopPath);
    mkdirSync(destinationParent, { recursive: true });
    const workRoot = mkdtempSync(join(this.userDataPath, '.wrenyard-update-'));
    const stageRoot = mkdtempSync(join(destinationParent, '.wrenyard-desktop-update-'));
    const archive = join(workRoot, basename(new URL(candidate.desktopUrl).pathname) || 'desktop.zip');
    const extractRoot = join(workRoot, 'extract');
    const stagedDesktop = join(stageRoot, this.platform === 'win32' ? WINDOWS_APP_DIR : MAC_APP_NAME);
    try {
      const response = await this.fetcher(candidate.desktopUrl, {
        headers: { 'User-Agent': 'wrenyard-desktop-updater' },
      });
      if (!response.ok || !response.body) throw new Error('desktop download failed');
      const expectedBytes = Number(response.headers.get('content-length'));
      let downloadedBytes = 0;
      let reportedProgress = 10;
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          downloadedBytes += chunk.length;
          if (Number.isFinite(expectedBytes) && expectedBytes > 0) {
            const next = Math.min(55, 10 + Math.floor((downloadedBytes / expectedBytes) * 45));
            if (next > reportedProgress) {
              reportedProgress = next;
              this.setSnapshot({ ...this.snapshotValue, stage: 'download', progress: next });
            }
          }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), progress, createWriteStream(archive, { mode: 0o600 }));
      this.setSnapshot({ ...this.snapshotValue, stage: 'download', progress: 58, message: '正在校验更新包…' });
      if (await sha256(archive) !== candidate.desktopSha256) throw new Error('desktop checksum mismatch');
      this.setSnapshot({ ...this.snapshotValue, stage: 'extract', progress: 62, message: '正在解压更新包…' });
      mkdirSync(extractRoot, { recursive: true });
      const extracted = this.platform === 'win32'
        ? await this.commandRunner(this.windowsTarPath, [
          '-x',
          '--no-same-owner',
          '--no-same-permissions',
          '-f', archive,
          '-C', extractRoot,
        ], { windowsHide: true })
        : await this.commandRunner('/usr/bin/ditto', ['-x', '-k', archive, extractRoot]);
      if (extracted.status !== 0) {
        const detail = sanitizeNativeCommandDetail(extracted.stderr || extracted.stdout);
        throw new Error(
          `Windows system tar extraction failed (exit ${extracted.status ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        );
      }
      this.setSnapshot({ ...this.snapshotValue, stage: 'extract', progress: 78, message: '正在验证解压内容…' });
      if (this.platform === 'win32') {
        const executables = findNamedFiles(extractRoot, WINDOWS_EXE_NAME);
        if (executables.length !== 1) throw new Error('desktop archive must contain one executable');
        cpSync(dirname(executables[0]!), stagedDesktop, { recursive: true, force: true, verbatimSymlinks: true });
        const stagedExecutable = join(stagedDesktop, WINDOWS_EXE_NAME);
        if (!existsSync(stagedExecutable) || statSync(stagedExecutable).size <= 0) {
          throw new Error('desktop staging failed');
        }
      } else {
        const apps = findAppBundles(extractRoot);
        if (apps.length !== 1) throw new Error('desktop archive must contain one app');
        if (readBundleVersion(apps[0]!) !== candidate.version) throw new Error('desktop version mismatch');
        const signature = await this.commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', apps[0]!]);
        if (signature.status !== 0) throw new Error('desktop signature invalid');
        const staged = await this.commandRunner('/usr/bin/ditto', [apps[0]!, stagedDesktop]);
        if (staged.status !== 0 || !existsSync(stagedDesktop) || !statSync(stagedDesktop).isDirectory()) {
          throw new Error('desktop staging failed');
        }
        const stagedSignature = await this.commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedDesktop]);
        if (stagedSignature.status !== 0) throw new Error('staged desktop signature invalid');
      }
      return { candidate, stagedDesktop, cleanupRoots: [workRoot, stageRoot] };
    } catch (error) {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(stageRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private consumeHelperResult(): void {
    if (!existsSync(this.resultPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.resultPath, 'utf8')) as UpdateResultDocument;
      if (parsed.status === 'success' && typeof parsed.version === 'string') {
        this.snapshotValue = {
          ...this.snapshotValue,
          state: 'up-to-date',
          checkedAt: this.now(),
          message: `已更新到 v${parsed.version}。`,
        };
      } else if (parsed.status === 'failed') {
        const helperMessage = sanitizeHelperResultMessage(parsed.message);
        this.snapshotValue = {
          ...this.snapshotValue,
          state: 'install-failed',
          message: helperMessage ?? '更新未完成，已恢复到当前版本，你的工作环境未受影响。',
        };
      }
    } catch {
      // Ignore malformed local result files and proceed with a normal check.
    } finally {
      rmSync(this.resultPath, { force: true });
    }
  }

  private cleanupPrepared(): void {
    if (!this.prepared) return;
    for (const root of this.prepared.cleanupRoots) rmSync(root, { recursive: true, force: true });
    this.prepared = undefined;
  }

  private async readActiveTaskCount(): Promise<number | null> {
    try {
      const count = await this.activeTaskCount();
      return count !== null && Number.isInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
  }

  private setSnapshot(snapshot: UpdateSnapshot): void {
    this.snapshotValue = { ...snapshot };
    this.onChanged(this.snapshot());
  }
}

export function resolveWindowsSystemTarPath(systemRoot: string | undefined): string {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows';
  return win32.join(root, 'System32', 'tar.exe');
}

export function activeTaskCountFromDaemonStatus(status: unknown, additionalCount = 0): number | null {
  if (!Number.isSafeInteger(additionalCount) || additionalCount < 0
    || !status || typeof status !== 'object' || Array.isArray(status)) return null;
  const value = status as Record<string, unknown>;
  const counts = [value.activeTaskCount, value.activeWorkflowCount, value.activeExecutionCount];
  if (value.ok !== true || value.mode !== 'accepting' || value.frozen !== false
    || value.recovery_required !== false
    || counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) {
    return null;
  }
  const activeTaskCount = additionalCount + (value.activeTaskCount as number);
  if (activeTaskCount > 0) return activeTaskCount;
  return value.activeWorkflowCount === 0 && value.activeExecutionCount === 0 ? 0 : null;
}

function sanitizeNativeCommandDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\b(?:authorization|password|secret|token)\s*[:=]\s*\S+/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
}

/** Human-readable explanation keyed to the same reason code every surface shows. */
export function installUnavailableMessage(reason: UpdateInstallReason | undefined): string {
  switch (reason) {
    case 'missing-cli':
      return '未找到 Wrenyard CLI，无法应用内安装。请先安装或修复啾啾工坊套件，然后重试。';
    case 'missing-runtime':
      return '未找到与当前 CLI 配套的 Node 运行时，无法应用内安装。请修复套件安装后重试。';
    case 'missing-helper':
      return '未找到更新助手组件，无法应用内安装。请重新安装 Desktop 后重试。';
    case 'unsupported-platform':
      return '当前平台暂不支持应用内安装，请从发布页下载安装包。';
    default:
      return '当前无法应用内安装，请检查本机安装后重试。';
  }
}

/**
 * The failing preparation step, keyed to the exact errors preparation raises.
 * The user-facing message stays deliberately generic, so this is the only place
 * that says whether the download, the checksum, extraction or staging failed.
 */
function prepareFailurePhase(error: unknown): UpdateAttemptPhase {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('download failed')) return 'download';
  if (message.includes('checksum mismatch')) return 'checksum';
  if (message.includes('extraction failed') || message.includes('must contain')) return 'extract';
  if (message.includes('staging failed') || message.includes('signature') || message.includes('version mismatch')) {
    return 'stage';
  }
  return 'prepare';
}

function preparationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const prefix = 'Windows system tar extraction failed';
  if (message.startsWith(prefix)) {
    const detail = sanitizeNativeCommandDetail(message.slice(prefix.length));
    return `系统 tar.exe 解压更新包失败${detail}。当前版本未受影响。`;
  }
  return '更新下载或校验未完成，当前版本未受影响。';
}

function sanitizeHelperResultMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return undefined;
  if (/[\u0000-\u001f\u007f<>]|https?:|[\\/]|\b(?:authorization|password|secret|token)\b/iu.test(value)) {
    return undefined;
  }
  return value;
}
