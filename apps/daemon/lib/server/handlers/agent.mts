import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import { BotAgentError, type BotAgentKernel } from '../../daemon/services/bot-agents/kernel.mts'
import type { SessionEventsResult } from '../../protocol/methods/session.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { readEvents } from './session.mts'

export interface AgentRpcHandlerOptions {
  kernel: BotAgentKernel
}

/** Map kernel BotAgentError codes to protocol status codes, preserving the code. */
function toProtocolError(error: BotAgentError): ProtocolError {
  const statusCode = error.code === 'agent_not_found' ? 404
    : error.code === 'agent_disabled' || error.code === 'agent_invalid' ? 409
    : undefined
  return new ProtocolError(
    { code: INVALID_PARAMS.code, message: error.message },
    statusCode === undefined ? undefined : { code: error.code, statusCode },
  )
}

/**
 * Register the `agent.*` IPC surface over the injected bot agent kernel. Bot
 * agents are owned by Desktop: every method is available over the owner IPC
 * transport only.
 */
export function registerAgentHandlers(router: RpcRouter, options: AgentRpcHandlerOptions): void {
  const kernel = options.kernel
  const call = async <T,>(context: unknown, method: string, operation: () => T | Promise<T>): Promise<T> => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? context.transport : undefined
    if (transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'agent_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
      )
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      if (error instanceof BotAgentError) throw toProtocolError(error)
      throw new ProtocolError({
        code: INVALID_PARAMS.code,
        message: error instanceof Error ? error.message : 'Agent request rejected',
      })
    }
  }

  router.register('agent.list', (_params, _message, context) =>
    call(context, 'agent.list', () => ({ bots: kernel.list() })))
  router.register('agent.get', (params, _message, context) =>
    call(context, 'agent.get', () => kernel.get(params.id)))
  router.register('agent.create', (params, _message, context) =>
    call(context, 'agent.create', async () => ({
      bot: await kernel.create({
        id: params.id,
        name: params.name,
        ...(params.icon === undefined ? {} : { icon: params.icon }),
        ...(params.location === undefined ? {} : { location: params.location }),
      }),
    })))
  router.register('agent.memory.list', (params, _message, context) =>
    call(context, 'agent.memory.list', async () => ({ files: await kernel.memory(params.id) })))
  router.register('agent.wake', (params, _message, context) =>
    call(context, 'agent.wake', () => kernel.wake(params.id, params.text)))
  router.register('agent.group.events', (params, _message, context) =>
    call(context, 'agent.group.events', () => kernel.groupEvents({
      ...(params.afterSeq === undefined ? {} : { afterSeq: params.afterSeq }),
      ...(params.beforeSeq === undefined ? {} : { beforeSeq: params.beforeSeq }),
      ...(params.latest === undefined ? {} : { latest: params.latest }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    })))
  router.register('agent.group.send', (params, _message, context) =>
    call(context, 'agent.group.send', () => kernel.groupSend(params.text)))
  router.register('agent.events', (params, _message, context) =>
    call(context, 'agent.events', () => {
      const ctx = kernel.context(params.id)
      if (ctx === undefined) {
        const empty: SessionEventsResult = { events: [], lastSeq: params.afterSeq }
        return empty
      }
      return readEvents(ctx.session, {
        sessionId: ctx.sessionId,
        afterSeq: params.afterSeq,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      })
    }))
}
