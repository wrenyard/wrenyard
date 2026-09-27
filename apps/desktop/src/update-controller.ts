import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  channelDocumentUrl, channelForVersion, compareVersions, parseUpdateFeedJson,
  resolveUpdateBaseUrl, type PlatformTriplet,
} from '@wrenyard/protocol/update-feed';
import type { UpdateInstallReason, UpdateSnapshot } from './shell-contract.js';
import type { InstallationDiscovery } from './installation-discovery.js';

// Desktop only checks and prompts; the installed SEA engine performs the install.
const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 10_000;
const WAIT_RETRY_MS = 60_000;
const RESULT_FILENAME = 'update-result.json';
const LOG_FILENAME = 'update.log';
// Describes the current Desktop/development process; the engine is a fresh SEA.
// WRENYARD_UPDATE_BASE_URL is preserved so a custom feed still reaches it.
const SCRUBBED_ENV_KEYS = [
  'WRENYARD_ROOT', 'WRENYARD_CLI', 'WRENYARD_NODE_BIN', 'WRENYARD_SOURCE_DEV',
  'WRENYARD_DEV_SUPERVISED', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD',
] as const;

export interface UpdateScheduler {
  setTimeout(handler: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, interval: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DesktopUpdateControllerOptions {
  currentVersion: string;
  userDataPath: string;
  /** Re-resolve the installed suite; called on every check and install. */
  probeInstallation?: () => InstallationDiscovery;
  updateBaseUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  /** Reads `daemon.status.idle`; `null` means "not confirmed" and defers install. */
  readDaemonIdle?: () => Promise<boolean | null>;
  onChanged?: (snapshot: UpdateSnapshot) => void;
  /** Runs after the engine is launched; Desktop quits here. */
  onInstall?: () => void;
  spawnDetached?: (command: string, args: string[], options: SpawnOptions) => void;
  now?: () => number;
  scheduler?: UpdateScheduler;
  /** Source-development (`pnpm dev`) disables release polling and install. */
  sourceDevelopment?: boolean;
}

const defaultUpdateScheduler: UpdateScheduler = {
  setTimeout(handler, delay) { const handle = setTimeout(handler, delay); handle.unref?.(); return handle; },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  setInterval(handler, interval) { const handle = setInterval(handler, interval); handle.unref?.(); return handle; },
  clearInterval(handle) { clearInterval(handle as ReturnType<typeof setInterval>); },
};

type InstallCapability = { installSupported: true } | { installSupported: false; reason: UpdateInstallReason };

const UNAVAILABLE_MESSAGES: Record<UpdateInstallReason, string> = {
  'missing-cli': '未找到已安装的 Wrenyard CLI，无法应用内更新。请先安装或修复啾啾工坊套件，然后重试。',
  'missing-runtime': '未找到与当前 CLI 配套的 Node 运行时，无法应用内更新。请修复套件安装后重试。',
  'unsupported-platform': '当前平台暂不支持应用内更新，请从发布页下载安装包。',
  'source-development': '当前为源码开发模式，不会检查或安装发行版更新。停止 `pnpm dev` 后可再使用已安装的啾啾工坊。',
};

/** Human-readable explanation keyed to the same reason code every surface shows. */
export function installUnavailableMessage(reason: UpdateInstallReason | undefined): string {
  return (reason && UNAVAILABLE_MESSAGES[reason]) || '当前无法应用内更新，请检查本机安装后重试。';
}

export function releaseTarget(platform: NodeJS.Platform, arch: string): PlatformTriplet | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

// Suite root is `<prefix>/versions/<v>`; the engine's cwd must be the prefix
// itself, since both the app bundle and the old version directory get renamed.
function resolveInstallPrefix(suiteRoot: string): string {
  const versionsDir = dirname(suiteRoot);
  return basename(versionsDir) === 'versions' ? dirname(versionsDir) : versionsDir;
}

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

function defaultSpawnDetached(command: string, args: string[], options: SpawnOptions): void {
  spawn(command, args, options).unref();
}

/** Durable result text is engine-owned; only a plain sentence is ever shown. */
function sanitizeResultMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return undefined;
  if (/[\u0000-\u001f\u007f<>]|https?:|[\\/]|\b(?:authorization|password|secret|token)\b/iu.test(value)) return undefined;
  return value;
}

type SnapshotSeed = Omit<UpdateSnapshot, 'installSupported' | 'installReason'>;

function withCapability(snapshot: SnapshotSeed, capability: InstallCapability): UpdateSnapshot {
  const next: UpdateSnapshot = { ...snapshot, installSupported: capability.installSupported };
  if (capability.installSupported) delete next.installReason;
  else next.installReason = capability.reason;
  return next;
}

export class DesktopUpdateController {
  private readonly currentVersion: string;
  private readonly userDataPath: string;
  private readonly probeInstallation?: () => InstallationDiscovery;
  private readonly updateBaseUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetcher: typeof fetch;
  private readonly readDaemonIdle: () => Promise<boolean | null>;
  private readonly onChanged: (snapshot: UpdateSnapshot) => void;
  private readonly onInstall: () => void;
  private readonly spawnDetached: (command: string, args: string[], options: SpawnOptions) => void;
  private readonly now: () => number;
  private readonly scheduler: UpdateScheduler;
  private readonly sourceDevelopment: boolean;
  private readonly target: PlatformTriplet | null;
  private readonly resultPath: string;
  private snapshotValue: UpdateSnapshot;
  private cliExecutable?: string;
  private prefix?: string;
  private checkPromise?: Promise<UpdateSnapshot>;
  private installing = false;
  private delayTimer?: unknown;
  private intervalTimer?: unknown;
  private waitTimer?: unknown;

