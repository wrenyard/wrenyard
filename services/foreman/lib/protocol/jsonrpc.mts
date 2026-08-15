export type JsonRecord = Record<string, unknown>
export type JsonSchema = boolean | JsonRecord

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  params?: unknown
  id: JsonRpcId
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0'
  result: TResult
  id: JsonRpcId
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  error: JsonRpcErrorObject
  id: JsonRpcId
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification
export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse

export const jsonRpcIdSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'null' },
  ],
} as const satisfies JsonSchema

export const jsonRpcParamsSchema = {
  anyOf: [
    { type: 'object' },
    { type: 'array' },
  ],
} as const satisfies JsonSchema

export const jsonRpcRequestSchema = {
  type: 'object',
  required: ['jsonrpc', 'method', 'id'],
  properties: {
    jsonrpc: { const: '2.0' },
    method: { type: 'string', minLength: 1 },
    params: jsonRpcParamsSchema,
    id: jsonRpcIdSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const jsonRpcNotificationSchema = {
  type: 'object',
  required: ['jsonrpc', 'method'],
  not: { required: ['id'] },
  properties: {
    jsonrpc: { const: '2.0' },
    method: { type: 'string', minLength: 1 },
    params: jsonRpcParamsSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const jsonRpcSuccessResponseSchema = {
  type: 'object',
  required: ['jsonrpc', 'result', 'id'],
  properties: {
    jsonrpc: { const: '2.0' },
    result: {},
    id: jsonRpcIdSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const jsonRpcErrorObjectSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' },
    data: {},
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const jsonRpcErrorResponseSchema = {
  type: 'object',
  required: ['jsonrpc', 'error', 'id'],
  properties: {
    jsonrpc: { const: '2.0' },
    error: jsonRpcErrorObjectSchema,
    id: jsonRpcIdSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema
