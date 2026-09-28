/**
 * macOS applier: extract the signed zip next to the running app and swap the
 * bundle in place. electron-updater is unusable here (Squirrel.Mac rejects an
 * ad-hoc signature whose designated requirement changes each build), so the
 * controller hands off to a detached waiter that reopens the new app.
 */

import { accessSync, constants, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  defaultCommandRunner,
  extractZip,
  MACOS_LSREGISTER,
  readBundleVersion,
  verifyCodesign,
} from './download.js';
import type {
  CommandRunner,
  PlatformApplier,
  PreparedUpdate,
  SpawnDetached,
  UpdateBlocker,
} from './types.js';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

export interface DarwinApplierOptions {
  /** Absolute path of the running `.app` bundle. */
  appPath: string;
  spawnDetached: SpawnDetached;
  runner?: CommandRunner;
  pid?: number;
}

/** Blocking delay so the swap stays synchronous before Desktop quits. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename with bounded retries; only the caller decides when a failure is fatal. */
function renameWithRetrySync(from: string, to: string, attempts = RENAME_ATTEMPTS): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE_RENAME_CODES.has(code) || attempt === attempts - 1) throw error;
      sleepSync(100 + attempt * 30);
    }
  }
}

/** True when the path exists and the current user can write it. */
function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Single-quotes a path for `/bin/sh -c`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createDarwinApplier(options: DarwinApplierOptions): PlatformApplier {
  const { appPath } = options;
  const appName = basename(appPath);
  const parentDir = dirname(appPath);
  const runner: CommandRunner = options.runner ?? defaultCommandRunner;
  const pid = options.pid ?? process.pid;
  const stageRoot = `.${appName.replace(/\.app$/u, '')}-update-${pid}`;

  return {
    async preflight(stage: 'startup' | 'update'): Promise<UpdateBlocker | null> {
      if (stage === 'startup') {
        // Running straight from a mounted DMG or an App Translocation path: the
        // bundle is read-only and cannot replace itself.
        if (appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) {
          return { message: '请把啾啾工坊拖到“应用程序”文件夹后再打开。' };
        }
        return null;
      }
      if (!isWritable(appPath) || !isWritable(parentDir)) {
        return { message: '需要管理员权限，请手动下载新版安装。' };
      }
      return null;
    },

    async prepare(assetPath: string, version: string): Promise<PreparedUpdate> {
      // Extract beside the running app so the later rename stays on one volume
      // and is atomic.
      const stageDir = join(parentDir, stageRoot);
      rmSync(stageDir, { recursive: true, force: true });
      await extractZip(assetPath, stageDir, runner);
      const stagedAppPath = join(stageDir, appName);
      if (!existsSync(stagedAppPath)) {
        throw new Error(`更新包中未找到 ${appName}`);
      }
      await verifyCodesign(stagedAppPath, runner, true);
      const found = await readBundleVersion(stagedAppPath, runner);
      if (found !== version) {
        throw new Error(`更新包版本 ${found} 与目标版本 ${version} 不一致`);
      }
      return { assetPath, version, stagedAppPath };
    },

    apply(prepared: PreparedUpdate): void {
      if (prepared.stagedAppPath === undefined) {
        throw new Error('缺少已解压的新版本应用');
      }
      // macOS allows renaming a running bundle.
      const oldPath = `${appPath}.old-${pid}`;
      rmSync(oldPath, { recursive: true, force: true });
      renameWithRetrySync(appPath, oldPath);
      try {
        renameWithRetrySync(prepared.stagedAppPath, appPath);
      } catch (error) {
        // Local rename recovery only: put the original bundle back so a failed
        // second rename never leaves the app missing from its original path.
        try {
          renameWithRetrySync(oldPath, appPath);
        } catch {
          // Best effort; the original rename failure is surfaced below.
        }
        throw error;
      }
      // Detached waiter: wait for this process to exit, then reopen the app.
      const script = `while kill -0 ${pid} 2>/dev/null; do sleep 1; done; /usr/bin/open ${shQuote(appPath)}`;
      options.spawnDetached('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
    },

    async finalize(): Promise<void> {
      // Scoped cleanup: only this app's own directories, never a symlink whose
      // target may live elsewhere.
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const isOldBundle = entry.name.startsWith(`${appName}.old-`);
        const isStaging = entry.name.startsWith(`.${appName.replace(/\.app$/u, '')}-update-`);
        if (!isOldBundle && !isStaging) continue;
        try {
          rmSync(join(parentDir, entry.name), { recursive: true, force: true });
        } catch {
          // Leftovers are retried on the next update; never fail finalize.
        }
      }
      // Refresh LaunchServices so the Dock icon keeps resolving after the swap.
      try {
        await runner(MACOS_LSREGISTER, ['-f', appPath]);
      } catch {
        // Best effort.
      }
    },
  };
}
