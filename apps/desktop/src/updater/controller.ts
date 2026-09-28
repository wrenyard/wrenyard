/**
 * Desktop updater state machine.
 *
 * One cross-platform flow: check the feed, wait for an idle daemon, download
 * and verify the update asset, prepare it, stop the daemon when Desktop owns
 * it, record the pending version and hand off to the platform applier. The
 * outcome is decided on the next startup from `update-pending.json`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelDocumentUrl, channelForVersion, compareVersions, parseUpdateFeedJson,
  resolveUpdateBaseUrl, type PlatformTriplet,
} from '@wrenyard/protocol/update-feed';
import type { UpdateInstallReason, UpdateSnapshot } from '../shell-contract.js';
import { createDarwinApplier } from './apply-darwin.js';
import { createWin32Applier } from './apply-win32.js';
import { DigestMismatchError, DownloadTimeoutError, downloadFile, type FetchLike } from './download.js';
import { clearPendingUpdate, readPendingUpdate, writePendingUpdate, type PendingUpdate } from './pending.js';
import type { CommandRunner, PlatformApplier, PreparedUpdate, SpawnDetached, UpdateBlocker } from './types.js';

const CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 10_000;
const WAIT_RETRY_MS = 60_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** A feed asset as resolved by `@wrenyard/protocol/update-feed`. */
interface UpdateAsset {
  name: string;
  url: string;
  sha256: string;
}