  constructor(options: DesktopUpdateControllerOptions) {
    this.currentVersion = options.currentVersion;
    this.userDataPath = options.userDataPath;
    this.probeInstallation = options.probeInstallation;
    this.updateBaseUrl = (options.updateBaseUrl ?? resolveUpdateBaseUrl(process.env)).replace(/\/+$/u, '');
    this.platform = options.platform ?? process.platform;
    this.fetcher = options.fetcher ?? fetch;
    this.readDaemonIdle = options.readDaemonIdle ?? (async () => null);
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onInstall = options.onInstall ?? (() => undefined);
    this.spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultUpdateScheduler;
    this.sourceDevelopment = options.sourceDevelopment === true;
    this.target = releaseTarget(this.platform, options.arch ?? process.arch);
    this.resultPath = join(this.userDataPath, RESULT_FILENAME);
    const capability = this.installationCapability();
    this.snapshotValue = withCapability({
      state: 'idle',
      currentVersion: this.currentVersion,
      ...(this.sourceDevelopment ? { message: installUnavailableMessage('source-development') } : {}),
    }, capability);
    this.consumeResult();
  }
  snapshot(): UpdateSnapshot { return { ...this.snapshotValue }; }
  start(): void {
    if (this.sourceDevelopment || this.delayTimer || this.intervalTimer) return;
    this.delayTimer = this.scheduler.setTimeout(() => {
      this.delayTimer = undefined;
      void this.check(false);
      this.intervalTimer = this.scheduler.setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.delayTimer) this.scheduler.clearTimeout(this.delayTimer);
    if (this.intervalTimer) this.scheduler.clearInterval(this.intervalTimer);
    this.clearWaitTimer();
    this.delayTimer = undefined; this.intervalTimer = undefined; this.installing = false;
  }

  async check(manual = true): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck(manual);
    try { return await this.checkPromise; } finally { this.checkPromise = undefined; }
  }
  private async performCheck(manual: boolean): Promise<UpdateSnapshot> {
    if (this.sourceDevelopment) {
      this.setSnapshot({
        state: 'idle', currentVersion: this.currentVersion, installSupported: false,
        installReason: 'source-development', checkedAt: this.now(),
        message: installUnavailableMessage('source-development'),
      });
      return this.snapshot();
    }
    if (this.snapshotValue.state === 'checking' || this.snapshotValue.state === 'installing') return this.snapshot();
    // A durable engine result stays visible until the user acts on it.
    if (!manual && this.snapshotValue.state === 'error' && this.snapshotValue.message !== undefined) {
      this.refreshInstallability();
      return this.snapshot();
    }
    const previous = this.snapshotValue;
    const capability = this.installationCapability();
    this.setSnapshot(withCapability({ state: 'checking', currentVersion: this.currentVersion }, capability));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const target = this.target;
      if (target === null) throw new Error('unsupported target');
      const response = await this.fetcher(
        channelDocumentUrl(this.updateBaseUrl, channelForVersion(this.currentVersion)),
        { headers: { 'User-Agent': 'wrenyard-desktop-updater' }, signal: controller.signal },
      );
      if (!response.ok) throw new Error('update feed request failed');
      const feed = parseUpdateFeedJson(await response.text(), { triplet: target });
      const newer = compareVersions(feed.version, this.currentVersion) > 0;
      this.setSnapshot(withCapability({
        state: newer ? 'available' : 'up-to-date', currentVersion: this.currentVersion,
        ...(newer ? { availableVersion: feed.version } : {}), checkedAt: this.now(),
      }, capability));
    } catch {
      this.setSnapshot(manual
        ? withCapability({
          state: 'error', currentVersion: this.currentVersion, checkedAt: this.now(),
          message: '暂时无法检查更新，请检查网络连接后重试。',
        }, capability)
        : withCapability(previous, capability));
    } finally {
      clearTimeout(timeout);
    }
    return this.snapshot();
  }
  /** User-confirmed install: gate on an idle daemon, then hand off to the SEA. */
  async requestInstall(onInstall?: () => void): Promise<UpdateSnapshot> {
    this.refreshInstallability();
    if (!this.snapshotValue.installSupported) {
      return this.fail(installUnavailableMessage(this.snapshotValue.installReason));
    }
    return this.attemptInstall(onInstall ?? this.onInstall);
  }
  private async attemptInstall(onInstall: () => void): Promise<UpdateSnapshot> {
    if (this.installing) return this.snapshot();
    if (this.snapshotValue.availableVersion === undefined) {
      await this.check(true);
      if (this.snapshotValue.availableVersion === undefined) return this.snapshot();
    }
    this.refreshInstallability();
    if (!this.snapshotValue.installSupported || this.cliExecutable === undefined || this.prefix === undefined) {
      return this.fail(installUnavailableMessage(this.snapshotValue.installReason));
    }
    let idle: boolean | null = null;
    try { idle = await this.readDaemonIdle(); } catch { idle = null; }
    if (idle !== true) {
      this.setSnapshot({ ...this.snapshotValue, state: 'waiting', message: '有任务运行中，完成后自动更新。' });
      this.scheduleWait();
      return this.snapshot();
    }
    this.installing = true;
    try {
      this.launchEngine(this.snapshotValue.availableVersion!);
    } catch {
      this.installing = false;
      return this.fail('暂时无法启动更新，请重试。');
    }
    this.clearWaitTimer();
    this.setSnapshot({ ...this.snapshotValue, state: 'installing', message: '正在安装更新，完成后会自动重启。' });
    onInstall();
    return this.snapshot();
  }

