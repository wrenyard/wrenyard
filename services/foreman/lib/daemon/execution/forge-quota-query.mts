/**
 * Daemon-owned Forge quota process access helper.
 *
 * This is the allowed adapter boundary for running the existing Foreman Forge
 * helper (no shell, bounded timeout, capped stdout/stderr) to execute exactly
 * `forge quota --json`. Output that exceeds the caps terminates the child and
 * is rejected, never parsed as truncated data. No policy/parsing logic lives
 * here.
 *
 * The optional CodeBuddy expected context carries only the two private expected
 * values needed for a scoped quota query: the opaque expected scope and the
 * normalized expected environment. The child receives a fresh env copied from
 * process.env with every case variant of the private Forge CodeBuddy names
 * removed, and the canonical names are set only when both values are present.
 * The credential/token/domain/wire mapping is never part of this context, and
 * the values are never logged or interpolated into errors.
 */

import { spawnForge } from '../../adapters/forge/exec.mts';

/** Bounded spawn for the default `forge quota --json` query. */
const FORGE_QUOTA_TIMEOUT_MS = 30_000;
const FORGE_QUOTA_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const FORGE_QUOTA_MAX_STDERR_BYTES = 1024 * 1024;

/** Canonical private Forge CodeBuddy expected-context environment names. */
const CODEBUDDY_EXPECTED_SCOPE_ENV = 'WRENYARD_CODEBUDDY_EXPECTED_SCOPE';
const CODEBUDDY_EXPECTED_ENVIRONMENT_ENV = 'WRENYARD_CODEBUDDY_EXPECTED_ENVIRONMENT';

/**
 * Complete current CodeBuddy expected context for one scoped quota query.
 * Carries only the opaque expected scope and the normalized expected
 * environment of the current login; never a credential, token, domain, or
 * wire model.
 */
export interface CodeBuddyQueryContext {
  readonly expectedScope: string;
  readonly expectedEnvironment: string;
}

/**
 * Builds the fresh child env for one quota query: process.env with every case
 * variant of the two private Forge CodeBuddy expected-context names removed
 * (so a standalone or incomplete-context call can never inherit stale scope),
 * then the exact canonical names set only when both values are non-empty.
 */
function codeBuddyQueryEnv(context: CodeBuddyQueryContext | undefined): NodeJS.ProcessEnv {
  const privateKeys = new Set([
    CODEBUDDY_EXPECTED_SCOPE_ENV.toLowerCase(),
    CODEBUDDY_EXPECTED_ENVIRONMENT_ENV.toLowerCase(),
  ]);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (privateKeys.has(key.toLowerCase())) continue;
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const scope = context?.expectedScope;
  const environment = context?.expectedEnvironment;
  if (
    typeof scope === 'string' && scope.length > 0 &&
    typeof environment === 'string' && environment.length > 0
  ) {
    childEnv[CODEBUDDY_EXPECTED_SCOPE_ENV] = scope;
    childEnv[CODEBUDDY_EXPECTED_ENVIRONMENT_ENV] = environment;
  }
  return childEnv;
}

/**
 * Runs `forge quota --json` with a bounded timeout and capped stdout/stderr.
 *
 * Accepts an optional CodeBuddy expected scope/environment context; when both
 * values are present the child is scoped to the current CodeBuddy login via the
 * two canonical private env names, and when the context is incomplete or absent
 * both variables are omitted so the standalone call stays backward compatible.
 * Resolves the full stdout only when the child exits 0; rejects on child
 * error, timeout, cap overflow, or nonzero exit (with bounded stderr detail).
 * The context values are never included in error text.
 */
export function queryForgeQuotaJson(context?: CodeBuddyQueryContext): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnForge(['quota', '--json'], {
      timeout: FORGE_QUOTA_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: codeBuddyQueryEnv(context),
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
