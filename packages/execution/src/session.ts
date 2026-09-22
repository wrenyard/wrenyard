import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { spawnProcess } from './process.ts';
import { killProcessTree } from './process.ts';

const MAX_QUEUED_EVENTS = 64;
/** Extra queue slots reserved for the guaranteed terminal error + exit frames. */
const RESERVED_TERMINAL_EVENTS = 2;
/** Finite fallback when killProcessTree cannot confirm tree termination. */
const TERMINATION_FALLBACK_MS = 5_000;
/** Finite confirmation window for the child process being spawned. */
const STARTUP_CONFIRM_MS = 15_000;

/**
 * Terminal result ceiling per stream. This bounds what `result.stdout`/
 * `result.stderr` retain; it is NOT a limit on how much output a long-running
 * child may produce. A run reaches its terminal state through its exit or
 * cancellation and its excess output is simply absent from the result, so an
 * agent that streams for hours is never failed for streaming.
 */
const MAX_RESULT_STREAM_BYTES = 2 * 1024 * 1024;

export interface ProcessFile {
  readonly path: string;
  readonly data: string | Uint8Array;
  /** Remove after the process reaches a terminal state, including failed start. */
  readonly cleanup?: 'completion' | 'success';
}

export interface ProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly files?: readonly ProcessFile[];
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExecutionEvent {
  readonly type: 'started' | 'stdout' | 'stderr' | 'exit' | 'error';
  readonly data?: Uint8Array;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly message?: string;
  readonly pid?: number;
}

export interface ExecutionSession {
  readonly events: AsyncIterable<ExecutionEvent>;
  readonly result: Promise<ExecutionResult>;
  write(data: string | Uint8Array): void;
  closeInput(): void;
  cancel(): Promise<void>;
  readonly diagnostics: { pid?: number };
}

export interface StartProcessOptions {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Start the requested executable through the shared spawn path and expose its
 * stdio as one bounded event stream plus a single terminal result.
 *
 * Semantics every consumer relies on:
 *  - the launch environment is exactly `spec.env`; `options.env` never replaces
 *    it, because the caller composes gateway/MCP/native configuration there;
 *  - Windows command scripts (npm shims included) are launched through cmd.exe
 *    with escaped, boundary-preserving arguments, never a shell;
 *  - `started` is emitted once, on the child's `spawn` event, before any output
 *    or terminal frame — including for a child that exits immediately;
 *  - `write`/`closeInput` forward raw bytes to the child's stdin, replacing the
 *    retired control-frame protocol;
 *  - stdout and stderr are each emitted as bounded event frames and retained as
 *    bounded result tails; total lifetime output is unbounded and never fails
 *    the run;
 *  - exactly one terminal outcome is published (an optional `error` frame then
 *    an `exit` frame), after owned files are rolled back or cleaned up;
 *  - `result` resolves exactly once, and never rejects;
 *  - `cancel` is idempotent, awaits the owned child's termination, and rejects
 *    when that termination could not be confirmed.
 */
export async function startProcess(spec: ProcessSpec, options: StartProcessOptions = {}): Promise<ExecutionSession> {
  if (options.signal?.aborted) throw new Error('execution cancelled before start');
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  const resources = await materializeFiles(spec.files ?? []);
  // A signal that fired during materialization must abort before an owned
  // resource is handed to a child that will never be spawned.
  if (options.signal?.aborted) {
    await cleanupFiles(resources, false, true);
    throw new Error('execution cancelled before start');
  }

  const queue = createQueue<ExecutionEvent>(MAX_QUEUED_EVENTS);
  let terminal = false;
  let started = false;
  // Native events can outrun the spawn confirmation; 'close' may therefore
  // arrive before the child is confirmed, and must not be mistaken for a
  // process that never started.
  let closed = false;
  let childExitCode: number | null = null;
  let childSignal: NodeJS.Signals | null = null;
  // Set once this session has asked the child to die; an unconfirmed kill is
  // then retried before cleanup is ever reported as complete.
  let killRequested = false;
  // Retained spawn failure; 'close' decides whether it describes a child that
  // never ran or one that exited normally after a later stream fault.
  let lastStartError: Error | undefined;
  let removeTreeListeners: () => void = () => undefined;
  let resolveResult!: (result: ExecutionResult) => void;
  const result = new Promise<ExecutionResult>((resolve) => { resolveResult = resolve; });
  // Bounded tails rather than a cumulative ceiling: each stream keeps its most
  // recent bytes and drops older ones, so total lifetime output is unbounded
  // while the retained result stays finite.
  const stdoutTail = new BufferTail(MAX_RESULT_STREAM_BYTES);
  const stderrTail = new BufferTail(MAX_RESULT_STREAM_BYTES);
  let inputClosed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startedTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelRequested = false;
  let cancelling: Promise<void> | undefined;
  let terminating: Promise<void> | undefined;
  let cleaned: Promise<void> | undefined;
  let resolveStarted!: (session: ExecutionSession) => void;
  let rejectStarted!: (error: Error) => void;
  const startOutcome = new Promise<ExecutionSession>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const session: ExecutionSession = { events: queue, result, write, closeInput, cancel, diagnostics: {} };

  const clearTimers = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (startedTimer) { clearTimeout(startedTimer); startedTimer = undefined; }
  };
  /**
   * Idempotent, bounded tree termination of the child this session spawned.
   *
   * A tree that cannot be confirmed gone is NOT reported as a clean cleanup:
   * the rejection is retained and re-thrown to `cancel`, so the caller learns
   * that an owned process may still be alive instead of seeing a silent
   * success. A child whose normal exit already arrived needs no kill, and the
   * `closed` snapshot gives that check the same ordering the native `close`
   * event had.
   */
  const terminateProcessTree = (): Promise<void> => {
    if (terminating) return terminating;
    terminating = (async () => {
      const childPid = child?.pid;
      if (!childPid || (closed && !killRequested)) return;
      await withTimeoutResolved(killProcessTree(childPid), TERMINATION_FALLBACK_MS, `process tree ${childPid} was not confirmed terminated`);
    })();
    // Retain the rejection for this session's callers without leaving an
    // unhandled rejection on the shared promise.
    terminating.catch(() => undefined);
    return terminating;
  };
  const cleanupOwnedResources = (success: boolean): Promise<void> => {
    if (cleaned) return cleaned;
    cleaned = cleanupFiles(resources, success, !started);
    return cleaned;
  };

