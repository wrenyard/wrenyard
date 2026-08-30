import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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

const DEFAULT_REPOSITORY = 'wrenyard/wrenyard';
const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 10_000;
const APP_NAME = '啾啾工坊.app';

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
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
  desktopChecksumUrl: string;
  suiteUrl: string;
  suiteChecksumUrl: string;
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

interface PreparedUpdate {
  candidate: UpdateCandidate;
  stagedApp: string;
  cleanupRoots: string[];
}

interface UpdateHelperConfig {
  schema: 'wrenyard.desktop-update-helper.v1';
  parentPid: number;
  version: string;
  stagedApp: string;
  destinationApp: string;
  cliPath: string;
  resultPath: string;
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
  userDataPath: string;
  repository?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  commandRunner?: CommandRunner;
  isBusy?: () => Promise<boolean>;
  onChanged?: (snapshot: UpdateSnapshot) => void;
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
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

function assetUrl(release: GithubRelease, name: string): string | undefined {
  return release.assets.find((asset) => asset.name === name)?.browser_download_url;
}

function releaseCandidate(release: GithubRelease, target: string): UpdateCandidate | null {
  const parsed = parseSemver(release.tag_name);
  if (!parsed) return null;
  const version = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;
  const desktopName = `wrenyard-desktop-${version}-${target}.zip`;
  const suiteName = `wrenyard-${version}-${target}-suite.zip`;
  const desktopUrl = assetUrl(release, desktopName);
  const desktopChecksumUrl = assetUrl(release, `${desktopName}.sha256`);
  const suiteUrl = assetUrl(release, suiteName);
  const suiteChecksumUrl = assetUrl(release, `${suiteName}.sha256`);
  if (!desktopUrl || !desktopChecksumUrl || !suiteUrl || !suiteChecksumUrl) return null;
  return { version, desktopUrl, desktopChecksumUrl, suiteUrl, suiteChecksumUrl };
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

export function parseChecksum(text: string): string {
  const tokens = text.trim().split(/\s+/u);
  const checksum = tokens[0]?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error('invalid checksum');
  return checksum;
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
  private readonly target: string | null;
  private readonly resultPath: string;
  private snapshotValue: UpdateSnapshot;
  private candidate?: UpdateCandidate;
  private prepared?: PreparedUpdate;
  private delayTimer?: unknown;
  private intervalTimer?: unknown;

  constructor(options: DesktopUpdateControllerOptions) {
    this.currentVersion = options.currentVersion;
    this.settings = options.settings;
    this.cliPath = options.cliPath;
    this.helperPath = options.helperPath;
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
    this.target = releaseTarget(this.platform, this.arch);
    this.resultPath = join(this.userDataPath, 'update-result.json');
    const fallback: UpdateChannel = parseSemver(this.currentVersion)?.prerelease.length ? 'dev' : 'stable';
    this.snapshotValue = {
      channel: this.settings.loadUpdateChannel(fallback),
      state: 'idle',
      currentVersion: this.currentVersion,
      installSupported: this.platform === 'darwin' && this.target !== null
        && Boolean(this.cliPath && this.helperPath),
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
    if (this.delayTimer) this.scheduler.clearTimeout(this.delayTimer);
    if (this.intervalTimer) this.scheduler.clearInterval(this.intervalTimer);
    this.delayTimer = undefined;
    this.intervalTimer = undefined;
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateSnapshot> {
    if (this.snapshotValue.state === 'preparing' || this.snapshotValue.state === 'restart-required') {
      return this.snapshot();
    }
    this.settings.saveUpdateChannel(channel);
    this.candidate = undefined;
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
    if (this.snapshotValue.state === 'preparing' || this.snapshotValue.state === 'restart-required') {
      return this.snapshot();
    }
    const previous = this.snapshot();
    this.setSnapshot({ ...previous, state: 'checking', message: undefined });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      if (this.target === null) throw new Error('unsupported target');
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      const response = await this.fetcher(
        `https://api.github.com/repos/${this.repository}/releases?per_page=100`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'wrenyard-desktop-updater',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error('release check failed');
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error('invalid release response');
      const selection = selectUpdateCandidate(
        payload as GithubRelease[],
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

  async prepareUpdate(): Promise<UpdateSnapshot> {
    if (!this.snapshotValue.installSupported) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-failed',
        message: '当前平台暂不支持应用内安装，请从发布页下载安装包。',
      });
      return this.snapshot();
    }
    if (await this.isBusy()) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-blocked',
        message: '当前仍有任务运行，请完成或停止后再安装更新。',
      });
      return this.snapshot();
    }
    if (this.prepared) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'restart-required',
        availableVersion: this.prepared.candidate.version,
        message: '更新已就绪，重启啾啾工坊后完成安装。',
      });
      return this.snapshot();
    }
    if (!this.candidate) return this.check(true);
    this.setSnapshot({
      ...this.snapshotValue,
      state: 'preparing',
      message: '正在下载并校验更新…',
    });
    try {
      this.prepared = await this.prepareMacDesktop(this.candidate);
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'restart-required',
        availableVersion: this.candidate.version,
        message: '更新已就绪，重启啾啾工坊后完成安装。',
      });
    } catch {
      this.cleanupPrepared();
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'install-failed',
        message: '更新下载或校验未完成，当前版本未受影响。',
      });
    }
    return this.snapshot();
  }

  async launchPreparedUpdate(): Promise<boolean> {
    if (!this.prepared || !this.helperPath || !this.cliPath) return false;
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
      const config: UpdateHelperConfig = {
        schema: 'wrenyard.desktop-update-helper.v1',
        parentPid: process.pid,
        version: this.prepared.candidate.version,
        stagedApp: this.prepared.stagedApp,
        destinationApp: join(this.homePath, 'Applications', APP_NAME),
        cliPath: this.cliPath,
        resultPath: this.resultPath,
        cleanupRoots: this.prepared.cleanupRoots,
      };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.spawnDetached(process.execPath, [this.helperPath, configPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

  private async prepareMacDesktop(candidate: UpdateCandidate): Promise<PreparedUpdate> {
    const updateRoot = join(this.homePath, '.wrenyard-updates');
    const applications = join(this.homePath, 'Applications');
    mkdirSync(updateRoot, { recursive: true });
    mkdirSync(applications, { recursive: true });
    const workRoot = mkdtempSync(join(updateRoot, 'desktop-'));
    const stageRoot = mkdtempSync(join(applications, '.wrenyard-desktop-update-'));
    const archive = join(workRoot, basename(new URL(candidate.desktopUrl).pathname) || 'desktop.zip');
    const extractRoot = join(workRoot, 'extract');
    const stagedApp = join(stageRoot, APP_NAME);
    try {
      const checksumResponse = await this.fetcher(candidate.desktopChecksumUrl, {
        headers: { 'User-Agent': 'wrenyard-desktop-updater' },
      });
      if (!checksumResponse.ok) throw new Error('checksum download failed');
      const expected = parseChecksum(await checksumResponse.text());
      const response = await this.fetcher(candidate.desktopUrl, {
        headers: { 'User-Agent': 'wrenyard-desktop-updater' },
      });
      if (!response.ok || !response.body) throw new Error('desktop download failed');
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive, { mode: 0o600 }));
      if (await sha256(archive) !== expected) throw new Error('desktop checksum mismatch');
      mkdirSync(extractRoot, { recursive: true });
      const extracted = await this.commandRunner('/usr/bin/ditto', ['-x', '-k', archive, extractRoot]);
      if (extracted.status !== 0) throw new Error('desktop extraction failed');
      const apps = findAppBundles(extractRoot);
      if (apps.length !== 1) throw new Error('desktop archive must contain one app');
      if (readBundleVersion(apps[0]) !== candidate.version) throw new Error('desktop version mismatch');
      const signature = await this.commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', apps[0]]);
      if (signature.status !== 0) throw new Error('desktop signature invalid');
      const staged = await this.commandRunner('/usr/bin/ditto', [apps[0], stagedApp]);
      if (staged.status !== 0 || !existsSync(stagedApp) || !statSync(stagedApp).isDirectory()) {
        throw new Error('desktop staging failed');
      }
      const stagedSignature = await this.commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
      if (stagedSignature.status !== 0) throw new Error('staged desktop signature invalid');
      return { candidate, stagedApp, cleanupRoots: [workRoot, stageRoot] };
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
