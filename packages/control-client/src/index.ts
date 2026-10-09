import type { ProviderListResult, ProviderQuotaResult, ProviderListModel } from '@wrenyard/protocol/provider';
import { createConnection, type Socket } from "node:net";
import { protocolVersionMismatchMessage, WRENYARD_PROTOCOL_VERSION } from "./transport/index.ts";

/**
 * Canonical Wrenyard IPC protocol version, re-exported from the transport
 * module so `@wrenyard/control-client` and `@wrenyard/control-client/transport`
 * share exactly one definition.
 */
export { WRENYARD_PROTOCOL_VERSION } from "./transport/index.ts";

export type WrenyardIpcEnvironment = NodeJS.ProcessEnv;

/**
 * Shared default control socket for the Wrenyard daemon. Every Wrenyard
 * surface (control-client, desktop, pet) uses this same default so
 * the legacy per-surface socket mismatch is gone.
 */
export function defaultWrenyardIpcPath(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\wrenyard"
    : "/tmp/wrenyard.sock";
}

/**
 * Resolve the Wrenyard NDJSON IPC socket path. `WRENYARD_IPC_PATH` overrides
 * the platform default when set to a non-blank value. Without an override,
 * Windows uses the daemon's `\\.\pipe\wrenyard` named pipe and Unix uses
 * `/tmp/wrenyard.sock`.
 */
export function resolveWrenyardIpcPath(
  env: WrenyardIpcEnvironment = process.env,
): string {
  const path = env.WRENYARD_IPC_PATH?.trim();
  if (path) return path;
  return defaultWrenyardIpcPath();
}

export interface WrenyardIpcClientOptions {
  /** Filesystem path of the control socket. */
  path: string;
  /** Default timeout per request in milliseconds. */
  requestTimeoutMs?: number;
}

export interface WrenyardIpcRequestOptions {
  /** Timeout in milliseconds for this request, overriding the client default. Pass null to disable the transport deadline. */
  timeoutMs?: number | null;
}

/** USD per million tokens: [cached, input, output]. */
export type WrenyardGatewayModelPricing = readonly [number, number, number];

export interface WrenyardGatewayModel {
  id: string;
  publicId: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  taskOnly?: boolean;
  family?: 'claude';
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
  intelligence: 'low' | 'mid' | 'high' | 'premium';
  maxOutputTokens?: number;
  capabilities?: readonly ('text' | 'image')[];
  /**
   * The legal reasoning efforts this model accepts, in ascending intensity.
   * Replaces the legacy fixed `reasoningEffort` field on the public gateway
   * contract; every route declares a non-empty ladder.
   */
  reasoningEfforts: ProviderListModel['reasoningEfforts'];
  routeState?: 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'model_unavailable';
  routeUntil?: string;
  speed?: number;
  pricing?: WrenyardGatewayModelPricing;
}

export interface WrenyardGatewayConnection {
  openaiChatBaseUrl: string;
  openaiResponsesBaseUrl: string;
  anthropicBaseUrl: string;
  token: string;
  models: WrenyardGatewayModel[];
}

/**
 * Terminal result returned by `task.run.wait`. This reuses the same completion
 * envelope as the Foreman `TaskRunOutputResult` protocol type; do not invent a
 * second envelope. Desktop and other control-client consumers read this shape
 * directly, with `output`/`error`/`failure_category` carrying the full
 * terminal metadata for done/failed/cancelled/interrupted runs.
 *
 * `task_id` (the persisted definition template) and `usage` are required;
 * `resolved` is present only when the run has a schema-valid dispatch snapshot.
 * `task_name` is the authoritative definition display name the server
 * resolves from its registry; it is optional and absent rather than guessed
 * when the definition cannot be resolved.
 */
export interface WrenyardTaskRunOutputResult {
  task_run_id: string;
  task_id: string;
  /** Authoritative definition display name (builtin or project), sent only
   * when the daemon's registry can resolve it. */
  task_name?: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  summary?: string;
  output: unknown;
  error?: string | null;
  failure_category?: string;
  suggestion?: string;
  error_message?: string;
  pid?: number;
  resolved?: WrenyardTaskResolvedDispatch;
  usage: WrenyardTaskUsage;
  _meta?: Record<string, unknown>;
}

/** Mirrors the frozen snake_case wire DTO `TaskReferencePricing`. */
export interface WrenyardTaskReferencePricing {
  input_usd_per_million?: number;
  output_usd_per_million?: number;
  cached_input_usd_per_million?: number;
  cache_write_input_usd_per_million?: number;
  source?: string;
  checked_at?: string;
}

/** Mirrors the frozen snake_case wire DTO `TaskResolvedSpeed`. */
export interface WrenyardTaskResolvedSpeed {
  effective_tps: number;
  source: 'local_31d' | 'provider_override' | 'catalog_default';
  sample_count: number;
  checked_at: string;
  expected_tps_met: boolean;
  degradation_reason?: string;
}

