import AjvClass from 'ajv'
import type { ErrorObject, ValidateFunction } from 'ajv'
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  ProtocolError,
  type ProtocolErrorInput,
  toJsonRpcErrorObject,
} from './errors.mts'
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonSchema,
} from './jsonrpc.mts'
import {
  getMethodSchema,
  isForemanMethod,
  type ForemanMethod,
  type MethodParams,
  type MethodResult,
} from './registry.mts'

const ajv = new (AjvClass as any)({
  allErrors: true,
  strict: false,
})

const validators = new Map<JsonSchema, ValidateFunction>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function isJsonRpcParams(value: unknown): boolean {
  return !!value && typeof value === 'object'
}

function formatAjvError(error: ErrorObject): string {
  const instancePath = error.instancePath || '/'
  const message = error.message ?? 'failed validation'
  return `${instancePath} ${message}`
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['validation failed']
  return errors.map(formatAjvError)
}

function compileSchema(schema: JsonSchema): ValidateFunction {
  const cached = validators.get(schema)
  if (cached) return cached
  const validate = ajv.compile(schema as any)
  validators.set(schema, validate)
  return validate
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return input

  try {
    return JSON.parse(input) as unknown
  } catch (error) {
    throw new ProtocolError(PARSE_ERROR, { message: (error as Error).message })
  }
}

export function parseJsonRpcMessage(input: unknown): JsonRpcMessage {
  const parsed = parseInput(input)
  if (!isRecord(parsed)) {
    throw new ProtocolError(INVALID_REQUEST, { details: ['message must be an object'] })
  }

  if (parsed.jsonrpc !== '2.0') {
    throw new ProtocolError(INVALID_REQUEST, { details: ['jsonrpc must be "2.0"'] })
  }

  if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
    throw new ProtocolError(INVALID_REQUEST, { details: ['method must be a non-empty string'] })
  }

  const messageBase = {
    jsonrpc: '2.0' as const,
    method: parsed.method,
  }
  if (hasOwn(parsed, 'params')) {
    if (!isJsonRpcParams(parsed.params)) {
      throw new ProtocolError(INVALID_REQUEST, {
        details: ['params must be an object or array when present'],
      })
    }
    Object.assign(messageBase, { params: parsed.params })
  }

  if (!hasOwn(parsed, 'id')) {
    return messageBase as JsonRpcNotification
  }

  if (!isJsonRpcId(parsed.id)) {
    throw new ProtocolError(INVALID_REQUEST, {
      details: ['id must be a string, number, null, or omitted'],
    })
  }

  return {
    ...messageBase,
    id: parsed.id,
  } as JsonRpcRequest
}

export function parseMethodParams<TMethod extends ForemanMethod>(
  method: TMethod,
  params: unknown,
): MethodParams<TMethod>
export function parseMethodParams(method: string, params: unknown): unknown
export function parseMethodParams(method: string, params: unknown): unknown {
  const schema = getMethodSchema(method)?.params
  if (!schema) {
    throw new ProtocolError(METHOD_NOT_FOUND, { method })
  }

  const value = params === undefined ? {} : params
  const validate = compileSchema(schema)
  if (validate(value)) return value

  throw new ProtocolError(INVALID_PARAMS, {
    method,
    details: formatAjvErrors(validate.errors),
  })
}

export function parseMethodResult<TMethod extends ForemanMethod>(
  method: TMethod,
  result: unknown,
): MethodResult<TMethod>
export function parseMethodResult(method: string, result: unknown): unknown
export function parseMethodResult(method: string, result: unknown): unknown {
  const schema = getMethodSchema(method)?.result
  if (!schema) {
    throw new ProtocolError(METHOD_NOT_FOUND, { method })
  }

  const validate = compileSchema(schema)
  if (validate(result)) return result

  throw new ProtocolError(INVALID_PARAMS, {
    method,
    details: formatAjvErrors(validate.errors),
  })
}

export function createSuccessResponse<TResult>(
  id: JsonRpcId,
  result: TResult,
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: '2.0',
    result,
    id,
  }
}

export function createErrorResponse(
  id: JsonRpcId,
  error: ProtocolErrorInput,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    error: toJsonRpcErrorObject(error),
    id,
  }
}

export function isKnownMethodMessage(message: JsonRpcMessage): message is JsonRpcMessage & {
  method: ForemanMethod
} {
  return isForemanMethod(message.method)
}