  // Exact engine invocation: detached SEA, scrubbed env, cwd outside every
  // directory the update renames.
  private launchEngine(version: string): void {
    const logFd = openSync(join(this.userDataPath, LOG_FILENAME), 'a');
    this.spawnDetached(this.cliExecutable!, [
      'update', '--version', version, '--wait-pid', String(process.pid),
      '--relaunch-desktop', '--result-file', this.resultPath,
    ], {
      detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      cwd: this.prefix!, env: scrubbedEnvironment(),
    });
  }
  private scheduleWait(): void {
    this.clearWaitTimer();
    this.waitTimer = this.scheduler.setTimeout(() => {
      this.waitTimer = undefined;
      void this.attemptInstall(this.onInstall);
    }, WAIT_RETRY_MS);
  }
  private clearWaitTimer(): void {
    if (this.waitTimer) { this.scheduler.clearTimeout(this.waitTimer); this.waitTimer = undefined; }
  }

  private fail(message: string): UpdateSnapshot {
    this.setSnapshot({ ...this.snapshotValue, state: 'error', message });
    return this.snapshot();
  }

  // Consume `update-result.json` once: a `failed` or interrupted `in_progress`
  // record is surfaced in the update panel, then marked read by deletion.
  private consumeResult(): void {
    if (!existsSync(this.resultPath)) return;
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.resultPath, 'utf8'));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { parsed = undefined; }
    try { rmSync(this.resultPath, { force: true }); } catch { /* must not block startup */ }
    const status = parsed?.status;
    if (status !== 'failed' && status !== 'in_progress') return;
    this.snapshotValue = {
      ...this.snapshotValue, state: 'error', checkedAt: this.now(),
      message: sanitizeResultMessage(parsed?.message) ?? (status === 'in_progress'
        ? '上次更新被中断，请重试。'
        : '更新未完成，已恢复到当前版本，你的工作环境未受影响。'),
    };
  }

  // Re-resolve the suite and derive the SEA executable. The engine must be
  // `<suiteRoot>/wrenyard[.exe]`, never the Windows `wrenyard.cmd` shim.
  private installationCapability(): InstallCapability {
    if (this.sourceDevelopment) return { installSupported: false, reason: 'source-development' };
    if (this.platform !== 'darwin' && this.platform !== 'win32') return { installSupported: false, reason: 'unsupported-platform' };
    if (this.target === null) return { installSupported: false, reason: 'unsupported-platform' };
    const discovery = this.probeInstallation?.();
    if (!discovery) return { installSupported: false, reason: 'missing-cli' };
    if (discovery.reason !== undefined) return { installSupported: false, reason: discovery.reason };
    if (discovery.runtimePath === undefined) return { installSupported: false, reason: 'missing-runtime' };
    const suiteRoot = dirname(dirname(discovery.runtimePath));
    const executable = join(suiteRoot, this.platform === 'win32' ? 'wrenyard.exe' : 'wrenyard');
    let present = false;
    try { present = statSync(executable).isFile(); } catch { present = false; }
    if (!present) return { installSupported: false, reason: 'missing-cli' };
    this.cliExecutable = executable;
    this.prefix = resolveInstallPrefix(suiteRoot);
    return { installSupported: true };
  }

  /** Re-probe the installation and publish the refreshed capability. */
  private refreshInstallability(): void {
    const capability = this.installationCapability();
    const reason = capability.installSupported ? undefined : capability.reason;
    if (capability.installSupported === this.snapshotValue.installSupported
      && reason === this.snapshotValue.installReason) return;
    this.setSnapshot(withCapability(this.snapshotValue, capability));
  }

  private setSnapshot(snapshot: UpdateSnapshot): void {
    this.snapshotValue = { ...snapshot };
    this.onChanged(this.snapshot());
  }
}
