import { WrenyardIpcClient, resolveWrenyardIpcPath } from '@wrenyard/control-client';

/** Extra request options accepted by the shared daemon transport. */
export interface DaemonRequestOptions {
  /** `null` disables the transport deadline (long-running waits). */
  timeoutMs?: number | null;
}

/**
 * Uniform request surface every shared Desktop subscription rides on. It wraps
 * the canonical `@wrenyard/control-client` NDJSON transport so Desktop has one
 * RPC implementation instead of the former Pet-owned socket client.
 */
export interface DaemonClient {
  readonly endpoint: string;
  request<TResult = unknown>(method: string, params?: unknown, options?: DaemonRequestOptions): Promise<TResult>;
  /** Drop a connection whose identity/socket changed (e.g. daemon restart). */
  reset(): void;
  close(): void;
}

export interface DaemonClientOptions {
  path?: string;
  /** Default transport deadline for ordinary requests. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Single-transport daemon client. The underlying socket reconnects lazily on
 * the next request after a failure, preserving the previous behaviour of the
 * Pet pollers while reusing the shared control-client protocol.
 */
export class WrenyardDaemonClient implements DaemonClient {
  private readonly path: string;
  private readonly requestTimeoutMs: number;
  private client: WrenyardIpcClient | null = null;

  constructor(options: DaemonClientOptions = {}) {
    this.path = options.path ?? resolveWrenyardIpcPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get endpoint(): string {
    return this.path;
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: DaemonRequestOptions,
  ): Promise<TResult> {
    const client = this.ensureClient();
    const timeoutMs = options?.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    try {
      return await client.request<TResult>(
        method,
        params,
        timeoutMs === null ? { timeoutMs: null } : { timeoutMs },
      );
    } catch (error) {
      // A dead socket must not be reused: the next request reconnects.
      if (isTransportFailure(error)) this.reset();
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
