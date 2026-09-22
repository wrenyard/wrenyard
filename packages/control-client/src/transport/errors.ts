import type { JsonRpcErrorObject } from './types.ts'

/**
 * Transport-level JSON-RPC error codes shared by every Wrenyard IPC client.
 *
 * These mirror the daemon's wire protocol table. The daemon keeps its own
 * server-side copy for handler dispatch; the client transport only needs the
 * subset it can actually produce or observe.
 */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export const PROTOCOL_ERROR_CODES = {
  ...JSON_RPC_ERROR_CODES,
  UNAUTHORIZED: -32000,
  DAEMON_UNAVAILABLE: -32001,
  TASK_NOT_FOUND: -32002,
  SESSION_NOT_FOUND: -32003,
  WORKER_NOT_FOUND: -32004,
  MESSAGE_NOT_FOUND: -32005,
  OPERATION_CANCELLED: -32006,
  OPERATION_TIMEOUT: -32007,
} as const

export type ProtocolErrorCode = typeof PROTOCOL_ERROR_CODES[keyof typeof PROTOCOL_ERROR_CODES]

export interface ProtocolErrorDefinition {
  code: ProtocolErrorCode
  message: string
}

export const PARSE_ERROR = {
  code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
  message: 'Parse error',
} as const satisfies ProtocolErrorDefinition

export const INVALID_REQUEST = {
  code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
  message: 'Invalid Request',
} as const satisfies ProtocolErrorDefinition

export const METHOD_NOT_FOUND = {
  code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
  message: 'Method not found',
} as const satisfies ProtocolErrorDefinition

export const INVALID_PARAMS = {
  code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
  message: 'Invalid params',
} as const satisfies ProtocolErrorDefinition

export const INTERNAL_ERROR = {
  code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
  message: 'Internal error',
} as const satisfies ProtocolErrorDefinition

export const DAEMON_UNAVAILABLE = {
  code: PROTOCOL_ERROR_CODES.DAEMON_UNAVAILABLE,
  message: 'Daemon unavailable',
} as const satisfies ProtocolErrorDefinition

export const OPERATION_TIMEOUT = {
  code: PROTOCOL_ERROR_CODES.OPERATION_TIMEOUT,
  message: 'Operation timed out',
} as const satisfies ProtocolErrorDefinition

/** Error carrying a JSON-RPC code and optional structured data. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly data?: unknown

  constructor(error: ProtocolErrorDefinition, data?: unknown) {
    super(error.message)
    this.name = 'ProtocolError'
    this.code = error.code
    if (data !== undefined) this.data = data
  }

  toJsonRpcErrorObject(): JsonRpcErrorObject {
    const jsonError: JsonRpcErrorObject = {
      code: this.code,
      message: this.message,
    }
    if (this.data !== undefined) jsonError.data = this.data
    return jsonError
  }
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError
}
