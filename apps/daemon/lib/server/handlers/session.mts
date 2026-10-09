import {
  type LiveCall,
  type Session,
} from '@wrenyard/session'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type {
  SessionEventsParams,
  SessionEventsResult,
} from '../../protocol/methods/session.mts'
import type { RpcRouter } from '../rpc-router.mts'

/** Minimum spacing between two normal long-poll returns. */
const LIVE_MIN_INTERVAL_MS = 150

function readEvents(session: Session, params: SessionEventsParams): SessionEventsResult {
  const ledger = session.readLedger(params.sessionId)
  if (!ledger.some(event => event.type === 'session.created')) throw new Error(`Unknown session: ${params.sessionId}`)
  return {
    events: ledger.filter(event => event.seq > params.afterSeq).slice(0, params.limit ?? 500),
    lastSeq: ledger.at(-1)?.seq ?? 0,
    ...(params.live ? { live: session.readLive(params.sessionId) } : {}),
  }
}

/** Full-snapshot equality: an unchanged live table must not wake a waiter. */
function sameLive(a: readonly LiveCall[], b: readonly LiveCall[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.callId !== right.callId || left.text !== right.text || left.reasoning !== right.reasoning) return false
  }
  return true
}

async function pollEvents(session: Session, params: SessionEventsParams): Promise<SessionEventsResult> {
  const startedAt = Date.now()
  const page = readEvents(session, params)
  if (!params.waitMs) return page
  if (!page.events.length) {
    await new Promise<void>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined
      let unsubscribeLive: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown): void => {
        unsubscribe?.()
        unsubscribeLive?.()
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      try {
        // Subscribe before re-reading so an append cannot fall between read and wait.
        unsubscribe = session.subscribe(params.sessionId, event => {
          if (event.seq > params.afterSeq) finish()
        })
        if (params.live) {
          const initial = session.readLive(params.sessionId)
          unsubscribeLive = session.subscribeLive(params.sessionId, live => {
            if (!sameLive(initial, live)) finish()
          })
        }
        timer = setTimeout(() => finish(), params.waitMs)
        if (readEvents(session, params).events.length) finish()
      } catch (error) {
        finish(error)
      }
    })
  }
  // Every normal (waitMs > 0) long-poll return stays >= LIVE_MIN_INTERVAL_MS from the
  // call start, so a sequential caller's returns are spaced >= 150ms apart whether it
  // was woken by immediate events, a durable append, or a live update.
  const remaining = LIVE_MIN_INTERVAL_MS - (Date.now() - startedAt)
  if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining))
  return readEvents(session, params)
}

export interface SessionRpcHandlerOptions {
  session: Session
}

/**
 * Register the canonical `session.*` IPC surface over the injected session
 * feature. Every method is IPC-only: session requests reach the daemon-owned
 * ledger, but the HTTP and MCP transports must never execute a session action.
 */
export function registerSessionHandlers(router: RpcRouter, options: SessionRpcHandlerOptions): void {
  const session = options.session
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

  router.register('session.list', (_params, _message, context) =>
    call(context, 'session.list', () => ({ sessions: session.listSessions() })))
  router.register('session.create', (_params, _message, context) =>
    call(context, 'session.create', () => session.createSession()))
  router.register('session.send', (params, _message, context) =>
    call(context, 'session.send', () => session.send(params.sessionId, {
      text: params.text,
      model: params.model,
      ...(params.attachments === undefined ? {} : { attachments: params.attachments }),
    })))
  router.register('session.interrupt', (params, _message, context) =>
    call(context, 'session.interrupt', async () => {
      await session.interrupt(params.sessionId, params.turn)
      return {}
    }))
  router.register('session.events', (params, _message, context) =>
    call(context, 'session.events', () => pollEvents(session, params)))
  router.register('session.context.inspect', (params, _message, context) =>
    call(context, 'session.context.inspect', () => session.inspectContext(params)))
  router.register('session.media.read', (params, _message, context) =>
    call(context, 'session.media.read', () => session.readMedia(params.sessionId, params.path)))
  router.register('session.delete', (params, _message, context) =>
    call(context, 'session.delete', async () => {
      await session.deleteSession(params.sessionId)
      return {}
    }))
}
