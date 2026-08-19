import { spawn, type ChildProcess } from 'node:child_process';
import { parseWebUrl } from './profile.js';

const MAX_STDERR_BUFFER = 8 * 1024;
const READINESS_HTTP_TIMEOUT_MS = 5_000;

/**
 * Derive the Wrenyard connection context from an environment. WRENYARD_* names
 * are primary; the legacy FOREMAN_* names are still read as fallbacks.
 */
export function resolveWrenyardConnectionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const ipc = env.WRENYARD_IPC_PATH ?? env.FOREMAN_IPC_PATH;
  if (ipc) out.WRENYARD_IPC_PATH = ipc;
  const mcpUrl = env.WRENYARD_MCP_URL ?? env.FOREMAN_MCP_URL;
  if (mcpUrl) out.WRENYARD_MCP_URL = mcpUrl;
  const sender = env.WRENYARD_MCP_SENDER ?? env.FOREMAN_MCP_SENDER;
  if (sender) out.WRENYARD_MCP_SENDER = sender;
  return out;
}

export interface DshWebOptions {
  /** Absolute path to @deepseek-ai/dsh/lib/bin.js. */
  binPath: string;
  /** Isolated DSH_HOME produced by prepareProfile(). */
  profileHome: string;
  /** Working directory for the DSH child. */
  workspace: string;
  /** Loopback bind host; defaults to 127.0.0.1. */
  host?: string;
  /** Port; 0 lets DSH pick an ephemeral port. */
  port?: number;
  /** Launch under the Electron executable (sets ELECTRON_RUN_AS_NODE=1). */
  runAsElectron?: boolean;
  /** Injected runner/command for tests, e.g. [process.execPath, '/tmp/fake']. */
  command?: readonly string[];
  /** Explicit Wrenyard connection env to propagate; overrides process.env. */
  wrenyardEnv?: NodeJS.ProcessEnv;
  /** Secret-free DSH loader overlay passed as the last `--patch` layer. */
  patchPath?: string;
  /**
   * Extra child env (credential values for injected llm-pi-ai routes).
   * Merged last and never logged.
   */
  extraEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DshWebHandle {
  url: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Start the DSH web child. Resolves only after the exact loopback URL line is
 * parsed and HTTP GET / returns 2xx; rejects with bounded stderr on timeout,
 * early exit or abort, and always terminates the child process tree.
 */
export function startDshWeb(options: DshWebOptions): Promise<DshWebHandle> {
  return new Promise<DshWebHandle>((resolve, reject) => {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const runAsElectron = options.runAsElectron ?? Boolean(process.versions.electron);
    // Launcher flags (--profile, --patch) must precede web-app flags
    // (--host, --port). dsh 0.1.0-rc.6 treats everything after the first
    // app flag as web argv; `--patch` after `--host` is `unknown option`
    // and the child exits 1 before ready — Desktop then flash-quits.
    const args = ['--profile', 'web'];
    if (options.patchPath) args.push('--patch', options.patchPath);
    args.push('--host', host, '--port', String(port));

    const injected = options.command && options.command.length > 0 ? options.command : null;
    const program = injected ? injected[0] : process.execPath;
    const programArgs = injected ? [...injected.slice(1), ...args] : [options.binPath, ...args];

    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: options.profileHome };
    if (runAsElectron) env.ELECTRON_RUN_AS_NODE = '1';
    // Propagate the Wrenyard connection context to the child without logging
    // values; explicit overrides win (LaunchServices supplies no shell env).
    Object.assign(env, resolveWrenyardConnectionEnv(), options.wrenyardEnv, options.extraEnv);

    const child = spawn(program, programArgs, {
      cwd: options.workspace,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let settled = false;
    let killing = false;
    let stopPromise: Promise<void> | null = null;
    let stderrTail = '';
    let stdoutTail = '';

    function boundedStderr(): string {
      return stderrTail.length > 0 ? stderrTail : '(no stderr captured)';
    }

    /**
     * Idempotent stop: concurrent callers share a single promise that resolves
     * only after the whole child tree has been drained.
     */
    const stop = (): Promise<void> => {
      if (!stopPromise) {
        killing = true;
        clearTimeout(timer);
        stopPromise = killTree(child);
      }
      return stopPromise;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop().then(() => {
        reject(new Error(`DSH web did not become ready within ${timeoutMs}ms. stderr:\n${boundedStderr()}`));
      });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-32 * 1024);
      scanReadiness();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_BUFFER);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (settled || killing) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`DSH web exited before ready (code=${code}, signal=${signal}). stderr:\n${boundedStderr()}`));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        settled = true;
        void stop().then(() => {
          reject(new Error('DSH web start aborted'));
        });
      } else {
        options.signal.addEventListener(
          'abort',
          () => {
            if (settled || killing) return;
            settled = true;
            clearTimeout(timer);
            void stop().then(() => {
              reject(new Error('DSH web start aborted'));
            });
          },
          { once: true },
        );
      }
    }

    function scanReadiness(): void {
      if (settled) return;
      for (const line of stdoutTail.split(/\r?\n/)) {
        const parsed = parseWebUrl(line);
        if (parsed) {
          void verifyReady(new URL(parsed.origin));
          return;
        }
      }
    }

    async function verifyReady(base: URL): Promise<void> {
      if (settled) return;
      const controller = new AbortController();
      let httpTimer: NodeJS.Timeout | undefined;
      try {
        httpTimer = setTimeout(() => controller.abort(), READINESS_HTTP_TIMEOUT_MS);
        const response = await fetch(base, { signal: controller.signal });
        if (!settled && response.ok) {
          settled = true;
          clearTimeout(timer);
          resolve({ url: base.origin, child, stop });
        }
      } catch {
        // Server not answerable yet; readiness is re-checked on further output
        // or the outer start timeout will reject.
      } finally {
        if (httpTimer) clearTimeout(httpTimer);
      }
    }
  });
}

/** Bounded grace period for the direct child to exit before force escalation. */
const STOP_GRACE_MS = 2_000;

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolve when the direct child has exited/closed, or after `graceMs` even if
 * it is still alive. Already-exited children resolve immediately.
 */
function awaitChildExit(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    if (childExited(child)) {
      resolveWait();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(exitTimer);
      child.off('exit', onExit);
      child.off('close', onClose);
      resolveWait();
    };
    const onExit = () => finish();
    const onClose = () => finish();
    const exitTimer = setTimeout(finish, graceMs);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

/** Signal the detached process group, falling back to the direct child. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Terminate the child and its process tree and wait for the direct child to
 * exit. POSIX: SIGTERM to the detached process group, wait up to STOP_GRACE_MS,
 * then SIGKILL to the group and wait again if still alive. Windows: taskkill
 * /T /F, then wait for child termination. Already-exited or missing processes
 * count as success.
 */
export function killTree(child: ChildProcess, graceMs = STOP_GRACE_MS): Promise<void> {
  return new Promise((resolveKill) => {
    if (!child.pid) {
      resolveKill();
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
      const settle = () => void awaitChildExit(child, graceMs).then(resolveKill);
      killer.once('exit', settle);
      killer.once('error', () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        settle();
      });
    } else {
      signalGroup(child, 'SIGTERM');
      void awaitChildExit(child, graceMs).then(() => {
        if (childExited(child)) {
          resolveKill();
        } else {
          signalGroup(child, 'SIGKILL');
          void awaitChildExit(child, graceMs).then(resolveKill);
        }
      });
    }
  });
}
