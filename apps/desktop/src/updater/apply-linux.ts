/**
 * Linux applier: copy the verified AppImage beside `$APPIMAGE` and replace it
 * only after this process exits, so the FUSE mount is gone. Writing into
 * `$APPDIR` / `.mount_*` is refused.
 */

import { accessSync, chmodSync, constants, createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { PlatformApplier, PreparedUpdate, SpawnDetached, UpdateBlocker } from './types.js';

export interface LinuxApplierOptions {
  spawnDetached: SpawnDetached;
  env?: NodeJS.ProcessEnv;
  pid?: number;
}

const RETRYABLE_STAT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** True when the path sits on an AppImage FUSE mount and must not be written. */
export function isFuseMountPath(filePath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolve(filePath);
  const appDir = env.APPDIR?.trim();
  if (appDir) {
    const mount = resolve(appDir);
    if (resolved === mount || resolved.startsWith(`${mount}${sep}`)) return true;
  }
  return resolved.split(sep).some((part) => part.startsWith('.mount_'));
}

/**
 * The real AppImage file. `$APPIMAGE` is the loopback file; `$APPDIR` is the
 * FUSE mount and is never a valid destination.
 */
export function resolveAppImagePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.APPIMAGE?.trim();
  if (!value) return null;
  if (isFuseMountPath(value, env)) return null;
  return value;
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertNotFuseDest(filePath: string, env: NodeJS.ProcessEnv): void {
  if (isFuseMountPath(filePath, env)) {
    throw new Error('拒绝写入 AppImage 挂载点');
  }
}

export function createLinuxApplier(options: LinuxApplierOptions): PlatformApplier {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;

  return {
    async preflight(stage: 'startup' | 'update'): Promise<UpdateBlocker | null> {
      // Running from the FUSE mount is the normal AppImage launch; only the
      // update step needs a writable `$APPIMAGE` beside that mount.
      if (stage === 'startup') return null;
      const appImage = resolveAppImagePath(env);
      if (!appImage || !existsSync(appImage)) {
        return { message: '请使用官方 AppImage 运行后再更新。' };
      }
      if (!isWritable(appImage) || !isWritable(dirname(appImage))) {
        return { message: '没有写入权限，请手动下载新版 AppImage。' };
      }
      return null;
    },

    async prepare(
      assetPath: string,
      version: string,
      onPhase?: (phase: 'extracting' | 'verifying') => void,
    ): Promise<PreparedUpdate> {
      const appImage = resolveAppImagePath(env);
      if (!appImage) throw new Error('未找到 APPIMAGE 路径');
      assertNotFuseDest(appImage, env);
      const stagedAppPath = join(dirname(appImage), `.${basename(appImage)}.wrenyard-update-${pid}`);
      assertNotFuseDest(stagedAppPath, env);
      rmSync(stagedAppPath, { force: true });
      // The download already hashed the asset against the feed digest. Stream
      // the copy so a large AppImage is never buffered; a failed write rejects
      // the pipeline instead of leaving a truncated replacement.
      onPhase?.('extracting');
      await pipeline(createReadStream(assetPath), createWriteStream(stagedAppPath));
      chmodSync(stagedAppPath, 0o755);
      onPhase?.('verifying');
      return { assetPath, version, stagedAppPath };
    },

    apply(prepared: PreparedUpdate): void {
      if (prepared.stagedAppPath === undefined) {
        throw new Error('缺少已准备的新版本 AppImage');
      }
      const appImage = resolveAppImagePath(env);
      if (!appImage) throw new Error('未找到 APPIMAGE 路径');
      assertNotFuseDest(appImage, env);
      assertNotFuseDest(prepared.stagedAppPath, env);
      // Replace only after this PID exits so FUSE has unmounted the old file.
      const script = [
        `while /bin/kill -0 ${pid} 2>/dev/null; do /bin/sleep 1; done`,
        `/bin/mv -f -- ${shQuote(prepared.stagedAppPath)} ${shQuote(appImage)}`,
        `/bin/chmod 755 -- ${shQuote(appImage)}`,
        `exec ${shQuote(appImage)}`,
      ].join('; ');
      options.spawnDetached('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
    },

    async finalize(): Promise<void> {
      const appImage = resolveAppImagePath(env);
      if (!appImage) return;
      const parentDir = dirname(appImage);
      const prefix = `.${basename(appImage)}.wrenyard-update-`;
      try {
        for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
          try {
            rmSync(join(parentDir, entry.name), { force: true });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== undefined && RETRYABLE_STAT_CODES.has(code)) continue;
          }
        }
      } catch {
        // Leftovers are retried on the next update; never fail finalize.
      }
    },
  };
}
