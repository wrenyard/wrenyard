import { spawn } from 'node:child_process';

/**
 * Electron-free workspace activation helpers. Desktop binds a workspace and
 * then asks the installed CLI to perform a planned daemon restart. The restart
 * is only safe when the daemon has no queued or running work, so activation
 * first asserts an idle daemon and never interrupts in-flight tasks.
 */

const DEFAULT_OUTPUT_LIMIT = 8_192;
const DEFAULT_RESTART_TIMEOUT_MS = 30_000;

export interface ProductDaemonIdleResult {
  idle: boolean;
  reason?: string;
}

export interface PlannedRestartRequest {
  cli: string;
  outputLimit?: number;
  timeoutMs?: number;
}

export interface PlannedRestartRunnerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type PlannedRestartRunner = (cli: string, args: string[]) => Promise<PlannedRestartRunnerResult>;

export interface PlannedRestartOutcome {
  /** Bounded combined stdout/stderr for diagnostics; kept local for diagnostics. */
  output: string;
  /** Parsed `restart_result` from the CLI JSON envelope. */
  restartResult: string;
}

/** Require the real daemon.status contract; missing state is not proof of idle. */
export function assertDaemonIdle(rawStatus: unknown): ProductDaemonIdleResult {
  const state = rawStatus && typeof rawStatus === 'object'
    ? rawStatus as Record<string, unknown> : {};
  const counts = ['activeTaskCount', 'activeWorkflowCount', 'activeExecutionCount'];
  if (state.ok !== true || counts.some((key) => !Number.isSafeInteger(state[key]) || (state[key] as number) < 0)
    || typeof state.frozen !== 'boolean' || typeof state.recovery_required !== 'boolean') {
    return { idle: false, reason: '无法确认后台状态，请刷新后重试' };
  }
  if (counts.some((key) => (state[key] as number) > 0)
    || state.mode !== 'accepting' || state.frozen || state.recovery_required) {
    return { idle: false, reason: '后台仍有任务或正在维护，请完成后再切换工作区' };
  }
  return { idle: true };
}

/**
 * Hidden, shell-free spawn runner. Bounded stdout/stderr; no redirection, no
 * shell interpolation, no secret environment material is echoed.
 */
export function defaultPlannedRestartRunner(limit: number, timeoutMs: number): PlannedRestartRunner {
  return (cli: string, args: string[]): Promise<PlannedRestartRunnerResult> => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cli, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-limit);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        rejectPromise(new Error('daemon restart 命令超时，后台可能仍处于重启中'));
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish(() => rejectPromise(error)));
    child.on('close', (code) => finish(() => resolvePromise({ stdout, stderr, code })));
  });
}

/** Parse the CLI JSON envelope and require a completed `restart_result`. */
function completedRestartResult(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = (parsed as { restart_result?: unknown }).restart_result;
  return typeof value === 'string' && value === 'completed' ? value : null;
}

/**
 * Run the installed CLI's planned daemon restart. Any nonzero exit, invalid
 * JSON, or non-`completed` result surfaces an actionable Chinese error — the
 * caller must never pretend the activation succeeded.
 */
export async function runPlannedDaemonRestart(
  request: PlannedRestartRequest,
  runner: PlannedRestartRunner = defaultPlannedRestartRunner(
    request.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
    request.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS,
  ),
): Promise<PlannedRestartOutcome> {
  const limit = request.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const result = await runner(request.cli, ['daemon', 'restart', '--json']);
  const output = `${result.stdout}${result.stderr}`.slice(-limit).trim();
  if (result.code !== 0) {
    throw new Error(`daemon restart 失败（退出码 ${result.code ?? 'unknown'}）：${output || '无输出'}`);
  }
  const restartResult = completedRestartResult(result.stdout);
  if (restartResult === null) {
    throw new Error(`daemon restart 未返回已完成的 restart_result：${output || '无输出'}`);
  }
  return { output, restartResult };
}
