import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { Scheduler } from '../../daemon/services/scheduler.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface RoutineRpcHandlerOptions {
  scheduler: Scheduler
}

/**
 * Register the `routine.*` IPC surface over the injected scheduler. Routines
 * belong to bots, not sessions: every method is available over the owner IPC
 * transport only, so a session can no longer create or fire routines.
 */
export function registerRoutineHandlers(router: RpcRouter, options: RoutineRpcHandlerOptions): void {
  const scheduler = options.scheduler
  const call = async <T,>(context: unknown, method: string, operation: () => T | Promise<T>): Promise<T> => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? context.transport : undefined
    if (transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'routine_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
      )
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError({
        code: INVALID_PARAMS.code,
        message: error instanceof Error ? error.message : 'Routine request rejected',
      })
    }
  }

  router.register('routine.list', (params, _message, context) =>
    call(context, 'routine.list', () => scheduler.list(params.botId)))
  router.register('routine.create', (params, _message, context) =>
    call(context, 'routine.create', () => ({ routine: scheduler.create(params) })))
  router.register('routine.update', (params, _message, context) =>
    call(context, 'routine.update', () => ({ routine: scheduler.update(params.id, params.state) })))
  router.register('routine.run', (params, _message, context) =>
    call(context, 'routine.run', () => ({ routine: scheduler.run(params.id) })))
  router.register('routine.delete', (params, _message, context) =>
    call(context, 'routine.delete', () => {
      scheduler.remove(params.id)
      return { deleted: true as const }
    }))
}