/** Timer surface so tests can drive the check/wait cadence deterministically. */
export interface UpdateScheduler {
  setTimeout(handler: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, interval: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DesktopUpdateControllerOptions {
  currentVersion: string;
  userDataPath: string;
  /** Absolute path of the running app bundle / executable. */
  appPath: string;
  /** Whether Desktop owns the daemon (supervised) or merely connected to it. */
  daemonMode?: () => 'supervised' | 'connected';
  /** Stops the Desktop-owned daemon; never called in connected mode. */
  stopDaemon?: () => Promise<void>;
  /** Reads `daemon.status.idle`; `null` means "not confirmed" and defers install. */
  readDaemonIdle?: () => Promise<boolean | null>;
  /**
   * Confirms whether the daemon process is actually running. Lets a confirmed
   * absence (e.g. after `wrenyard daemon stop`) proceed when the idle probe is
   * unreachable in connected Windows mode. Optional; absence keeps deferring.
   */
  isDaemonRunning?: () => Promise<boolean>;
  onChanged?: (snapshot: UpdateSnapshot) => void;
  /** Runs after the applier starts its detached follow-up; Desktop quits here. */
  onInstall?: () => void;
  /** Surfaces a blocking condition; resolves once the user acknowledged it. */
  onBlocker?: (blocker: UpdateBlocker) => Promise<void>;
  /** Source-development (`pnpm dev:desktop`) disables release polling and install. */
  sourceDevelopment?: boolean;
  updateBaseUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: FetchLike;
  scheduler?: UpdateScheduler;
  now?: () => number;
  /** Overrides platform applier selection; used by tests and foreign hosts. */
  applier?: PlatformApplier | null;
  spawnDetached?: SpawnDetached;
  runner?: CommandRunner;
}

const defaultUpdateScheduler: UpdateScheduler = {
  setTimeout(handler, delay) { const handle = setTimeout(handler, delay); handle.unref?.(); return handle; },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  setInterval(handler, interval) { const handle = setInterval(handler, interval); handle.unref?.(); return handle; },
  clearInterval(handle) { clearInterval(handle as ReturnType<typeof setInterval>); },
};

type InstallCapability = { installSupported: true } | { installSupported: false; reason: UpdateInstallReason };

const UNAVAILABLE_MESSAGES: Record<UpdateInstallReason, string> = {
  'unsupported-platform': '当前平台暂不支持应用内更新，请从发布页下载安装包。',
  'missing-cli': '未找到已安装的 Wrenyard CLI，无法应用内更新。',
  'missing-runtime': '未找到与当前安装配套的 Node 运行时，无法应用内更新。',
  'source-development': '当前为源码开发模式，不会检查或安装发行版更新。停止 `pnpm dev:desktop` 后可再使用已安装的啾啾工坊。',
};

/** Human-readable explanation keyed to the reason code every surface shows. */
export function installUnavailableMessage(reason: UpdateInstallReason | undefined): string {
  return (reason && UNAVAILABLE_MESSAGES[reason]) || '当前无法应用内更新，请检查本机安装后重试。';
}

/** Host triplet the release pipeline publishes, or null when unsupported. */
export function releaseTarget(platform: NodeJS.Platform, arch: string): PlatformTriplet | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

function defaultSpawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawn(command, args, options);
  child.once('error', (error) => console.error('[updater] application handoff failed:', error.message));
  if (child.pid === undefined) throw new Error('无法启动更新程序，请手动下载安装包。');
  child.unref();
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
  private readonly updateBaseUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetcher: FetchLike;
  private readonly daemonMode: () => 'supervised' | 'connected';
  private readonly stopDaemon: () => Promise<void>;
  private readonly readDaemonIdle: () => Promise<boolean | null>;
  private readonly isDaemonRunning?: () => Promise<boolean>;
  private readonly onChanged: (snapshot: UpdateSnapshot) => void;
  private readonly onInstall: () => void;
  private readonly onBlocker: (blocker: UpdateBlocker) => Promise<void>;
  private readonly sourceDevelopment: boolean;
  private readonly scheduler: UpdateScheduler;
  private readonly now: () => number;
  private readonly applier: PlatformApplier | null;
  private readonly target: PlatformTriplet | null;
  private snapshotValue: UpdateSnapshot;
  private updateAsset?: UpdateAsset;
  private pendingFinalize: PendingUpdate | null = null;
  private checkPromise?: Promise<UpdateSnapshot>;
  private installing = false;
  private installPromise?: Promise<UpdateSnapshot>;
  private installAbort?: AbortController;
  private installCallback: () => void;
  private delayTimer?: unknown;
  private intervalTimer?: unknown;
  private waitTimer?: unknown;

  constructor(options: DesktopUpdateControllerOptions) {
    this.currentVersion = options.currentVersion;
    this.userDataPath = options.userDataPath;
    this.updateBaseUrl = (options.updateBaseUrl ?? resolveUpdateBaseUrl(process.env)).replace(/\/+$/u, '');
    this.platform = options.platform ?? process.platform;
    this.fetcher = options.fetcher ?? fetch;
    this.daemonMode = options.daemonMode ?? (() => 'connected');
    this.stopDaemon = options.stopDaemon ?? (async () => undefined);
    this.readDaemonIdle = options.readDaemonIdle ?? (async () => null);
    this.isDaemonRunning = options.isDaemonRunning;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onInstall = options.onInstall ?? (() => undefined);
    this.onBlocker = options.onBlocker ?? (async () => undefined);
    this.sourceDevelopment = options.sourceDevelopment === true;
    this.scheduler = options.scheduler ?? defaultUpdateScheduler;
    this.now = options.now ?? Date.now;
    this.installCallback = this.onInstall;
    this.target = releaseTarget(this.platform, options.arch ?? process.arch);
    this.applier = this.resolveApplier(options);

    const capability = this.capability();
    this.snapshotValue = withCapability({
      state: 'idle',
      currentVersion: this.currentVersion,
      ...(this.sourceDevelopment ? { message: installUnavailableMessage('source-development') } : {}),
    }, capability);
    this.consumePending();
  }

  snapshot(): UpdateSnapshot {
    return { ...this.snapshotValue };
  }

  start(): void {
    if (this.sourceDevelopment || this.applier === null || this.delayTimer || this.intervalTimer) return;
    this.delayTimer = this.scheduler.setTimeout(() => {
      this.delayTimer = undefined;
      void this.checkForUpdates(false);
      this.intervalTimer = this.scheduler.setInterval(() => void this.checkForUpdates(false), CHECK_INTERVAL_MS);
    }, CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.delayTimer) this.scheduler.clearTimeout(this.delayTimer);
    if (this.intervalTimer) this.scheduler.clearInterval(this.intervalTimer);
    this.clearWaitTimer();
    this.delayTimer = undefined;
    this.intervalTimer = undefined;
    // Abort any in-flight install instead of resetting `installing`: the
    // operation owns its own state and settles once it observes the abort.
    this.installAbort?.abort();
  }

  async checkForUpdates(manual = true): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck(manual);
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = undefined;
    }
  }

  /**
   * User-confirmed install. Gated on the daemon being idle; a busy daemon moves
   * to the non-blocking `waiting` state and retries every 60 seconds.
   */
  async requestInstall(onInstall?: () => void): Promise<UpdateSnapshot> {
    this.installCallback = onInstall ?? this.onInstall;
    return this.attemptInstall();
  }

  /**
   * Startup preflight. Returns false when a blocker was shown and Desktop must
   * quit instead of continuing.
   */
  async preflightStartup(): Promise<boolean> {
    if (this.sourceDevelopment || this.applier === null) return true;
    let blocker: UpdateBlocker | null;
    try {
      blocker = await this.applier.preflight('startup');
    } catch {
      // Fail closed: an unreadable preflight must never be read as "no blocker".
      blocker = { message: '无法完成启动检查，请从发布页手动下载安装包。' };
    }
    if (blocker === null) return true;
    await this.onBlocker(blocker);
    return false;
  }

  /**
   * Post-update finalization. Called once the new version started healthy and
   * the window loaded; runs the applier's cleanup and clears the pending file.
   */
  async finalizeStartup(): Promise<void> {
    const pending = this.pendingFinalize;
    if (pending === null) return;
    this.pendingFinalize = null;
    try {
      await this.applier?.finalize();
    } catch {
      // Cleanup is best effort; never block startup on it.
    }
    clearPendingUpdate(this.userDataPath);
    if (this.currentVersion === pending.to) {
      this.setSnapshot({
        ...this.snapshotValue,
        state: 'up-to-date',
        currentVersion: this.currentVersion,
        checkedAt: this.now(),
        message: '更新已完成。',
      });
    }
  }

  private resolveApplier(options: DesktopUpdateControllerOptions): PlatformApplier | null {
    if (options.applier !== undefined) return options.applier;
    const spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
    if (this.target === null) return null;
    if (this.platform === 'darwin') {
      return createDarwinApplier({
        appPath: options.appPath,
        spawnDetached,
        ...(options.runner !== undefined ? { runner: options.runner } : {}),
      });
    }
    if (this.platform === 'win32') return createWin32Applier({ spawnDetached });
    return null;
  }

  private capability(): InstallCapability {
    if (this.sourceDevelopment) return { installSupported: false, reason: 'source-development' };
    if (this.applier === null || this.target === null) {
      return { installSupported: false, reason: 'unsupported-platform' };
    }
    return { installSupported: true };
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
    if (
      this.snapshotValue.state === 'checking'
      || this.snapshotValue.state === 'waiting'
      || this.snapshotValue.state === 'installing'
    ) return this.snapshot();
    // A durable result stays visible until the user acts on it.
    if (!manual && this.snapshotValue.state === 'error' && this.snapshotValue.message !== undefined) {
      return this.snapshot();
    }
    const previous = this.snapshotValue;
    const capability = this.capability();
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
      this.updateAsset = newer ? feed.update : undefined;
      this.setSnapshot(withCapability({
        state: newer ? 'available' : 'up-to-date',
        currentVersion: this.currentVersion,
        ...(newer ? { availableVersion: feed.version } : {}),
        checkedAt: this.now(),
      }, capability));
    } catch {
      this.updateAsset = undefined;
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

  /**
   * Serializes install attempts: concurrent clicks or the waiting retry timer
   * all share one in-flight promise, so nothing downloads or applies twice.
   */
  private async attemptInstall(): Promise<UpdateSnapshot> {
    if (this.installPromise !== undefined) return this.installPromise;
    const abort = new AbortController();
    this.installAbort = abort;
    const promise = Promise.resolve()
      .then(() => this.runInstall(abort.signal))
      .finally(() => {
        if (this.installPromise === promise) {
          this.installPromise = undefined;
          this.installAbort = undefined;
        }
      });
    this.installPromise = promise;
    return promise;
  }

  private async runInstall(signal: AbortSignal): Promise<UpdateSnapshot> {
    if (this.installing) return this.snapshot();
    const capability = this.capability();
    if (!capability.installSupported) return this.fail(installUnavailableMessage(capability.reason));
    const applier = this.applier;
    if (applier === null) return this.fail(installUnavailableMessage('unsupported-platform'));

    if (this.snapshotValue.availableVersion === undefined) {
      await this.checkForUpdates(true);
      if (this.snapshotValue.availableVersion === undefined) return this.snapshot();
    }
    const version = this.snapshotValue.availableVersion;
    if (version === undefined || signal.aborted) return this.snapshot();

    // Confirm: the daemon must be idle before anything is downloaded.
    if ((await this.probeIdle()) !== true) return this.enterWaiting();

    // Blocking checks that may require the user to act first.
    let blocker: UpdateBlocker | null;
    try {
      blocker = await applier.preflight('update');
    } catch {
      // Never read a preflight exception as "no blocker".
      return this.fail('无法完成更新前置检查，请重试。');
    }
    if (blocker !== null) {
      await this.onBlocker(blocker);
      this.installCallback();
      return this.snapshot();
    }

    this.installing = true;
    let prepared: PreparedUpdate;
    try {
      this.setSnapshot({ ...this.snapshotValue, state: 'installing', message: '正在下载更新…' });
      const assetPath = await this.downloadUpdate(version, signal);
      this.setSnapshot({ ...this.snapshotValue, state: 'installing', message: '正在准备更新…' });
      prepared = await applier.prepare(assetPath, version);
    } catch (error) {
      this.installing = false;
      if (signal.aborted) return this.snapshot();
      return this.fail(error instanceof Error ? error.message : '更新失败，请重试。');
    }
    if (signal.aborted) {
      this.installing = false;
      return this.snapshot();
    }

    // Re-confirm the daemon is idle right before stopping it.
    if ((await this.probeIdle()) !== true) {
      this.installing = false;
      return this.enterWaiting();
    }
    // Capture the mode before stopping the owned daemon: a stop must not flip
    // this into a connected-mode refusal.
    const daemonMode = this.daemonMode();
    try {
      await this.handOffDaemon(daemonMode);
    } catch (error) {
      this.installing = false;
      return this.fail(error instanceof Error ? error.message : '无法停止 daemon，请重试。');
    }
    if (daemonMode === 'connected' && this.platform === 'win32' && (await this.isDaemonRunning?.()) !== false) {
      // Windows: a daemon Desktop did not start holds node.exe inside the
      // install directory. Surface an error snapshot (never the fatal
      // `onBlocker`, which quits Desktop) so the user can stop it and retry.
      this.installing = false;
      return this.fail('请先停止在终端中运行的 daemon（Ctrl+C 或 wrenyard daemon stop）。');
    }
    if (signal.aborted) {
      this.installing = false;
      return this.snapshot();
    }

    // Record the pending pair, then apply and quit.
    try {
      writePendingUpdate(this.userDataPath, { from: this.currentVersion, to: version });
      applier.apply(prepared);
    } catch (error) {
      clearPendingUpdate(this.userDataPath);
      this.installing = false;
      return this.fail(error instanceof Error ? error.message : '暂时无法应用更新，请重试。');
    }
    this.clearWaitTimer();
    this.setSnapshot({ ...this.snapshotValue, state: 'installing', message: '正在安装更新，完成后会自动重启。' });
    this.installCallback();
    return this.snapshot();
  }

  /** Stops the daemon only in supervised mode; connected macOS leaves it running. */
  private async handOffDaemon(mode: 'supervised' | 'connected'): Promise<void> {
    if (mode === 'supervised') await this.stopDaemon();
  }

  private async downloadUpdate(version: string, signal: AbortSignal): Promise<string> {
    const asset = this.updateAsset;
    if (asset === undefined) throw new Error('没有可用的更新文件，请重新检查更新。');
    const dest = join(this.userDataPath, 'updates', version, asset.name);
    try {
      await downloadFile({
        url: asset.url,
        dest,
        sha256: asset.sha256,
        fetchImpl: this.fetcher,
        idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        signal,
      });
      return dest;
    } catch (error) {
      // Integrity failure: never leave a corrupt download behind.
      try {
        rmSync(dest, { force: true });
      } catch {
        // Best effort.
      }
      if (error instanceof DigestMismatchError) throw new Error('更新文件校验失败，已删除，请重试。');
      if (error instanceof DownloadTimeoutError) throw new Error('下载超时，请检查网络后重试。');
      throw error instanceof Error ? error : new Error('下载更新失败，请重试。');
    }
  }

  private enterWaiting(): UpdateSnapshot {
    this.setSnapshot({ ...this.snapshotValue, state: 'waiting', message: '有任务运行中，完成后自动更新。' });
    this.scheduleWait();
    return this.snapshot();
  }

  private scheduleWait(): void {
    this.clearWaitTimer();
    this.waitTimer = this.scheduler.setTimeout(() => {
      this.waitTimer = undefined;
      void this.attemptInstall();
    }, WAIT_RETRY_MS);
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      this.scheduler.clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
  }

  private async probeIdle(): Promise<boolean | null> {
    try {
      const idle = await this.readDaemonIdle();
      if (idle !== null) return idle;
    } catch {
      // Unconfirmed read; fall through to the running check below.
    }
    // A confirmed-absent daemon cannot block the swap, even when the idle
    // status endpoint is unreachable (e.g. Windows connected mode after the
    // user ran `wrenyard daemon stop`).
    if (this.isDaemonRunning !== undefined) {
      try {
        if (!(await this.isDaemonRunning())) return true;
      } catch {
        // Unknown; defer as before.
      }
    }
    return null;
  }

  private fail(message: string): UpdateSnapshot {
    this.setSnapshot({ ...this.snapshotValue, state: 'error', message });
    return this.snapshot();
  }

  // Decide the last update's outcome from `update-pending.json`.
  private consumePending(): void {
    const pending = readPendingUpdate(this.userDataPath);
    if (pending === null) return;
    if (pending.to === this.currentVersion) {
      // Success: finalize after the daemon is healthy and the window loaded.
      this.pendingFinalize = pending;
      return;
    }
    if (pending.from === this.currentVersion) {
      // Failure: show once, then delete the record.
      this.snapshotValue = {
        ...this.snapshotValue,
        state: 'error',
        checkedAt: this.now(),
        message: '上次更新未完成，请从发布页手动下载安装包并重新安装。',
      };
    }
    clearPendingUpdate(this.userDataPath);
  }

  private setSnapshot(snapshot: UpdateSnapshot): void {
    this.snapshotValue = { ...snapshot };
    this.onChanged(this.snapshot());
  }
}
