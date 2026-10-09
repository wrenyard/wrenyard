import {
  OPERATION_TIMEOUT,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  protocolVersionMismatchMessage,
  type ProtocolErrorCode,
} from './errors.ts'
import {
  createFrameDecoder,
  encodeFrame,
} from './ndjson.ts'
import {
  WRENYARD_PROTOCOL_VERSION,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcResponse,
  type NdjsonChunk,
} from './types.ts'

/** Client-initiated handshake method; carries the expected protocol version. */
const HANDSHAKE_METHOD = 'health.ping'

export interface JsonRpcClientTransport {
  send(frame: string): void | Promise<void>
  close?(): void
}

export interface JsonRpcClientOptions {
  transport: JsonRpcClientTransport
  timeoutMs?: number
  idFactory?: () => string | number
  /** Protocol version sent in the automatic `health.ping` handshake. */
  protocolVersion?: number
  /**
   * When true (the default) the client completes the `health.ping` handshake
   * before its first business request. Set false only for raw framing tests.
   */
  handshake?: boolean
}

export interface JsonRpcRequestOptions {
  /** Per-request deadline in ms, or null to disable the client timer entirely. */
  timeoutMs?: number | null
}

interface PendingRequest {
  readonly id: string | number
  readonly method: string
  readonly timeout?: ReturnType<typeof setTimeout>
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

const DEFAULT_TIMEOUT_MS = 30_000

function pendingKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function isKnownProtocolErrorCode(code: number): code is ProtocolErrorCode {
  return Object.values(PROTOCOL_ERROR_CODES).includes(code as ProtocolErrorCode)
}

function errorFromJsonRpc(error: JsonRpcErrorObject): Error {
  if (isKnownProtocolErrorCode(error.code)) {
    return new ProtocolError({ code: error.code, message: error.message }, error.data)
  }

  const clientError = new Error(error.message)
  clientError.name = 'JsonRpcClientError'
  Object.assign(clientError, {
    code: error.code,
    data: error.data,
  })
  return clientError
}

function isResponseMessage(message: unknown): message is JsonRpcResponse {
  if (!isRecord(message)) return false
  if (message.jsonrpc !== '2.0') return false
  if (!isJsonRpcId(message.id)) return false
  return Object.prototype.hasOwnProperty.call(message, 'result')
    || Object.prototype.hasOwnProperty.call(message, 'error')
}

export class JsonRpcClient {
  private readonly transport: JsonRpcClientTransport
  private readonly timeoutMs: number
  private readonly idFactory?: () => string | number
  private readonly protocolVersion: number
  private readonly handshakeEnabled: boolean
  private readonly pending = new Map<string, PendingRequest>()
  private nextNumericId = 1
  private handshakePromise?: Promise<void>
  private closedError?: Error
  private readonly decoder = createFrameDecoder({
    onMessage: (message) => this.handleMessage(message),
  })

  constructor(options: JsonRpcClientOptions) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.idFactory = options.idFactory
    this.protocolVersion = options.protocolVersion ?? WRENYARD_PROTOCOL_VERSION
    this.handshakeEnabled = options.handshake ?? true
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Complete (or reuse) the version-checked `health.ping` handshake.
   *
   * Idempotent: the handshake runs at most once per client and the failed
   * result is cached, so every later business request fails closed with the
   * same error instead of silently retrying an incompatible peer.
   */
  handshake(): Promise<void> {
    this.handshakePromise ??= this.runHandshake()
    return this.handshakePromise
  }

  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<TResult> {
    // The handshake uses sendRequest directly, so all public calls can wait
    // for it without recursively handshaking.
    if (this.handshakeEnabled) {
      return this.handshake().then(() => this.sendRequest<TResult>(method, params, options))
    }
    return this.sendRequest<TResult>(method, params, options)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.handshakeEnabled) {
      await this.handshake()
    }
    if (this.closedError) throw this.closedError

    const notification = {
      jsonrpc: '2.0' as const,
      method,
      ...(params === undefined ? {} : { params }),
    }

    await this.transport.send(encodeFrame(notification))
  }

  handleIncoming(chunk: NdjsonChunk): unknown[] {
    return this.decoder.write(chunk)
  }

  clearPending(error = new Error('JsonRpcClient closed')): void {
    for (const request of this.pending.values()) {
      if (request.timeout !== undefined) clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }

  close(error = new Error('JsonRpcClient closed')): void {
    this.closedError ??= error
    this.clearPending(error)
  }

  dispose(error = new Error('JsonRpcClient disposed')): void {
    this.close(error)
  }

  private runHandshake(): Promise<void> {
    return this.sendRequest<{ protocolVersion?: unknown }>(
      HANDSHAKE_METHOD,
      { protocolVersion: this.protocolVersion },
      {},
    ).then((result) => {
      const daemonVersion = isRecord(result) ? result.protocolVersion : undefined
      if (daemonVersion !== this.protocolVersion) {
        const error = new Error(protocolVersionMismatchMessage(this.protocolVersion, daemonVersion))
        this.clearPending(error)
        throw error
      }
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.close(failure)
      this.transport.close?.()
      throw failure
    })
  }

  private sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<TResult> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.createId()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const request = {
      jsonrpc: '2.0' as const,
      method,
      ...(params === undefined ? {} : { params }),
      id,
    }

    return new Promise<TResult>((resolve, reject) => {
      // An explicit null timeout means "no client timer": long-lived calls
      // such as task.run.wait opt out of the short JSON-RPC deadline. Any
      // other value (including undefined) uses the numeric or default timeout.
      const timeout = options.timeoutMs === null
        ? undefined
        : setTimeout(() => {
          if (!this.pending.delete(pendingKey(id))) return
          reject(new ProtocolError(OPERATION_TIMEOUT, { id, method, timeoutMs }))
        }, timeoutMs)

      this.pending.set(pendingKey(id), {
        id,
        method,
        timeout,
        resolve: resolve as (result: unknown) => void,
        reject,
      })

      try {
        void Promise.resolve(this.transport.send(encodeFrame(request))).catch((error: unknown) => {
          this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
        })
      } catch (error) {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private createId(): string | number {
    return this.idFactory?.() ?? this.nextNumericId++
  }

  private handleMessage(message: unknown): void {
    if (!isResponseMessage(message)) return
    const request = this.pending.get(pendingKey(message.id))
    if (!request) return

    if (request.timeout !== undefined) clearTimeout(request.timeout)
    this.pending.delete(pendingKey(message.id))

    if ('error' in message && isRecord(message.error)
      && typeof message.error.code === 'number'
      && typeof message.error.message === 'string') {
      request.reject(errorFromJsonRpc(message.error as JsonRpcErrorObject))
      return
    }

    if ('result' in message) {
      request.resolve(message.result)
      return
    }

    request.reject(new Error(`Invalid JSON-RPC response for request ${String(message.id)}`))
  }

  private rejectPending(id: string | number, error: Error): void {
    const request = this.pending.get(pendingKey(id))
    if (!request) return
    if (request.timeout !== undefined) clearTimeout(request.timeout)
    this.pending.delete(pendingKey(id))
    request.reject(error)
  }
}
