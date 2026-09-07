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
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateChannel, UpdateSnapshot } from './shell-contract.js';
import type { UpdateHelperConfig } from './update-helper.js';

const DEFAULT_REPOSITORY = 'wrenyard/wrenyard';
const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_IDLE_RETRY_MS = 60_000;
const MAC_APP_NAME = '啾啾工坊.app';
const WINDOWS_APP_DIR = 'Wrenyard Desktop';
const WINDOWS_EXE_NAME = 'wrenyard-desktop.exe';

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string;
  assets: GithubReleaseAsset[];
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
  desktopPath?: string;
  userDataPath: string;
  repository?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  commandRunner?: CommandRunner;
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
  const match = value.match(/^sha256:([a-f0-9]{64})$/iu);
  if (!match) throw new Error('invalid asset digest');
  return match[1]!.toLowerCase();
}

function releaseAsset(release: GithubRelease, name: string): GithubReleaseAsset | undefined {
  return release.assets.find((asset) => asset.name === name);
}

function releaseCandidate(release: GithubRelease, target: string): UpdateCandidate | null {
  const parsed = parseSemver(release.tag_name);
  if (!parsed) return null;
  const version = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;
  const desktopName = `wrenyard-desktop-${version}-${target}.zip`;
  const suiteName = `wrenyard-${version}-${target}-suite.zip`;
  const desktop = releaseAsset(release, desktopName);
  const suite = releaseAsset(release, suiteName);
  if (!desktop || !suite) return null;
  try {
    return {
      version,
      desktopUrl: desktop.browser_download_url,
      desktopSha256: parseAssetDigest(desktop.digest),
      suiteUrl: suite.browser_download_url,
      suiteSha256: parseAssetDigest(suite.digest),
    };
  } catch {
    return null;
  }
}

export function selectUpdateCandidate(
  releases: GithubRelease[],
  currentVersion: string,
  channel: UpdateChannel,
  target: string,
): CandidateSelection {
  if (!parseSemver(currentVersion)) throw new Error('invalid current version');
  const candidates = releases
    .filter((release) => !release.draft && (channel === 'dev' || !release.prerelease))
    .map((release) => releaseCandidate(release, target))
    .filter((candidate): candidate is UpdateCandidate => candidate !== null)
    .sort((left, right) => compareSemver(right.version, left.version));
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

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function defaultSpawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  child.unref();
}

export class DesktopUpdateController {
  private readonly currentVersion: string;
  private readonly settings: UpdateSettingsStore;
  private readonly cliPath?: string;
  private readonly helperPath?: string;
  private readonly helperRuntimePath?: string;
  private readonly desktopPath: string;
  private readonly userDataPath: string;
  private readonly repository: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher: typeof fetch;
  private readonly commandRunner: CommandRunner;
  private readonly isBusy: () => Promise<boolean>;
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
  private releaseCache?: { fetchedAt: number; releases: GithubRelease[] };
  private checkPromise?: Promise<UpdateSnapshot>;
  private delayTimer?: unknown;
  private intervalTimer?: unknown;

  constructor(options: DesktopUpdateControllerOptions) {
    this.currentVersion = options.currentVersion;
    this.settings = options.settings;
    this.cliPath = options.cliPath;
    this.helperPath = options.helperPath;
    this.helperRuntimePath = options.helperRuntimePath;
    this.userDataPath = options.userDataPath;
    this.repository = options.repository ?? DEFAULT_REPOSITORY;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetcher = options.fetcher ?? fetch;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.isBusy = options.isBusy ?? (async () => false);
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
    this.snapshotValue = {
      channel: this.settings.loadUpdateChannel(fallback),
      state: 'idle',
      currentVersion: this.currentVersion,
      installSupported: (this.platform === 'darwin' || this.platform === 'win32')
        && this.target !== null
        && Boolean(this.cliPath && this.helperPath && this.helperRuntimePath),
    };
    this.consumeHelperResult();
  }

