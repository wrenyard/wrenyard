import {
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  ProtocolError,
  type ProtocolErrorDefinition,
} from '../protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcMessage,
  parseMethodParams,
  parseMethodResult,
} from '../protocol/validate.mts'
import type {
  ForemanMethod,
  MethodParams,
  MethodResult,
} from '../protocol/registry.mts'
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  JsonRpcRequest,
} from '../protocol/jsonrpc.mts'

export type RpcHandler<TParams = unknown, TResult = unknown, TContext = unknown> = (
  params: TParams,
  message: JsonRpcMessage,
  context: TContext,
) => TResult | Promise<TResult>

export class RpcRouter {
  private readonly handlers = new Map<string, RpcHandler>()

  register<TMethod extends ForemanMethod>(
    method: TMethod,
    handler: RpcHandler<MethodParams<TMethod>, MethodResult<TMethod>>,
  ): void
  register(method: string, handler: RpcHandler): void
  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler)
  }

  async handleMessage(input: unknown, context?: unknown): Promise<JsonRpcResponse | undefined> {
    let message: JsonRpcMessage

    try {
      message = parseJsonRpcMessage(input)
    } catch (error) {
      return this.createParseErrorResponse(input, error)
    }

    const isNotification = !('id' in message)

    try {
      const params = parseMethodParams(message.method, message.params)
      const handler = this.handlers.get(message.method)
      if (!handler) {
        throw new ProtocolError(METHOD_NOT_FOUND, { method: message.method })
      }

      const result = await handler(params, message, context)
      if (isNotification) return undefined

      const validatedResult = parseMethodResult(message.method, result)
      return createSuccessResponse((message as JsonRpcRequest).id, validatedResult)
    } catch (error) {
      if (isNotification) return undefined
      return createErrorResponse((message as JsonRpcRequest).id, this.normalizeError(error))
    }
  }

  private createParseErrorResponse(input: unknown, error: unknown): JsonRpcResponse | undefined {
    if (this.inputLooksLikeNotification(input)) return undefined
    return createErrorResponse(this.responseIdFromInput(input), this.normalizeError(error))
  }

  private normalizeError(error: unknown): ProtocolError {
    if (error instanceof ProtocolError) return error
    if (this.isProtocolErrorDefinition(error)) return new ProtocolError(error)

    return new ProtocolError(INTERNAL_ERROR, {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private isProtocolErrorDefinition(error: unknown): error is ProtocolErrorDefinition {
    return !!error
      && typeof error === 'object'
      && 'code' in error
      && typeof (error as { code: unknown }).code === 'number'
      && 'message' in error
      && typeof (error as { message: unknown }).message === 'string'
  }

  private inputLooksLikeNotification(input: unknown): boolean {
    const parsed = this.parseLooseInput(input)
    return !!parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && !Object.prototype.hasOwnProperty.call(parsed, 'id')
  }

  private responseIdFromInput(input: unknown): JsonRpcId {
    const parsed = this.parseLooseInput(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const id = (parsed as { id?: unknown }).id
    if (id === null || typeof id === 'string' || typeof id === 'number') return id
    return null
  }

  private parseLooseInput(input: unknown): unknown {
    if (typeof input !== 'string') return input

    try {
      return JSON.parse(input) as unknown
    } catch {
      return undefined
    }
  }
}
