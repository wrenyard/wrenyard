import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnProcess } from './process.ts';
import { killProcessTree } from './process.ts';

export interface ExecutionOptions {
  /** Complete environment, not an overlay; omitted means the current process environment. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  input?: string | Uint8Array;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class ExecutionError extends Error {
  constructor(
    readonly kind: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'output-limit' | 'io' | 'json',
    message: string,
    readonly result?: ExecutionResult,
  ) { super(message); this.name = 'ExecutionError'; }
}

/**
 * Generic process transport over the shared spawn path. Knows no runtime
 * executable, provider, client, or quota command: the caller always names the
 * command and its arguments explicitly.
 */
export class Executor {
  constructor(private readonly defaults: ExecutionOptions = {}) {}

  /**
   * Streaming/interactive entry point. Caller owns streams and process lifetime.
   * Windows command scripts (npm's `.cmd` shims included) are routed through
   * cmd.exe with escaped, boundary-preserving arguments rather than a shell.
   */
  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    return spawnProcess(command, args, {
      env: this.defaults.env,
      cwd: this.defaults.cwd,
      ...options,
    });
  }

  /** Bounded one-shot execution. Nonzero exits reject; raw output stays on result. */
  run(command: string, args: readonly string[], options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const config = { ...this.defaults, ...options };
    const timeoutMs = config.timeoutMs ?? 30_000;
    const stdoutLimit = config.maxStdoutBytes ?? 4 * 1024 * 1024;
    const stderrLimit = config.maxStderrBytes ?? 1024 * 1024;
    for (const value of [timeoutMs, stdoutLimit, stderrLimit]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Execution limits must be positive integers');
    }
    if (config.signal?.aborted) return Promise.reject(new ExecutionError('aborted', 'execution cancelled'));
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, {
        env: config.env, cwd: config.cwd, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let outBytes = 0, errBytes = 0;
      let stopped = false, settled = false;
      const cleanup = () => { clearTimeout(timer); config.signal?.removeEventListener('abort', abort); };
      const fail = (error: ExecutionError) => {
        if (settled) return;
        settled = true; cleanup(); reject(error);
      };
      const stop = (error: ExecutionError) => {
        if (stopped || settled) return;
        stopped = true;
        // Terminate the owned tree before reporting cancellation; the command
        // may own child processes of its own.
        const termination = child.pid ? killProcessTree(child.pid) : Promise.resolve();
        void termination.then(() => fail(error), () => {
          child.kill('SIGKILL');
          fail(new ExecutionError(error.kind, error.message + '; process-tree cleanup failed'));
        });
      };
      const abort = () => stop(new ExecutionError('aborted', 'execution cancelled'));
      const timer = setTimeout(() => stop(new ExecutionError('timeout', 'execution timed out')), timeoutMs);
      config.signal?.addEventListener('abort', abort, { once: true });
      if (config.signal?.aborted) abort();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopped) return;
        outBytes += chunk.length;
        if (outBytes > stdoutLimit) stop(new ExecutionError('output-limit', 'stdout exceeded limit'));
        else stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stopped) return;
        errBytes += chunk.length;
        if (errBytes > stderrLimit) stop(new ExecutionError('output-limit', 'stderr exceeded limit'));
        else stderr.push(chunk);
      });
      child.once('error', () => { if (!stopped) fail(new ExecutionError('spawn', 'process could not start')); });
      child.stdin?.on('error', () => stop(new ExecutionError('io', 'stdin failed')));
      child.stdout?.on('error', () => stop(new ExecutionError('io', 'stdout failed')));
      child.stderr?.on('error', () => stop(new ExecutionError('io', 'stderr failed')));
      child.once('close', (exitCode, signal) => {
        if (settled || stopped) return;
        const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal };
        if (exitCode !== 0) { fail(new ExecutionError('exit', 'process exited unsuccessfully', result)); return; }
        settled = true; cleanup(); resolve(result);
      });
      child.stdin?.end(config.input);
    });
  }

  async json(command: string, args: readonly string[], options?: ExecutionOptions): Promise<unknown> {
    const result = await this.run(command, args, options);
    try { return JSON.parse(result.stdout); }
    catch { throw new ExecutionError('json', 'process returned invalid JSON', result); }
  }
}