/** Mirrors the frozen snake_case wire DTO `TaskResolvedDispatch`. */
export interface WrenyardTaskResolvedDispatch {
  requested_agent_runtime: string;
  profile: string;
  client: string;
  provider: string;
  model: string;
  model_id: string;
  mode: 'native' | 'gateway';
  speed: WrenyardTaskResolvedSpeed;
  intelligence: string;
  reference_pricing: WrenyardTaskReferencePricing;
  /** Actual reasoning effort emitted by the resolved dispatch DTO. */
  reasoningEffort?: ProviderListModel['reasoningEfforts'][number];
  protocol?: string;
}

/** Mirrors the frozen snake_case wire DTO `TaskUsage`. Unknown numerics are optional. */
export interface WrenyardTaskUsage {
  completeness: 'complete' | 'partial' | 'unavailable';
  attempt_count: number;
  usage_event_count: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  generation_ms?: number;
  output_tps?: number;
  tps_contract?: 'tokenizer_v1';
  reference_cost_usd?: number;
  reference_cost_complete: boolean;
  reference_cost_basis?: 'catalog_reference';
}

export type WrenyardProviderStatus = ProviderListResult['providers'][number];

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
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
  private handshake?: Promise<void>;

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

  /**
   * Send a JSON-RPC request and resolve with the response result.
   *
   * The first business request completes the version-checked `health.ping`
   * handshake; a mismatch (including a missing daemon version) fails closed,
   * rejecting every queued request and destroying the socket.
   */
  request<TResult>(
    method: string,
    params?: unknown,
    options?: WrenyardIpcRequestOptions,
  ): Promise<TResult> {
    return this.ensureHandshake().then(() => this.sendRequest<TResult>(method, params, options));
  }

  /** Resolve the daemon-local Model Gateway connection. Available over IPC only. */
  gatewayConnection(options?: WrenyardIpcRequestOptions): Promise<WrenyardGatewayConnection> {
    return this.request<WrenyardGatewayConnection>('gateway.connection', {}, options);
  }

  /** Read the daemon-owned provider Catalog and authentication state. */
  providerList(options?: WrenyardIpcRequestOptions): Promise<{ providers: WrenyardProviderStatus[] }> {
    return this.request('provider.list', {}, options);
  }

  /**
   * Read the daemon-owned provider quota projection. The daemon owns quota
   * acquisition and interpretation; the caller only forwards `forceRefresh`
   * and projects the returned provider rows.
   */
  providerQuota(forceRefresh = false, options?: WrenyardIpcRequestOptions): Promise<ProviderQuotaResult> {
    return this.request('provider.quota', { forceRefresh }, { timeoutMs: 45_000, ...options });
  }
  /** Store a managed provider API key through the daemon's local IPC channel. */
  providerConfigure(providerId: string, key: string, options?: WrenyardIpcRequestOptions): Promise<{ ok: true }> {
    return this.request('provider.configure', { providerId, key }, options);
  }

  /**
   * Block until a single task run reaches a terminal status and return its
   * full result. Available over IPC only. Projects the Foreman `task.run.wait`
   * protocol.
   *
   * With no `timeoutMs`, the server timeout param is omitted and the transport
   * deadline is disabled (timeoutMs:null) so a legitimate long task is not cut
   * off by the ordinary 30s RPC timeout. With an explicit `timeoutMs`, it is
   * sent as `timeout_ms` and the transport timer is set to `timeoutMs + 5000`
   * so the request cannot be truncated before the server's bounded wait ends.
   */
  taskRunWait(
    taskRunId: string,
    options?: WrenyardIpcRequestOptions & { timeoutMs?: number },
  ): Promise<WrenyardTaskRunOutputResult> {
    const { timeoutMs, ...requestOptions } = options ?? {};

    if (timeoutMs === undefined) {
      return this.request<WrenyardTaskRunOutputResult>(
        'task.run.wait',
        { task_run_id: taskRunId },
        { ...requestOptions, timeoutMs: null },
      );
    }

    return this.request<WrenyardTaskRunOutputResult>(
      'task.run.wait',
      { task_run_id: taskRunId, timeout_ms: timeoutMs },
      { ...requestOptions, timeoutMs: timeoutMs + 5_000 },
    );
  }

  /** Destroy the socket and reject every request still awaiting a reply. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.settlePending(new Error("WrenyardIpcClient closed before response"));
  }

  private ensureHandshake(): Promise<void> {
    this.handshake ??= this.performHandshake();
    return this.handshake;
  }

  private async performHandshake(): Promise<void> {
    try {
      const result = await this.sendRequest<{ protocolVersion?: unknown }>(
        "health.ping",
        { protocolVersion: WRENYARD_PROTOCOL_VERSION },
      );
      const daemonVersion = result && typeof result === "object"
        ? (result as { protocolVersion?: unknown }).protocolVersion
        : undefined;
      if (daemonVersion !== WRENYARD_PROTOCOL_VERSION) {
        throw new Error(
          protocolVersionMismatchMessage(WRENYARD_PROTOCOL_VERSION, daemonVersion),
        );
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failClosed(failure);
      throw failure;
    }
  }

  /** Mark the client dead, reject every pending request and destroy the socket. */
  private failClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.settlePending(error);
  }

  private sendRequest<TResult>(
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
      // An explicit null timeout disables the transport deadline (e.g. for a
      // long task.run.wait); any other value falls back to the client default.
      const timer = options?.timeoutMs === null
        ? undefined
        : setTimeout(() => {
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
