import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { Scheduler } from '../../daemon/services/scheduler.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface ScheduleRpcHandlerOptions {
  scheduler: Scheduler
}

/**
 * Register the `schedule.*` IPC surface over the injected scheduler. Every
 * method is available over the owner IPC transport and to a session through the
 * auxiliary loop; any other transport is rejected, exactly like `session.*`.
 */
export function registerScheduleHandlers(router: RpcRouter, options: ScheduleRpcHandlerOptions): void {
  const scheduler = options.scheduler
  const call = async <T,>(context: unknown, method: string, operation: () => T | Promise<T>): Promise<T> => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? context.transport : undefined
    if (transport !== 'ipc' && transport !== 'session') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'schedule_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
      )
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError({
        code: INVALID_PARAMS.code,
        message: error instanceof Error ? error.message : 'Schedule request rejected',
      })
    }
  }

  router.register('schedule.list', (params, _message, context) =>
    call(context, 'schedule.list', () => scheduler.list(params.sessionId)))
  router.register('schedule.create', (params, _message, context) =>
    call(context, 'schedule.create', () => ({ schedule: scheduler.create(params) })))
  router.register('schedule.update', (params, _message, context) =>
    call(context, 'schedule.update', () => ({ schedule: scheduler.update(params.id, params.state, params.sessionId) })))
  router.register('schedule.run', (params, _message, context) =>
    call(context, 'schedule.run', () => ({ schedule: scheduler.run(params.id, params.sessionId) })))
  router.register('schedule.delete', (params, _message, context) =>
    call(context, 'schedule.delete', () => {
      scheduler.remove(params.id, params.sessionId)
      return { deleted: true as const }
    }))
}
