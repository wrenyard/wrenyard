export type NdjsonChunk = Buffer | string

/** Request/response correlation id. `null` is allowed by JSON-RPC 2.0. */
export type JsonRpcId = string | number | null

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0'
  result: TResult
  id: JsonRpcId
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  error: JsonRpcErrorObject
  id: JsonRpcId
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse

export interface FrameDecoderOptions {
  encoding?: BufferEncoding
  onMessage?: (message: unknown) => void
  onError?: (error: NdjsonFrameError, line: string) => void
}

export interface FrameDecoder {
  readonly buffered: string
  write(chunk: NdjsonChunk): unknown[]
  reset(): void
}

export class NdjsonFrameError extends Error {
  readonly line: string
  readonly cause?: unknown

  constructor(message: string, line: string, cause?: unknown) {
    super(message)
    this.name = 'NdjsonFrameError'
    this.line = line
    this.cause = cause
  }
}
