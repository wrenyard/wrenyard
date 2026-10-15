import { WrenyardIpcClient, resolveWrenyardIpcPath } from '@wrenyard/control';
import { StaleGenerationError } from '../remote/context.js';

/** Extra request options accepted by the shared daemon transport. */
export interface DaemonRequestOptions {
  /** `null` disables the transport deadline (long-running waits). */
  timeoutMs?: number | null;
}

/**
 * Uniform request surface every shared Desktop subscription rides on. It wraps
 * the canonical `@wrenyard/control` NDJSON transport so Desktop has one
 * RPC implementation instead of the former Pet-owned socket client.
 */
export interface DaemonClient {
  readonly endpoint: string;
  request<TResult = unknown>(method: string, params?: unknown, options?: DaemonRequestOptions): Promise<TResult>;
  /** Retarget the transport to the active endpoint, dropping the live socket. */
  setPath(path: string): void;
  /** Drop a connection whose identity/socket changed (e.g. daemon restart). */
  reset(): void;
  close(): void;
}

export interface DaemonClientOptions {
  path?: string;
  canConnect?: () => boolean;
  /** Default transport deadline for ordinary requests. */
  requestTimeoutMs?: number;
  /**
   * Active connection generation. It is captured before each request and
   * re-checked once the reply resolves, so a result produced on the previous
   * endpoint is discarded instead of being applied to the new context.
   */
  getGeneration?: () => number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Single-transport daemon client. The underlying socket reconnects lazily on
 * the next request after a failure, preserving the previous behaviour of the
 * Pet pollers while reusing the shared control-client protocol.
 */
export class WrenyardDaemonClient implements DaemonClient {
  private path: string;
  private readonly requestTimeoutMs: number;
  private client: WrenyardIpcClient | null = null;
  private readonly canConnect: () => boolean;
  private readonly getGeneration: (() => number) | undefined;

  constructor(options: DaemonClientOptions = {}) {
    this.path = options.path ?? resolveWrenyardIpcPath();
    this.canConnect = options.canConnect ?? (() => true);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.getGeneration = options.getGeneration;
  }

  get endpoint(): string {
    return this.path;
  }

  /**
   * Retarget the transport. A changed path is a different daemon, so the live
   * socket is dropped rather than reused across the switch. The stable Desktop
   * bridge path usually does not change on a context switch; the bridge drops
   * the live sockets itself, and a superseded generation is fenced per request.
   */
  setPath(path: string): void {
    if (this.path === path) return;
    this.path = path;
    this.reset();
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: DaemonRequestOptions,
  ): Promise<TResult> {
    if (!this.canConnect()) {
      this.reset();
      throw new Error('daemon 不可用');
    }
    const generation = this.getGeneration?.();
    const client = this.ensureClient();
    const timeoutMs = options?.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    try {
      const result = await client.request<TResult>(
        method,
        params,
        timeoutMs === null ? { timeoutMs: null } : { timeoutMs },
      );
      // A switch that committed while this request was in flight makes the reply
      // belong to the previous endpoint: drop it instead of returning it.
      if (generation !== undefined && this.getGeneration?.() !== generation) {
        throw new StaleGenerationError('连接上下文已切换，忽略过期结果');
      }
      return result;
    } catch (error) {
      // A dead socket must not be reused: the next request reconnects.
      if (this.client === client && isTransportFailure(error)) this.reset();
      throw error;
    }
  }

  reset(): void {
    this.client?.close();
    this.client = null;
  }

  close(): void {
    this.reset();
  }

  private ensureClient(): WrenyardIpcClient {
    if (!this.client) {
      this.client = new WrenyardIpcClient({
        path: this.path,
        requestTimeoutMs: this.requestTimeoutMs,
      });
    }
    return this.client;
  }
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /closed|connection|socket|ECONNREFUSED|EPIPE/i.test(error.message);
}

/** Resolve the daemon socket path exactly as the Desktop runtime does. */
export function resolveDaemonIpcPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWrenyardIpcPath(env);
}
