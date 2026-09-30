import { WrenyardIpcClient, resolveWrenyardIpcPath } from '@wrenyard/control-client';

export interface ForemanIpcRequestOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2000;

export interface ForemanIpcClientOptions {
  path?: string;
  timeoutMs?: number;
}

/**
 * Resolve the Wrenyard NDJSON IPC socket path. Delegates to the canonical
 * control-client resolver so every surface shares one default; the path comes
 * only from WRENYARD_IPC_PATH or the platform default.
 */
export function resolveForemanIpcPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWrenyardIpcPath(env);
}

/**
 * Thin reconnecting wrapper around the canonical `@wrenyard/control-client`
 * NDJSON transport. The shared client owns socket framing and the
 * version-checked `health.ping` handshake; this wrapper only preserves the Pet
 * client's public surface and lazily reconnects after a transport failure. A
 * failed request is never retried automatically.
 */
export class ForemanIpcClient {
  private readonly path: string;
  private readonly timeoutMs: number;
  private client: WrenyardIpcClient | null = null;

  constructor(options: ForemanIpcClientOptions = {}) {
    this.path = options.path ?? resolveForemanIpcPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get endpoint(): string {
    return this.path;
  }

  async request(method: string, params?: unknown, options?: ForemanIpcRequestOptions): Promise<unknown> {
    const client = this.ensureClient();
    try {
      return await client.request(method, params, {
        timeoutMs: options?.timeoutMs ?? this.timeoutMs,
      });
    } catch (error) {
      // A dead socket must not be reused: the next request reconnects. The
      // failed request itself is never retried.
      if (isTransportFailure(error)) this.reset();
      throw error;
    }
  }

  close(_error?: Error): void {
    this.reset();
  }

  private ensureClient(): WrenyardIpcClient {
    if (!this.path) throw new Error('Foreman IPC path is not configured');
    this.client ??= new WrenyardIpcClient({
      path: this.path,
      requestTimeoutMs: this.timeoutMs,
    });
    return this.client;
  }

  private reset(): void {
    this.client?.close();
    this.client = null;
  }
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /closed|connection|socket|ECONNREFUSED|EPIPE/i.test(error.message);
}
