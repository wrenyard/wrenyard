import type { JsonRpcErrorObject } from './jsonrpc.mts'

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export const FOREMAN_PROTOCOL_ERROR_CODES = {
  UNAUTHORIZED: -32000,
  DAEMON_UNAVAILABLE: -32001,
  TASK_NOT_FOUND: -32002,
  SESSION_NOT_FOUND: -32003,
  WORKER_NOT_FOUND: -32004,
  MESSAGE_NOT_FOUND: -32005,
  OPERATION_CANCELLED: -32006,
  OPERATION_TIMEOUT: -32007,
} as const

export const PROTOCOL_ERROR_CODES = {
  ...JSON_RPC_ERROR_CODES,
  ...FOREMAN_PROTOCOL_ERROR_CODES,
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

export const NOT_IMPLEMENTED = {
  code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
  message: 'NOT_IMPLEMENTED',
} as const satisfies ProtocolErrorDefinition

export const UNAUTHORIZED = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.UNAUTHORIZED,
  message: 'Unauthorized',
} as const satisfies ProtocolErrorDefinition

export const DAEMON_UNAVAILABLE = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.DAEMON_UNAVAILABLE,
  message: 'Daemon unavailable',
} as const satisfies ProtocolErrorDefinition

export const TASK_NOT_FOUND = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.TASK_NOT_FOUND,
  message: 'Task not found',
} as const satisfies ProtocolErrorDefinition

export const SESSION_NOT_FOUND = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.SESSION_NOT_FOUND,
  message: 'Session not found',
} as const satisfies ProtocolErrorDefinition

export const WORKER_NOT_FOUND = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.WORKER_NOT_FOUND,
  message: 'Worker not found',
} as const satisfies ProtocolErrorDefinition

export const MESSAGE_NOT_FOUND = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.MESSAGE_NOT_FOUND,
  message: 'Message not found',
} as const satisfies ProtocolErrorDefinition

export const OPERATION_CANCELLED = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.OPERATION_CANCELLED,
  message: 'Operation cancelled',
} as const satisfies ProtocolErrorDefinition

export const OPERATION_TIMEOUT = {
  code: FOREMAN_PROTOCOL_ERROR_CODES.OPERATION_TIMEOUT,
  message: 'Operation timeout',
} as const satisfies ProtocolErrorDefinition

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly data?: unknown

  constructor(error: ProtocolErrorDefinition, data?: unknown) {
    super(error.message)
    this.name = 'ProtocolError'
    this.code = error.code
    this.data = data
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

export type ProtocolErrorInput = ProtocolError | ProtocolErrorDefinition | JsonRpcErrorObject

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError
}

export function toJsonRpcErrorObject(error: ProtocolErrorInput): JsonRpcErrorObject {
  if (error instanceof ProtocolError) return error.toJsonRpcErrorObject()

  const jsonError: JsonRpcErrorObject = {
    code: error.code,
    message: error.message,
  }
  if ('data' in error && error.data !== undefined) jsonError.data = error.data
  return jsonError
}
