import type { SessionV2 } from '@wrenyard/session-v2'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { SessionV2EventsParams, SessionV2EventsResult } from '../../protocol/methods/session-v2.mts'
import type { RpcRouter } from '../rpc-router.mts'

function readEvents(session: SessionV2, params: SessionV2EventsParams): SessionV2EventsResult {
  const ledger = session.readLedger(params.sessionId)
  if (!ledger.some(event => event.type === 'session.created')) throw new Error(`Unknown session: ${params.sessionId}`)
  return {
    events: ledger.filter(event => event.seq > params.afterSeq).slice(0, params.limit ?? 500),
    lastSeq: ledger.at(-1)?.seq ?? 0,
  }
}

async function pollEvents(session: SessionV2, params: SessionV2EventsParams): Promise<SessionV2EventsResult> {
  const page = readEvents(session, params)
  if (page.events.length || !params.waitMs) return page
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown): void => {
      unsubscribe?.()
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    try {
      // Subscribe before re-reading so an append cannot fall between read and wait.
      unsubscribe = session.subscribe(params.sessionId, event => {
        if (event.seq > params.afterSeq) finish()
      })
      timer = setTimeout(() => finish(), params.waitMs)
      if (readEvents(session, params).events.length) finish()
    } catch (error) {
      finish(error)
    }
  })
  return readEvents(session, params)
}

export function registerSessionV2Handlers(router: RpcRouter, options: { sessionV2: SessionV2 }): void {
  const session = options.sessionV2
  const call = async <T,>(context: unknown, method: string, operation: () => T | Promise<T>): Promise<T> => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? context.transport : undefined
    if (transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'session_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
      )
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError({
        code: INVALID_PARAMS.code,
        message: error instanceof Error ? error.message : 'Session request rejected',
      })
    }
  }

  router.register('sessionV2.list', (_params, _message, context) =>
    call(context, 'sessionV2.list', () => ({ sessions: session.listSessions() })))
  router.register('sessionV2.create', (_params, _message, context) =>
    call(context, 'sessionV2.create', () => session.createSession()))
  router.register('sessionV2.send', (params, _message, context) =>
    call(context, 'sessionV2.send', () => session.send(params.sessionId, { text: params.text, model: params.model })))
  router.register('sessionV2.interrupt', (params, _message, context) =>
    call(context, 'sessionV2.interrupt', async () => {
      await session.interrupt(params.sessionId, params.turn)
      return {}
    }))
  router.register('sessionV2.events', (params, _message, context) =>
    call(context, 'sessionV2.events', () => pollEvents(session, params)))
}
