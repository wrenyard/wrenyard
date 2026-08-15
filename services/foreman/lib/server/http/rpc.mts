import {
  INVALID_PARAMS,
  ProtocolError,
  TASK_NOT_FOUND,
  type ProtocolErrorCode,
} from '../../protocol/errors.mts'
import type {
  ForemanMethod,
  MethodParams,
  MethodResult,
} from '../../protocol/registry.mts'
import type { JsonRpcErrorObject } from '../../protocol/jsonrpc.mts'
import type { RpcRouter } from '../rpc-router.mts'
import type { JsonRecord } from './shared.mts'

export interface HttpRpcContext {
  rpcRouter: RpcRouter
}

export async function invokeHttpRpc<TMethod extends ForemanMethod>(
  method: TMethod,
  params: MethodParams<TMethod>,
  context: HttpRpcContext,
): Promise<MethodResult<TMethod>> {
  const response = await context.rpcRouter.handleMessage({
    jsonrpc: '2.0',
    id: 'http_rpc',
    method,
    params,
  }, { transport: 'http' })
  if (!response) {
    throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: `No response for HTTP RPC method '${method}'` },
      { method, code: 'missing_http_rpc_response' },
    )
  }
  if ('error' in response) throw protocolErrorFromJsonRpcError(response.error)
  return response.result as MethodResult<TMethod>
}

export function sendProtocolHttpError(
  send: (statusCode: number, value: unknown) => void,
  error: unknown,
  fallbackError: string,
): void {
  if (!(error instanceof ProtocolError)) {
    send(500, { error: fallbackError, message: error instanceof Error ? error.message : String(error) })
    return
  }

  const data = protocolErrorData(error)
  if (typeof data?.code === 'string') {
    send(protocolHttpStatus(error), {
      error: data.code,
      message: error.message,
      ...(data.details !== undefined ? { details: data.details } : {}),
    })
    return
  }

  send(protocolHttpStatus(error), {
    error: fallbackError,
    message: error.message,
  })
}

function protocolErrorFromJsonRpcError(error: JsonRpcErrorObject): ProtocolError {
  return new ProtocolError(
    { code: error.code as ProtocolErrorCode, message: error.message },
    error.data,
  )
}

function protocolHttpStatus(error: ProtocolError): number {
  const data = protocolErrorData(error)
  if (typeof data?.code === 'string' && data.code.endsWith('_not_found')) return 404
  if (typeof data?.statusCode === 'number' && Number.isInteger(data.statusCode)) return data.statusCode
  if (error.code === TASK_NOT_FOUND.code) return 404
  if (error.code === INVALID_PARAMS.code) return 400
  return 500
}

function protocolErrorData(error: ProtocolError): JsonRecord | undefined {
  return error.data && typeof error.data === 'object' && !Array.isArray(error.data)
    ? error.data as JsonRecord
    : undefined
}
