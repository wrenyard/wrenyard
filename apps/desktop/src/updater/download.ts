/**
 * Streaming download, verification and extraction for the Desktop updater.
 *
 * Migrated from the retired SEA install engine (`apps/cli/src/install`). The
 * engine's layout/lock/recovery machinery is gone; only these primitives move.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { CommandResult, CommandRunner } from './types.js';

/** Minimal `fetch` surface so callers can inject a fake without a network. */
export type FetchLike = typeof fetch;

/** Default idle timeout between received chunks; there is no total cap. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** macOS extraction tool; a same-volume `ditto` keeps the swap atomic. */
export const MACOS_DITTO = '/usr/bin/ditto';

/** LaunchServices registration tool, run after an app swap. */
export const MACOS_LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Thrown when a downloaded archive's sha256 does not match the feed digest. */
export class DigestMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch (expected ${expected}, got ${actual})`);
    this.name = 'DigestMismatchError';
  }
}

/** Thrown when the download stalls longer than the idle timeout. */
export class DownloadTimeoutError extends Error {
  constructor(idleTimeoutMs: number) {
    super(`download stalled for more than ${idleTimeoutMs}ms`);
    this.name = 'DownloadTimeoutError';
  }
}

/** Default runner: asynchronous `execFile`, no shell, hidden window on Windows. */
export const defaultCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const code = error === null ? undefined : (error as { code?: unknown }).code;
        const status = error === null ? 0 : typeof code === 'number' ? code : null;
        resolve({
          status,
          ...(error !== null && status === null ? { error } : {}),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });

/**
 * Downloads an asset while hashing it, resetting the idle timer on every
 * non-empty chunk. Returns the hex sha256 that was written. A digest mismatch
 * throws {@link DigestMismatchError}; the caller deletes the file. An optional
 * `signal` (and the internal idle timer) aborts the stream and closes the file
 * before the caller removes it.
 */
export async function downloadFile(options: {
  url: string;
  dest: string;
  sha256?: string;
  fetchImpl?: FetchLike;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const controller = new AbortController();
  const external = options.signal;
  const forwardAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  mkdirSync(dirname(options.dest), { recursive: true });
  const hash = createHash('sha256');
  const hashAndTime = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > 0) {
        arm();
        hash.update(chunk);
      }
      callback(null, chunk);
    },
  });

  arm();
  try {
    const response = await fetchImpl(options.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status} for ${options.url}`);
    }
    if (response.body === null) {
      throw new Error(`download failed: empty body for ${options.url}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
      hashAndTime,
      createWriteStream(options.dest),
      { signal: controller.signal },
    );
    const actual = hash.digest('hex');
    if (options.sha256 !== undefined && options.sha256 !== actual) {
      throw new DigestMismatchError(options.sha256, actual);
    }
    return actual;
  } catch (error) {
    if (timedOut) throw new DownloadTimeoutError(idleTimeoutMs);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
  }
}

/** Hex sha256 of an existing file. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Extracts a macOS archive with the native `ditto` tool, awaiting its result. */
export async function extractZip(
  zip: string,
  dest: string,
  runner: CommandRunner,
): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const result = await runner(MACOS_DITTO, ['-x', '-k', zip, dest]);
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`failed to extract ${zip}: ${detail}`);
  }
}

/** macOS `codesign --verify` (optionally `--deep`), a no-op on Windows. */
export async function verifyCodesign(
  target: string,
  runner: CommandRunner,
  deep = false,
): Promise<void> {
  const args = ['--verify'];
  if (deep) args.push('--deep');
  args.push('--strict', target);
  const result = await runner('codesign', args);
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`codesign verification failed for ${target}: ${detail}`);
  }
}

/** Reads `CFBundleShortVersionString` from a macOS bundle `Info.plist`. */
export async function readBundleVersion(
  appPath: string,
  runner: CommandRunner,
): Promise<string> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const result = await runner('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`cannot read bundle version from ${plist}: ${detail}`);
  }
  return result.stdout.trim();
}