  snapshot(): UpdateSnapshot {
    return { ...this.snapshotValue };
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
    this.setSnapshot({
      channel,
      state: 'idle',
      currentVersion: this.currentVersion,
      installSupported: this.snapshotValue.installSupported,
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
    this.setSnapshot({ ...previous, state: 'checking', message: undefined });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      if (this.target === null) throw new Error('unsupported target');
      const payload = await this.releases(controller.signal);
      const selection = selectUpdateCandidate(
        payload,
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
          installSupported: this.snapshotValue.installSupported,
        });
      } else {
        this.setSnapshot({
          channel: this.snapshotValue.channel,
          state: this.snapshotValue.channel === 'stable' && !selection.hasChannelRelease
            ? 'stable-unavailable'
            : 'up-to-date',
          currentVersion: this.currentVersion,
          checkedAt,
          installSupported: this.snapshotValue.installSupported,
        });
      }
    } catch {
      if (manual) {
        this.setSnapshot({
          ...previous,
          state: 'check-failed',
          checkedAt: this.now(),
          message: '暂时无法检查更新，请检查网络连接后重试。',
        });
      } else {
        this.setSnapshot(previous);
      }
    } finally {
      clearTimeout(timeout);
    }
    return this.snapshot();
  }

  private async releases(signal: AbortSignal): Promise<GithubRelease[]> {
    if (this.releaseCache && this.now() - this.releaseCache.fetchedAt < CHECK_INTERVAL_MS) {
      return this.releaseCache.releases;
    }
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.repository}/releases?per_page=20`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'wrenyard-desktop-updater',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal,
      },
    );
    if (!response.ok) throw new Error('release check failed');
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error('invalid release response');
    const releases = payload as GithubRelease[];
    this.releaseCache = { fetchedAt: this.now(), releases };
    return releases;
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
    if (!this.snapshotValue.installSupported) {
      this.installIntent = false;
      this.cleanupPrepared();
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-failed',
        message: '当前平台暂不支持应用内安装，请从发布页下载安装包。',
      });
      return this.snapshot();
    }
    if (!this.prepared) {
      if (!this.candidate) await this.check(true);
      if (!this.candidate) {
        this.installIntent = false;
        return this.snapshot();
      }
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'preparing',
        message: '正在下载并校验更新…',
      });
      try {
        this.prepared = await this.prepareCandidate(this.candidate);
      } catch {
        this.installIntent = false;
        this.cleanupPrepared();
        this.setSnapshot({
          ...this.snapshotValue,
          state: 'install-failed',
          message: '更新下载或校验未完成，当前版本未受影响。',
        });
        return this.snapshot();
      }
    }
    if (await this.isBusy()) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'waiting',
        availableVersion: this.prepared.candidate.version,
        message: '更新已准备，将在你空闲后自动安装。',
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
          availableVersion: this.prepared.candidate.version,
          message: '正在安装更新，完成后会自动重启。',
        });
        this.clearPendingTimer();
        onInstall();
      } else if (await this.isBusy()) {
        this.setSnapshot({
          ...this.snapshotValue,
          state: 'waiting',
          availableVersion: this.prepared.candidate.version,
          message: '更新已准备，将在你空闲后自动安装。',
        });
        this.scheduleIdleCheck();
      } else {
        this.installIntent = false;
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
    if (!this.prepared || !this.helperPath || !this.helperRuntimePath || !this.cliPath) return false;
    if (await this.isBusy()) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-blocked',
        message: '当前仍有任务运行，请完成或停止后再重启安装。',
      });
      return false;
    }
    try {
      mkdirSync(this.userDataPath, { recursive: true });
      rmSync(this.resultPath, { force: true });
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
    } catch {
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
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      const response = await this.fetcher(candidate.desktopUrl, {
        headers: {
          'User-Agent': 'wrenyard-desktop-updater',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok || !response.body) throw new Error('desktop download failed');
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive, { mode: 0o600 }));
      if (await sha256(archive) !== candidate.desktopSha256) throw new Error('desktop checksum mismatch');
      mkdirSync(extractRoot, { recursive: true });
      const extracted = this.platform === 'win32'
        ? await this.commandRunner('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${powerShellLiteral(archive)} -DestinationPath ${powerShellLiteral(extractRoot)} -Force`,
        ], { windowsHide: true })
        : await this.commandRunner('/usr/bin/ditto', ['-x', '-k', archive, extractRoot]);
      if (extracted.status !== 0) throw new Error('desktop extraction failed');
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
        this.snapshotValue = {
          ...this.snapshotValue,
          state: 'install-failed',
          message: '更新未完成，已恢复到当前版本，你的工作环境未受影响。',
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

  private setSnapshot(snapshot: UpdateSnapshot): void {
    this.snapshotValue = { ...snapshot };
    this.onChanged(this.snapshot());
  }
}

export async function wrenyardIsBusy(cliPath: string | undefined): Promise<boolean> {
  if (!cliPath || !existsSync(cliPath)) return false;
  const result = await defaultCommandRunner(cliPath, ['status', '--json']);
  if (result.status !== 0) return true;
  try {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ['active_task_count', 'active_workflow_count', 'active_execution_count']) {
      if (typeof payload[key] === 'number' && payload[key] > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}
