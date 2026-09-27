/** Download, verification and extraction for the SEA install engine. */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MACOS_DITTO,
  isWindows,
  windowsTarPath,
} from './platform.js';
import type { CommandResult, CommandRunner } from './platform.js';

/** Minimal `fetch` surface so tests can inject a fake without a network. */
export type FetchLike = typeof fetch;

/** Default idle timeout between received chunks. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

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

/** Downloads an archive while hashing; returns the hex sha256 that was written. */
export async function downloadFile(options: {
  url: string;
  dest: string;
  sha256?: string;
  fetchImpl?: FetchLike;
  idleTimeoutMs?: number;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
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
  arm();
  try {
    const response = await fetchImpl(options.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status} for ${options.url}`);
    }
    if (response.body === null) {
      throw new Error(`download failed: empty body for ${options.url}`);
    }
    const hash = createHash('sha256');
    const out = createWriteStream(options.dest);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (value !== undefined) {
          hash.update(value);
          if (!out.write(Buffer.from(value))) await once(out, 'drain');
        }
      }
    } finally {
      reader.releaseLock();
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      out.on('error', rejectPromise);
      out.end(() => resolvePromise());
    });
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
  }
}

/** Hex sha256 of an existing file. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Reads the first token of `<zip>.sha256`, the local-build sidecar digest. */
export function readSidecarDigest(zipPath: string): string {
  const sidecar = `${zipPath}.sha256`;
  if (!existsSync(sidecar)) throw new Error(`missing checksum sidecar: ${sidecar}`);
  const value = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid checksum sidecar: ${sidecar}`);
  }
  return value;
}

/** Extracts an archive, awaiting the archive tool with no global timeout. */
export async function extractZip(
  zip: string,
  dest: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runner: CommandRunner,
): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const { command, args } = isWindows(platform)
    ? {
        command: windowsTarPath(env),
        args: ['-x', '--no-same-owner', '--no-same-permissions', '-f', zip, '-C', dest],
      }
    : { command: MACOS_DITTO, args: ['-x', '-k', zip, dest] };
  const result: CommandResult = await runner(command, args, { env });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`failed to extract ${zip}: ${detail}`);
  }
}

/** macOS `codesign --verify` (optionally `--deep`), a no-op on Windows. */
export async function verifyCodesign(
  target: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runner: CommandRunner,
  deep = false,
): Promise<void> {
  if (isWindows(platform)) return;
  const args = ['--verify'];
  if (deep) args.push('--deep');
  args.push('--strict', target);
  const result = await runner('codesign', args, { env });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`codesign verification failed for ${target}: ${detail}`);
  }
}

/** True when `path` exists and is a non-empty regular file. */
export function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}
