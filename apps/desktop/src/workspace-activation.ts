import { spawn } from 'node:child_process';

/**
 * Electron-free workspace activation helpers. Desktop binds a workspace and
 * then asks the installed CLI to restart the daemon. The restart is only safe
 * when the daemon has no queued or running work, so activation first asserts an
 * idle daemon and never interrupts in-flight tasks.
 */

const DEFAULT_OUTPUT_LIMIT = 8_192;
const DEFAULT_RESTART_TIMEOUT_MS = 30_000;

export interface ProductDaemonIdleResult {
  idle: boolean;
  reason?: string;
}

export interface DaemonRestartRequest {
  cli: string;
  outputLimit?: number;
  timeoutMs?: number;
}

export interface DaemonRestartRunnerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type DaemonRestartRunner = (cli: string, args: string[]) => Promise<DaemonRestartRunnerResult>;

export interface DaemonRestartOutcome {
  /** Bounded combined stdout/stderr for diagnostics; kept local for diagnostics. */
  output: string;
  /** `completed` once the CLI reported `restarted: true`. */
  restartResult: string;
}

/**
 * Require the real daemon.status contract. The daemon reports idleness directly
 * (`idle`), so activation reads that flag plus the active counts and the
 * shutdown state; missing state is not proof of idle.
 */
export function assertDaemonIdle(rawStatus: unknown): ProductDaemonIdleResult {
  const state = rawStatus && typeof rawStatus === 'object'
    ? rawStatus as Record<string, unknown> : {};
  const counts = ['activeTaskCount', 'activeWorkflowCount', 'activeExecutionCount'];
  if (state.ok !== true || typeof state.idle !== 'boolean' || typeof state.shutting_down !== 'boolean'
    || counts.some((key) => !Number.isSafeInteger(state[key]) || (state[key] as number) < 0)) {
    return { idle: false, reason: '无法确认后台状态，请刷新后重试' };
  }
  if (state.idle !== true || state.shutting_down === true || counts.some((key) => (state[key] as number) > 0)) {
    return { idle: false, reason: '后台仍有任务或正在维护，请完成后再切换工作区' };
  }
  return { idle: true };
}

/**
 * Hidden, shell-free spawn runner. Bounded stdout/stderr; no redirection, no
 * shell interpolation, no secret environment material is echoed.
 */
export function defaultDaemonRestartRunner(limit: number, timeoutMs: number): DaemonRestartRunner {
  return (cli: string, args: string[]): Promise<DaemonRestartRunnerResult> => new Promise((resolvePromise, rejectPromise) => {
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

/** Parse the CLI JSON envelope and require `restarted: true`. */
function completedRestartResult(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return (parsed as { restarted?: unknown }).restarted === true ? 'completed' : null;
}

/**
 * Run the installed CLI's synchronous daemon restart. Any nonzero exit, invalid
 * JSON, or non-`restarted` result surfaces an actionable Chinese error — the
 * caller must never pretend the activation succeeded.
 */
export async function runDaemonRestart(
  request: DaemonRestartRequest,
  runner: DaemonRestartRunner = defaultDaemonRestartRunner(
    request.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
    request.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS,
  ),
): Promise<DaemonRestartOutcome> {
  const limit = request.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const result = await runner(request.cli, ['daemon', 'restart', '--json']);
  const output = `${result.stdout}${result.stderr}`.slice(-limit).trim();
  if (result.code !== 0) {
    throw new Error(`daemon restart 失败（退出码 ${result.code ?? 'unknown'}）：${output || '无输出'}`);
  }
  const restartResult = completedRestartResult(result.stdout);
  if (restartResult === null) {
    throw new Error(`daemon restart 未返回 restarted: true：${output || '无输出'}`);
  }
  return { output, restartResult };
}
