import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnForge } from './invocation.ts';
import { killProcessTree } from './process.ts';

export interface ForgeExecutionOptions {
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

/** Generic Forge transport. Knows no providers, clients, or quota commands. */
export class ForgeExecutor {
  constructor(private readonly defaults: ForgeExecutionOptions = {}) {}

  /** Streaming/interactive entry point. Caller owns streams and process lifetime. */
  spawn(args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    return spawnForge([...args], { env: this.defaults.env, cwd: this.defaults.cwd, ...options });
  }

  /** Bounded one-shot execution. Nonzero exits reject; raw output stays on result. */
  run(args: readonly string[], options: ForgeExecutionOptions = {}): Promise<ExecutionResult> {
    const config = { ...this.defaults, ...options };
    const timeoutMs = config.timeoutMs ?? 30_000;
    const stdoutLimit = config.maxStdoutBytes ?? 4 * 1024 * 1024;
    const stderrLimit = config.maxStderrBytes ?? 1024 * 1024;
    for (const value of [timeoutMs, stdoutLimit, stderrLimit]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Execution limits must be positive integers');
    }
    if (config.signal?.aborted) return Promise.reject(new ExecutionError('aborted', 'Forge execution cancelled'));
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, {
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
        // Terminate the owned tree before reporting cancellation; Forge may own a client child.
        const termination = child.pid ? killProcessTree(child.pid) : Promise.resolve();
        void termination.then(() => fail(error), () => {
          child.kill('SIGKILL');
          fail(new ExecutionError(error.kind, error.message + '; process-tree cleanup failed'));
        });
      };
      const abort = () => stop(new ExecutionError('aborted', 'Forge execution cancelled'));
      const timer = setTimeout(() => stop(new ExecutionError('timeout', 'Forge execution timed out')), timeoutMs);
      config.signal?.addEventListener('abort', abort, { once: true });
      if (config.signal?.aborted) abort();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopped) return;
        outBytes += chunk.length;
        if (outBytes > stdoutLimit) stop(new ExecutionError('output-limit', 'Forge stdout exceeded limit'));
        else stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stopped) return;
        errBytes += chunk.length;
        if (errBytes > stderrLimit) stop(new ExecutionError('output-limit', 'Forge stderr exceeded limit'));
        else stderr.push(chunk);
      });
      child.once('error', () => { if (!stopped) fail(new ExecutionError('spawn', 'Forge process could not start')); });
      child.stdin?.on('error', () => stop(new ExecutionError('io', 'Forge stdin failed')));
      child.stdout?.on('error', () => stop(new ExecutionError('io', 'Forge stdout failed')));
      child.stderr?.on('error', () => stop(new ExecutionError('io', 'Forge stderr failed')));
      child.once('close', (exitCode, signal) => {
        if (settled || stopped) return;
        const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal };
        if (exitCode !== 0) { fail(new ExecutionError('exit', 'Forge exited unsuccessfully', result)); return; }
        settled = true; cleanup(); resolve(result);
      });
      child.stdin?.end(config.input);
    });
  }

  async json(args: readonly string[], options?: ForgeExecutionOptions): Promise<unknown> {
    const result = await this.run(args, options);
    try { return JSON.parse(result.stdout); }
    catch { throw new ExecutionError('json', 'Forge returned invalid JSON', result); }
  }
}
