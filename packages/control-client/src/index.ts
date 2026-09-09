import { createConnection, type Socket } from "node:net";

export type WrenyardIpcEnvironment = NodeJS.ProcessEnv;

/**
 * Shared default control socket for the Wrenyard daemon. Every Wrenyard
 * surface (control-client, dsh-shell, desktop, pet) uses this same default so
 * the legacy per-surface socket mismatch is gone.
 */
export function defaultWrenyardIpcPath(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\wrenyard"
    : "/tmp/wrenyard.sock";
}

/**
 * Resolve the Wrenyard NDJSON IPC socket path. `WRENYARD_IPC_PATH` is
 * primary; the legacy `FOREMAN_IPC_PATH` and `FOREMAN_PET_FOREMAN_IPC`
 * variables are still read as fallbacks. Without an override, Windows uses
 * the daemon's `\\.\pipe\wrenyard` named pipe and Unix uses
 * `/tmp/wrenyard.sock`.
 */
export function resolveWrenyardIpcPath(
  env: WrenyardIpcEnvironment = process.env,
): string {
  for (const candidate of [
    env.WRENYARD_IPC_PATH,
    env.FOREMAN_IPC_PATH,
    env.FOREMAN_PET_FOREMAN_IPC,
  ]) {
    const path = candidate?.trim();
    if (path) return path;
  }
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

export interface WrenyardGatewayModelSpeed {
  tps: number;
  source: string;
  checkedAt: string;
  conservative?: boolean;
  basis?: string;
}

export interface WrenyardGatewayModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
  checkedAt: string;
}

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
  intelligence?: 'low' | 'mid' | 'high' | 'frontier' | 'premium';
  maxOutputTokens?: number;
  capabilities?: readonly ('text' | 'image')[];
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  speed?: WrenyardGatewayModelSpeed;
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
 */
export interface WrenyardTaskRunOutputResult {
  task_run_id: string;
  task_id: string;
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
  source: string;
  checked_at: string;
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
  agent_turn_ms?: number;
  output_tps?: number;
  tps_contract?: 'agent_turn_v1';
  reference_cost_usd?: number;
  reference_cost_complete: boolean;
  reference_cost_basis?: 'catalog_reference';
}

export type WrenyardClientConfigurationId = 'claude-app' | 'claude-code' | 'codex-shared' | 'grok-build';
export type WrenyardClientSurfaceId = 'claude-app' | 'claude-code' | 'codex-app' | 'codex-cli' | 'grok-build';
export type WrenyardClientCompatibility = 'not-installed' | 'supported' | 'needs-verification' | 'needs-upgrade' | 'externally-managed';
export type WrenyardClientConfigurationState = 'not-configured' | 'connected' | 'drifted' | 'conflict' | 'needs-restart';
export type WrenyardGatewayProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

export interface WrenyardClientSurface {
  id: WrenyardClientSurfaceId;
  label: string;
  installed: boolean;
  compatibility: WrenyardClientCompatibility;
  source?: string;
  version?: string;
  detail?: string;
}

export interface WrenyardClientGatewayModel extends WrenyardGatewayModel {
  protocols: WrenyardGatewayProtocol[];
  claudeFamily?: boolean;
  claudeTier?: 'haiku' | 'sonnet' | 'opus';
  supports1MContext?: boolean;
}

export interface WrenyardClientConfigurationStatus {
  clientId: WrenyardClientConfigurationId;
  state: WrenyardClientConfigurationState;
  configuredModels: string[];
  detail?: string;
}

export interface WrenyardClientConfigurationSnapshot {
  surfaces: WrenyardClientSurface[];
  configurations: WrenyardClientConfigurationStatus[];
  models: WrenyardClientGatewayModel[];
}

export interface WrenyardClientModelSelection {
  models: string[];
  defaultModel: string;
  protocols?: Partial<Record<string, WrenyardGatewayProtocol>>;
}

export interface WrenyardClientPlanFile {
  path: string;
  digest: string;
  existed: boolean;
  changes: string[];
}

export interface WrenyardClientConfigurationPlan {
  clientId: WrenyardClientConfigurationId;
  operation: 'apply' | 'restore';
  files: WrenyardClientPlanFile[];
  models: string[];
  defaultModel?: string;
  protocols?: Partial<Record<string, WrenyardGatewayProtocol>>;
  connectionMode: 'additive' | 'switching';
  effects: string[];
  requiresRestart: WrenyardClientSurfaceId[];
}

export interface WrenyardProviderStatus {
  id: string;
  displayName: string;
  description: string;
  setupHint: string;
  configured: boolean;
  authMode: 'api-key' | 'native' | 'none';
  protocols: Array<'openai_chat' | 'openai_responses' | 'anthropic_messages'>;
  models: Array<{
    id: string;
    displayName: string;
    contextWindow?: number;
    maxTokens?: number;
    taskOnly?: boolean;
  }>;
}

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

  /** Resolve the daemon-local Model Gateway connection. Available over IPC only. */
  gatewayConnection(options?: WrenyardIpcRequestOptions): Promise<WrenyardGatewayConnection> {
    return this.request<WrenyardGatewayConnection>('gateway.connection', {}, options);
  }

  /** Read the daemon-owned provider Catalog and authentication state. */
  providerList(options?: WrenyardIpcRequestOptions): Promise<{ providers: WrenyardProviderStatus[] }> {
    return this.request('provider.list', {}, options);
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

  /** Discover supported local Agent clients and their redacted Gateway model catalog. */
  clientConfigurationSnapshot(options?: WrenyardIpcRequestOptions): Promise<WrenyardClientConfigurationSnapshot> {
    return this.request('client.configuration.snapshot', {}, options);
  }

  /** Build a read-only, digest-bound client configuration preview. */
  clientConfigurationPlan(
    clientId: WrenyardClientConfigurationId,
    selection: WrenyardClientModelSelection,
    options?: WrenyardIpcRequestOptions,
  ): Promise<WrenyardClientConfigurationPlan> {
    return this.request('client.configuration.plan', { clientId, selection }, options);
  }

  /** Apply a previously previewed client configuration plan. */
  clientConfigurationApply(
    plan: WrenyardClientConfigurationPlan,
    options?: WrenyardIpcRequestOptions,
  ): Promise<WrenyardClientConfigurationStatus> {
    return this.request('client.configuration.apply', { plan }, options);
  }

  /** Build a read-only restore preview for one managed client configuration. */
  clientConfigurationPlanRestore(
    clientId: WrenyardClientConfigurationId,
    options?: WrenyardIpcRequestOptions,
  ): Promise<WrenyardClientConfigurationPlan> {
    return this.request('client.configuration.plan-restore', { clientId }, options);
  }

  /** Restore only Wrenyard-owned fields using a digest-bound preview. */
  clientConfigurationRestore(
    plan: WrenyardClientConfigurationPlan,
    options?: WrenyardIpcRequestOptions,
  ): Promise<WrenyardClientConfigurationStatus> {
    return this.request('client.configuration.restore', { plan }, options);
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