  /** Bounded retained tails, decoded once and independently per stream. */
  const decodeTails = (): { stdout: string; stderr: string } => {
    // One shared decoder cannot span both streams, so each tail is decoded by
    // its own decoder; a partial multi-byte rune at either end is dropped
    // rather than replacing the whole result with U+FFFD.
    return { stdout: stdoutTail.toString(), stderr: stderrTail.toString() };
  };

  // Terminal emission bypasses the queue bound but never the tail reservation,
  // so the closing error/exit pair survives a queue that filled up mid-run.
  const acceptTerminal = (event: ExecutionEvent) => { queue.forcePush(event); };
  /**
   * Publish terminal state only after the owned process and resources are
   * released. `cleanupFailure` distinguishes a resource/tree release problem
   * from a plain exit so the frame still carries the real exit facts.
   */
  const settle = (value: ExecutionResult, success: boolean, errorMessage?: string) => {
    if (terminal) return;
    terminal = true;
    clearTimers();
    options.signal?.removeEventListener('abort', onAbort);
    const exitEvent: ExecutionEvent = { type: 'exit', exitCode: value.exitCode, signal: value.signal };
    void (async () => {
      let cleanupFailure: string | undefined;
      try {
        await terminateProcessTree();
      } catch (error) {
        cleanupFailure = `process-tree cleanup failed: ${errorMessageOf(error)}`;
      }
      await cleanupOwnedResources(success).catch(() => undefined);
      removeTreeListeners();
      const message = [errorMessage, cleanupFailure].filter(Boolean).join('; ') || undefined;
      if (message) acceptTerminal({ type: 'error', message });
      acceptTerminal(exitEvent);
      queue.close();
      resolveResult(value);
      if (!started) rejectStarted(new Error(message ?? 'execution ended before process start'));
    })();
  };
  const accept = (event: ExecutionEvent): boolean => {
    if (terminal) return false;
    const ok = queue.push(event);
    if (!ok) fail('process event queue overflow');
    return ok;
  };
  const finishExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    const { stdout, stderr } = decodeTails();
    settle({ stdout, stderr, exitCode, signal }, exitCode === 0);
  };
  const fail = (message: string) => {
    const { stdout, stderr } = decodeTails();
    settle({ stdout, stderr, exitCode: childExitCode, signal: childSignal }, false, message);
  };
  /** `started` is emitted on the spawn event, never on pid presence. */
  const confirmStarted = (pid: number | undefined) => {
    if (started) return;
    started = true;
    if (startedTimer) { clearTimeout(startedTimer); startedTimer = undefined; }
    if (pid !== undefined) session.diagnostics.pid = pid;
    // A child that closed before confirmation still gets its `started` frame
    // first, so consumers never observe output or a terminal frame first.
    accept({ type: 'started', ...(pid === undefined ? {} : { pid }) });
    resolveStarted(session);
  };

  // Raw stdin forwarding; the caller owns framing.
  function write(data: string | Uint8Array) {
    if (inputClosed || terminal) return;
    const sink = child?.stdin;
    if (!sink || sink.destroyed) { fail('process input is not available'); return; }
    sink.write(data, (error) => { if (error) fail('process input write failed'); });
  }
  function closeInput() {
    if (inputClosed || terminal) return;
    inputClosed = true;
    child?.stdin?.end();
  }
  /**
   * Owned-process cleanup that the caller can await. Terminates the child's
   * process tree and returns only once the session has actually reached a
   * terminal state. A tree that could not be confirmed dead rejects rather
   * than being swallowed into a successful cleanup.
   */
  function cancel(): Promise<void> {
    cancelling ??= (async () => {
      cancelRequested = true;
      killRequested = true;
      if (!terminal) fail('execution cancelled');
      await result;
      // `result` is published after termination was attempted; surface a real
      // cleanup failure now that the session is boundedly terminal.
      await terminateProcessTree();
    })();
    cancelling.catch(() => undefined);
    return cancelling;
  }
  const onAbort = () => { void cancel(); };

  /**
   * Event emission is unbounded in total: a child may stream for hours. Extra
   * output is never turned into a failure here — the queue reports its own
   * overflow, and the retained result tails evict oldest-first.
   */
  function applyStdout(chunk: Buffer) {
    if (terminal) return;
    stdoutTail.push(chunk);
    accept({ type: 'stdout', data: chunk });
  }
  function applyStderr(chunk: Buffer) {
    if (terminal) return;
    stderrTail.push(chunk);
    accept({ type: 'stderr', data: chunk });
  }

  let child: ChildProcess | undefined;
  try {
    // The launch environment is the one the caller already composed in
    // `spec.env`. It is the FINAL environment: gateway endpoints, MCP wiring,
    // and native client configuration live there, so neither a task-level
    // `options.env` nor the ambient process environment may replace it.
    // `options.env` only contributes Windows' ComSpec for cmd-shim launches.
    child = spawnProcess(spec.executable, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  }
  catch (error) {
    settle({ stdout: '', stderr: '', exitCode: null, signal: null }, false, errorMessageOf(error) || 'execution process could not start');
    return await startOutcome;
  }

  removeTreeListeners = () => {
    child?.stdout?.removeAllListeners('data');
    child?.stderr?.removeAllListeners('data');
  };
  child.stdout?.on('data', applyStdout);
  child.stdout?.on('error', () => fail('process stdout read failed'));
  child.stdin?.on('error', () => fail('process stdin write failed'));
  // Child stderr is drained so the pipe cannot stall the child; it is both
  // emitted as its own bounded event (consumers render it as diagnostics) and
  // retained in the result tail.
  child.stderr?.on('data', applyStderr);
  child.stderr?.on('error', () => { /* drained and discarded; a read error is not fatal */ });
  // The `spawn` event is the only proof the child launched: a synchronous pid
  // is not (Node assigns one before exec'ing the target), and 'close' can
  // arrive first for a child that exits immediately.
  child.once('spawn', () => { confirmStarted(child?.pid); });
  child.once('error', (error: Error) => {
    lastStartError = error;
    // 'error' alone does not mean the child never ran: an exec failure is
    // followed by 'close' (possibly with a nonzero code), while a later stream
    // failure has already confirmed the spawn and must not be re-labelled.
    if (!started && !closed) fail(error.message);
  });
  child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (terminal) return;
    closed = true;
    childExitCode = exitCode;
    childSignal = signal;
    // The child launched and already ended: publish the start it never got to
    // confirm, then report its real exit facts.
    if (!started) confirmStarted(child?.pid);
    if (lastStartError && exitCode === null && signal === null) { fail(lastStartError.message); return; }
    finishExit(exitCode, signal);
  });

  if (options.signal) {
    if (options.signal.aborted) void cancel();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs) {
    timer = setTimeout(() => {
      if (terminal) return;
      cancelRequested = true;
      killRequested = true;
      fail('execution timed out');
    }, timeoutMs);
  }
  startedTimer = setTimeout(() => {
    if (terminal) return;
    // Neither 'spawn' nor 'error' ever fired; this fallback bounds a child that
    // never reports either way. The stderr tail is still offered as context.
    fail(controlErrorTail(stderrTail.toString()) ?? 'execution process did not start');
  }, timeoutMs ?? STARTUP_CONFIRM_MS);

  if (spec.stdin !== undefined) {
    // `started` may not have been confirmed yet; the write queues on the pipe
    // and is flushed once the child's stdio exists.
    write(spec.stdin);
    closeInput();
  }

  return await startOutcome;
}

