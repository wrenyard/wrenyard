import * as net from 'node:net';

export interface ForemanIpcRequestOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2000;

export interface ForemanIpcClientOptions {
  path?: string;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Resolve the Wrenyard NDJSON IPC socket path. WRENYARD_IPC_PATH is primary;
 * the legacy FOREMAN_IPC_PATH and FOREMAN_PET_FOREMAN_IPC variables are still
 * read as safe legacy fallbacks, and the shared `wrenyard.sock` default is
 * used when none are set.
 */
export function resolveForemanIpcPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (
    env['WRENYARD_IPC_PATH'] ||
    env['FOREMAN_IPC_PATH'] ||
    env['FOREMAN_PET_FOREMAN_IPC'] ||
    ''
  ).trim();
  if (explicit) return explicit;
  return process.platform === 'win32' ? '\\\\.\\pipe\\wrenyard.sock' : '/tmp/wrenyard.sock';
}

export class ForemanIpcClient {
  private readonly path: string;
  private readonly timeoutMs: number;
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: ForemanIpcClientOptions = {}) {
    this.path = options.path ?? resolveForemanIpcPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get endpoint(): string {
    return this.path;
  }

  async request(method: string, params?: unknown, options?: ForemanIpcRequestOptions): Promise<unknown> {
    if (!this.path) {
      throw new Error('Foreman IPC path is not configured');
    }

    const socket = await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
      id,
    }) + '\n';

    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Foreman IPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      socket.write(payload, (error) => {
        if (!error) return;
        this.rejectPending(id, error);
      });
    });
  }

  close(error = new Error('Foreman IPC client closed')): void {
    this.rejectAll(error);
    this.socket?.destroy();
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
  }

  private async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.path);
      const handleConnect = (): void => {
        socket.off('error', handleError);
        this.socket = socket;
        this.connecting = null;
        resolve(socket);
      };
      const handleError = (error: Error): void => {
        socket.off('connect', handleConnect);
        this.connecting = null;
        reject(error);
      };

      socket.once('connect', handleConnect);
      socket.once('error', handleError);
      socket.on('data', (chunk) => this.handleData(chunk));
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this.buffer = '';
        }
        this.rejectAll(new Error('Foreman IPC connection closed'));
      });
    });

    return this.connecting;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.id !== 'number') return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (Object.prototype.hasOwnProperty.call(message, 'error')) {
      const error = isRecord(message.error) && typeof message.error.message === 'string'
        ? new Error(message.error.message)
        : new Error('Foreman IPC request failed');
      pending.reject(error);
      return;
    }

    pending.resolve(message.result);
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
