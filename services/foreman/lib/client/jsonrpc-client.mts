import {
  OPERATION_TIMEOUT,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  type ProtocolErrorCode,
} from '../protocol/errors.mts'
import type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcResponse,
} from '../protocol/jsonrpc.mts'
import {
  createFrameDecoder,
  encodeFrame,
} from '../transport/ndjson.mts'
import type { NdjsonChunk } from '../transport/types.mts'

export interface JsonRpcClientTransport {
  send(frame: string): void | Promise<void>
}

export interface JsonRpcClientOptions {
  transport: JsonRpcClientTransport
  timeoutMs?: number
  idFactory?: () => string | number
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number
}

interface PendingRequest {
  readonly id: string | number
  readonly method: string
  readonly timeout: ReturnType<typeof setTimeout>
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
  private readonly pending = new Map<string, PendingRequest>()
  private nextNumericId = 1
  private readonly decoder = createFrameDecoder({
    onMessage: (message) => this.handleMessage(message),
  })

  constructor(options: JsonRpcClientOptions) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.idFactory = options.idFactory
  }

  get pendingCount(): number {
    return this.pending.size
  }

  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<TResult> {
    const id = this.createId()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const request = {
      jsonrpc: '2.0' as const,
      method,
      ...(params === undefined ? {} : { params }),
      id,
    }

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
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

  async notify(method: string, params?: unknown): Promise<void> {
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
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }

  close(error = new Error('JsonRpcClient closed')): void {
    this.clearPending(error)
  }

  dispose(error = new Error('JsonRpcClient disposed')): void {
    this.clearPending(error)
  }

  private createId(): string | number {
    return this.idFactory?.() ?? this.nextNumericId++
  }

  private handleMessage(message: unknown): void {
    if (!isResponseMessage(message)) return
    const request = this.pending.get(pendingKey(message.id))
    if (!request) return

    clearTimeout(request.timeout)
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
    clearTimeout(request.timeout)
    this.pending.delete(pendingKey(id))
    request.reject(error)
  }
}