/** Owned resource record: what this invocation created, and what it overwrote. */
interface OwnedFile {
  readonly path: string;
  /** Snapshot of preexisting contents that cleanup must restore instead of deleting. */
  readonly previous?: Buffer;
  /** Per-file cleanup policy; undefined means the file is persistent. */
  readonly cleanup?: ProcessFile['cleanup'];
}

/**
 * Materialize each owned file and report what this invocation actually created
 * versus what it overwrote, so cleanup never removes a preexisting resource.
 * A failed write restores/removes only the partial state of this invocation.
 */
async function materializeFiles(files: readonly ProcessFile[]): Promise<OwnedFile[]> {
  const owned: OwnedFile[] = [];
  const paths = new Set<string>();
  for (const { path } of files) {
    if (!path || path.includes('\0') || !isAbsolute(path) || paths.has(path)) {
      throw new Error('Execution files require unique absolute paths');
    }
    paths.add(path);
  }
  try {
    for (const file of files) {
      const path = file.path;
      let previous: Buffer | undefined;
      try { previous = await readFile(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(path), { recursive: true });
      owned.push({ path, previous, cleanup: file.cleanup });
      await writeFile(path, file.data, { mode: 0o600 });
    }
  } catch (error) {
    await cleanupFiles(owned, false, true);
    throw error;
  }
  return owned;
}

/** Remove only resources this session may release; never a parent directory. */
async function cleanupFiles(owned: readonly OwnedFile[], success: boolean, rollback = false): Promise<void> {
  for (const file of owned) {
    // Unspecified file policy stays persistent; 'success' keeps failures intact
    // for inspection while all other failure/cancel paths release the resource.
    const release = rollback || file.cleanup === 'completion' || (file.cleanup === 'success' && success);
    if (!release) continue;
    // A preexisting file that was overwritten for this run has its prior
    // contents restored; a file this invocation created is removed.
    if (file.previous) await writeFile(file.path, file.previous).catch(() => undefined);
    else await rm(file.path, { force: true }).catch(() => undefined);
  }
}

function controlErrorTail(stderrTail: string): string | undefined {
  if (!stderrTail) return undefined;
  const code = stderrTail.match(/"code"\s*:\s*"([A-Za-z0-9_-]+)"/u);
  return code ? `execution process failed: ${code[1]}` : undefined;
}

/**
 * Await `promise`, but never longer than `ms`. A rejection — including the
 * termination confirmation itself failing — propagates so callers cannot
 * mistake an unconfirmed cleanup for a successful one; only the timeout is
 * surfaced as a rejection with `timeoutMessage`.
 */
function withTimeoutResolved<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fixed-size tail of the most recent bytes of one output stream.
 *
 * A long-running child may emit arbitrarily more than its result should retain;
 * keeping the newest `maxBytes` and dropping the oldest honours the ceiling
 * without ever failing the run for having produced output, and never mutates a
 * chunk in flight, so emitted event data stays byte-exact.
 */
class BufferTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.maxBytes) {
      // The chunk alone exceeds the ceiling: keep only its trailing bytes.
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.bytes = this.maxBytes;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]!;
      const excess = this.bytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  /** Decode the retained bytes as UTF-8, skipping a rune split by the cut. */
  toString(): string {
    if (this.bytes === 0) return '';
    const bytes = Buffer.concat(this.chunks);
    return bytes.subarray(utf8BoundaryAfter(bytes)).toString('utf8');
  }
}

