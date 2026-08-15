import { createConnection, type Socket } from "node:net";

export type WrenyardIpcEnvironment = NodeJS.ProcessEnv;

/**
 * Shared default control socket for the Wrenyard daemon. Every Wrenyard
 * surface (control-client, dsh-shell, desktop, pet) uses this same default so
 * the legacy per-surface socket mismatch is gone.
 */
export function defaultWrenyardIpcPath(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\wrenyard.sock"
    : "/tmp/wrenyard.sock";
}

/**
 * Resolve the Wrenyard NDJSON IPC socket path. `WRENYARD_IPC_PATH` is
 * primary; the legacy `FOREMAN_IPC_PATH` and `FOREMAN_PET_FOREMAN_IPC`
 * variables are still read as fallbacks, and the shared `wrenyard.sock`
 * default is used when none are set.
 */
export function resolveWrenyardIpcPath(
  env: WrenyardIpcEnvironment = process.env,
): string {
  return (
    env.WRENYARD_IPC_PATH ??
    env.FOREMAN_IPC_PATH ??
    env.FOREMAN_PET_FOREMAN_IPC ??
    defaultWrenyardIpcPath()
  );
}

export interface WrenyardIpcClientOptions {
  /** Filesystem path of the control socket. */
  path: string;
  /** Default timeout per request in milliseconds. */
  requestTimeoutMs?: number;
}

export interface WrenyardIpcRequestOptions {
  /** Timeout in milliseconds for this request, overriding the client default. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

/** Error raised when the peer returns a JSON-RPC error reply. */
export class WrenyardRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "WrenyardRpcError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

/**
 * Dependency-free NDJSON JSON-RPC 2.0 client over a node:net socket.
 * Frames are newline-delimited; partial frames are buffered until complete.
 */
export class WrenyardIpcClient {
  private readonly socketPath: string;
  private readonly socket: Socket;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(options: WrenyardIpcClientOptions) {
    this.socketPath = options.path;
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;

    this.socket = createConnection(this.socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.handleData(chunk));
    this.socket.on("error", (error: Error) => this.handleError(error));
    this.socket.on("close", () => this.handleClose());
  }

  /** The socket endpoint this client is connected to. */
  get endpoint(): string {
    return this.socketPath;
  }

  /** Send a JSON-RPC request and resolve with the response result. */
  request<TResult>(
    method: string,
    params?: unknown,
    options?: WrenyardIpcRequestOptions,
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(new Error("WrenyardIpcClient is closed"));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params === undefined ? {} : params,
    });

    return new Promise<TResult>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Wrenyard RPC request timed out after ${timeoutMs}ms (method: ${method})`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => resolve(result as TResult),
        reject,
        timer,
      });

      this.socket.write(payload + "\n");
    });
  }

  /** Destroy the socket and reject every request still awaiting a reply. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.settlePending(new Error("WrenyardIpcClient closed before response"));
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const frame = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {
    if (frame.trim() === "") return;

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(frame) as JsonRpcResponse;
    } catch {
      // Malformed frames are ignored; the connection stays healthy.
      return;
    }

    if (message.id === undefined || message.id === null) {
      return; // Notifications have no id; nothing to settle.
    }

    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error !== undefined && message.error !== null) {
      pending.reject(
        new WrenyardRpcError(
          message.error.code ?? 0,
          message.error.message ?? "Wrenyard RPC error",
          message.error.data,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleError(error: Error): void {
    this.settlePending(error);
  }

  private handleClose(): void {
    this.settlePending(new Error("Wrenyard IPC connection closed"));
  }

  private settlePending(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// ── Deprecated legacy aliases (pre-Wrenyard naming) ────────────────────────

/** @deprecated Use WrenyardIpcClient. */
export const ForemanIpcClient = WrenyardIpcClient;
/** @deprecated Use WrenyardRpcError. */
export const ForemanRpcError = WrenyardRpcError;
/** @deprecated Use resolveWrenyardIpcPath. */
export const resolveForemanIpcPath = resolveWrenyardIpcPath;
/** @deprecated Use WrenyardIpcEnvironment. */
export type ForemanIpcEnvironment = WrenyardIpcEnvironment;
/** @deprecated Use WrenyardIpcClientOptions. */
export type ForemanIpcClientOptions = WrenyardIpcClientOptions;
/** @deprecated Use WrenyardIpcRequestOptions. */
export type ForemanIpcRequestOptions = WrenyardIpcRequestOptions;
