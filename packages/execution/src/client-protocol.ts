import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Executor, ExecutionOptions } from './executor.ts';
import { killProcessTree, resolveWindowsHideOption } from './process.ts';

export interface RpcStep {
  method: string;
  params?: unknown;
  notification?: boolean;
}

export interface RpcRequest {
  command: string;
  args: readonly string[];
  /** Overlay: a string sets the variable, null removes it, absent inherits. */
  env?: Readonly<Record<string, string | null>>;
  steps: readonly RpcStep[];
}

export class NativeOperationError extends Error {
  constructor(readonly code: string, readonly step?: number, readonly rpcCode?: number) {
    super('Native operation failed: ' + code);
    this.name = 'NativeOperationError';
  }
}

/** A JSON-RPC message as it appears on the newline-delimited stdio wire. */
interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const MAX_STEPS = 64;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 20_000;
const TERMINATION_GRACE_MS = 5_000;

/**
 * Apply a caller-supplied environment overlay to a complete environment.
 * Matching is case-insensitive so a Windows `Path`/`PATH` pair never both
 * survives, and a null value removes the variable entirely.
 */
function applyEnvOverlay(base: NodeJS.ProcessEnv, overlay: RpcRequest['env']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(overlay ?? {})) {
    const key = Object.keys(env).find((existing) => existing.toLowerCase() === name.toLowerCase()) ?? name;
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Run a JSON-RPC sequence over a child's newline-delimited stdio channel.
 *
 * Requests are issued strictly in order and each request is awaited before the
 * next is written, so IDs are always sequential. While awaiting a response,
 * unrelated notifications (messages with no ID) are ignored, and a response
 * carrying a different ID is skipped rather than treated as the answer. A
 * JSON-RPC error response rejects with `NativeOperationError` carrying the
 * failing step index and the server's RPC code.
 *
 * The child is always released: its input is closed, its process tree is
 * terminated, and its pipes are drained on success, timeout, abort, protocol
 * failure, and spawn failure alike.
 */
export async function rpcSequence(execution: Executor, request: RpcRequest, options?: ExecutionOptions): Promise<unknown[]> {
  if (!request.command || typeof request.command !== 'string') throw new NativeOperationError('invalid_request');
  if (!Array.isArray(request.steps) || request.steps.length === 0 || request.steps.length > MAX_STEPS) {
    throw new NativeOperationError('invalid_request');
  }

  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  // A manually-managed deadline signal, not AbortSignal.timeout: the latter
  // leaves its timer armed for the full timeout, delaying process exit after a
  // fast success.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error('operation timed out'), { name: 'TimeoutError' }));
  }, timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const env = applyEnvOverlay(options?.env ?? process.env, request.env);

  try {
    if (signal.aborted) throw abortError(signal);

    let child: ChildProcess;
    try {
      child = execution.spawn(request.command, request.args, {
        env,
        cwd: options?.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: resolveWindowsHideOption({}),
      });
    } catch {
      throw new NativeOperationError('native_operation_failed');
    }

    const connection = new RpcConnection(child, signal);
    try {
      const results: unknown[] = [];
      for (let step = 0; step < request.steps.length; step += 1) {
        const operation = request.steps[step];
        if (typeof operation.method !== 'string' || operation.method.length === 0) {
          throw new NativeOperationError('invalid_request', step);
        }
        if (operation.notification) {
          connection.notify(operation.method, operation.params);
          results.push(undefined);
          continue;
        }
        try {
          results.push(await connection.call(operation.method, operation.params));
        } catch (error) {
          // Each fault reports the step it failed at, with the server's RPC code
          // preserved when the failure was a JSON-RPC error response.
          if (error instanceof RpcResponseError) {
            throw new NativeOperationError('native_operation_failed', step, error.code);
          }
          // The signal is authoritative: a timeout and a caller abort differ
          // only in the code they surface.
          if (signal.aborted) throw abortError(signal, step);
          if (error instanceof NativeOperationError) throw error;
          throw new NativeOperationError('native_operation_failed', step);
        }
      }
      return results;
    } finally {
      await connection.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Abort reason as a NativeOperationError: timeout and caller abort differ only in code. */
function abortError(signal: AbortSignal, step?: number): NativeOperationError {
  // AbortSignal.timeout() rejects with a TimeoutError DOMException; a caller
  // abort carries whatever reason it chose. Name is the portable discriminator.
  const name = (signal.reason as { name?: unknown } | undefined)?.name;
  return new NativeOperationError(name === 'TimeoutError' ? 'native_operation_timeout' : 'aborted', step);
}

class RpcResponseError extends Error {
  constructor(readonly code: number, readonly message: string) {
    super(`JSON-RPC error ${code}: ${message}`);
    this.name = 'RpcResponseError';
  }
}

/**
 * Newline-delimited JSON-RPC conversation bound to one child's stdio.
 *
 * Requests are strictly sequential, so exactly one call is ever outstanding. A
 * message without an ID (a notification) is ignored, and a message whose ID
 * does not match the outstanding call is skipped rather than mistaken for its
 * answer. Native failures — abort, timeout, close, malformed output — are
 * recorded once and surfaced to the next call.
 */
class RpcConnection {
  private nextId = 1;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private stderrTail = '';
  private failure: Error | undefined;
  private waiter: { id: number; resolve(message: RpcMessage): void; reject(error: Error): void } | undefined;
  private closed = false;
  private readonly abortHandler: () => void;

  constructor(private readonly child: ChildProcess, private readonly signal: AbortSignal) {
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stdout?.on('error', () => this.fail(new Error('stdout read failed')));
    child.stdin?.on('error', () => this.fail(new Error('stdin write failed')));
    child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.stderr?.on('error', () => undefined);
    child.once('error', (error: Error) => this.fail(error));
    child.once('close', () => this.fail(new Error('connection closed unexpectedly')));
    this.abortHandler = () => this.fail(this.signal.reason ?? new Error('aborted'));
    // An already-aborted signal never fires the event, so surface it eagerly.
    if (this.signal.aborted) this.fail(this.signal.reason ?? new Error('aborted'));
    else this.signal.addEventListener('abort', this.abortHandler, { once: true });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    // The waiter is installed before the write so a same-tick response cannot
    // arrive before this call is listening for it.
    const response = new Promise<RpcMessage>((resolve, reject) => { this.waiter = { id, resolve, reject }; });
    this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const message = await response;
    const fault = message.error;
    if (fault !== undefined && fault !== null) {
      const code = typeof fault.code === 'number' ? fault.code : 0;
      throw new RpcResponseError(code, typeof fault.message === 'string' ? fault.message : method);
    }
    // A response without an explicit result is a valid null result.
    return message.result;
  }

  /** Release the child and confirm its process tree is gone. Bounded and idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.abortHandler);
    this.child.stdin?.end();
    this.child.stdout?.removeAllListeners('data');
    this.child.stderr?.removeAllListeners('data');
    const pid = this.child.pid;
    if (pid !== undefined && this.child.exitCode === null) {
      await raceDelay(killProcessTree(pid).catch(() => undefined), TERMINATION_GRACE_MS);
    }
  }

  private write(message: unknown): void {
    if (this.closed) return;
    const sink = this.child.stdin;
    if (!sink || sink.destroyed) { this.fail(new Error('stdin is not available')); return; }
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.fail(new Error('request line exceeded limit')); return; }
    sink.write(line, (error) => { if (error) this.fail(error); });
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    // A line longer than the ceiling can never be a valid response; fail before
    // the buffer grows without bound.
    if (this.buffer.length > MAX_LINE_BYTES && this.buffer.indexOf('\n') === -1) {
      this.fail(new Error('response line exceeded limit'));
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.fail(new Error('response line exceeded limit')); return; }
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.deliver(line);
      if (this.closed) return;
      newline = this.buffer.indexOf('\n');
    }
  }

  private onStderr(chunk: Buffer): void {
    if (this.closed) return;
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_BYTES);
  }

  private deliver(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; }
    catch { this.fail(new Error('response was not valid JSON')); return; }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(new Error('response was not a JSON object'));
      return;
    }
    // Notifications carry no ID and are never the answer to a call; a response
    // for a different ID is not this call's answer either, so it is skipped.
    if (message.id === undefined || message.id === null) return;
    const waiter = this.waiter;
    if (!waiter || waiter.id !== message.id) return;
    this.waiter = undefined;
    waiter.resolve(message);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abortHandler);
    // Retain the bounded stderr tail for native context, never echo it: it may
    // carry credential-adjacent diagnostics.
    void this.stderrTail;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter.reject(error);
  }
}

/** Resolve when `promise` settles or `ms` elapses, whichever comes first. */
function raceDelay(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}
