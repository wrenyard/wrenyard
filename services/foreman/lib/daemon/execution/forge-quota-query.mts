/**
 * Daemon-owned Forge quota process access helper.
 *
 * This is the allowed adapter boundary for running the existing Foreman Forge
 * helper (no shell, bounded timeout, capped stdout/stderr) to execute exactly
 * `forge quota --json`. Output that exceeds the caps terminates the child and
 * is rejected, never parsed as truncated data. No policy/parsing logic lives
 * here.
 */

import { spawnForge } from '../../adapters/forge/exec.mts';

/** Bounded spawn for the default `forge quota --json` query. */
const FORGE_QUOTA_TIMEOUT_MS = 30_000;
const FORGE_QUOTA_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const FORGE_QUOTA_MAX_STDERR_BYTES = 1024 * 1024;

/**
 * Runs `forge quota --json` with a bounded timeout and capped stdout/stderr.
 *
 * Resolves the full stdout only when the child exits 0; rejects on child
 * error, timeout, cap overflow, or nonzero exit (with bounded stderr detail).
 */
export function queryForgeQuotaJson(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnForge(['quota', '--json'], {
      timeout: FORGE_QUOTA_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const abortOnOverflow = (): void => {
      if (!child.killed) child.kill();
      fail(new Error('forge quota --json output exceeded the bounded cap; discarded'));
    };

    child.stdout?.on('data', (chunk: { toString(encoding?: string): string; length: number }) => {
      if (stdoutCapped) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > FORGE_QUOTA_MAX_STDOUT_BYTES) {
        stdoutCapped = true;
        abortOnOverflow();
      }
    });
    child.stderr?.on('data', (chunk: { toString(encoding?: string): string; length: number }) => {
      if (stderrCapped) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > FORGE_QUOTA_MAX_STDERR_BYTES) {
        stderrCapped = true;
        abortOnOverflow();
      }
    });

    child.on('error', fail);
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (stdoutCapped || stderrCapped) {
        // Overflow already terminated the child; never parse truncated output.
        fail(new Error('forge quota --json output exceeded the bounded cap; discarded'));
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || `exit code ${String(code)} signal ${String(signal)}`;
      reject(new Error(`forge quota --json failed (${detail})`));
    });
  });
}