/**
 * Index of the first byte that begins a decodable UTF-8 rune.
 *
 * The retained tail may start inside a multi-byte rune (the eviction cut is on
 * a byte boundary, not a character one). At most the first three bytes can be
 * orphaned continuation bytes — a maximal rune is four bytes — so scanning
 * those three is enough to find the first real boundary. A buffer made entirely
 * of continuation bytes has no decodable rune left and reports its end.
 */
function utf8BoundaryAfter(bytes: Buffer): number {
  const limit = Math.min(4, bytes.length);
  for (let index = 0; index < limit; index += 1) {
    // A continuation byte (10xxxxxx) cannot start a rune; the first byte that
    // is not one starts a rune (or is past the end of the buffer).
    if (((bytes[index] ?? 0) & 0xc0) !== 0x80) return index;
  }
  return bytes.length;
}

function createQueue<T>(limit: number): AsyncIterable<T> & { push(value: T): boolean; forcePush(value: T): void; close(): void } {
  const items: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(value: T) {
      if (closed) return false;
      // The terminal tail is never consumed by ordinary events, so a full queue
      // can never drop a terminal frame.
      if (items.length >= limit - RESERVED_TERMINAL_EVENTS && waiters.length === 0) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else items.push(value);
      return true;
    },
    forcePush(value: T) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else items.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as T, done: true });
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        const next = await new Promise<IteratorResult<T>>((resolve) => { waiters.push(resolve); });
        if (next.done) return;
        yield next.value;
      }
    },
  };
}
