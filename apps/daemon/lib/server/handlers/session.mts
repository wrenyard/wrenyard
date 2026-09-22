import type { SessionService } from '@wrenyard/session'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type {
  SessionBackendResult,
  SessionCancelParams,
  SessionCreateParams,
  SessionSelectModelParams,
  SessionSelectParams,
  SessionSendParams,
  SessionSetWorkspaceParams,
  SessionSnapshotParams,
  SessionSummaryModelSetParams,
} from '../../protocol/methods/session.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface SessionRpcHandlerOptions {
  sessionService: SessionService
}

/**
 * Register the `session.*` IPC surface against the injected SessionService.
 *
 * Every method is IPC-only: session requests reach the daemon-owned DSH
 * backend and DSH MCP tools legitimately use IPC, but the HTTP and MCP
 * transports must never execute a conversation action.
 *
 * The handler is a thin transport over the feature. Conversation semantics —
 * including the authoritative-workspace validation that `session.setWorkspace`
 * must perform against the configured workspace root — are owned by the
 * SessionService so Desktop, CLI and daemon all agree on one rule.
 */
export function registerSessionHandlers(router: RpcRouter, options: SessionRpcHandlerOptions): void {
  const requireIpc = (context: unknown, method: string): void => {
    const transport = rpcTransport(context)
    if (transport === 'ipc') return
    throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
      { code: 'session_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
    )
  }

  const call = async <TResult,>(operation: () => Promise<TResult>): Promise<TResult> => {
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

  router.register('session.snapshot', (params, _message, context) => {
    requireIpc(context, 'session.snapshot')
    return call(() => options.sessionService.snapshot(params as SessionSnapshotParams))
  })

  router.register('session.select', (params, _message, context) => {
    requireIpc(context, 'session.select')
    return call(() => options.sessionService.select(params as SessionSelectParams))
  })

  router.register('session.create', (params, _message, context) => {
    requireIpc(context, 'session.create')
    return call(() => options.sessionService.create(params as SessionCreateParams))
  })

  router.register('session.selectModel', (params, _message, context) => {
    requireIpc(context, 'session.selectModel')
    return call(() => options.sessionService.selectModel(params as SessionSelectModelParams))
  })

  router.register('session.send', (params, _message, context) => {
    requireIpc(context, 'session.send')
    return call(() => options.sessionService.send(params as SessionSendParams))
  })

  router.register('session.cancel', (params, _message, context) => {
    requireIpc(context, 'session.cancel')
    return call(() => options.sessionService.cancel(params as SessionCancelParams))
  })

  router.register('session.setWorkspace', (params, _message, context) => {
    requireIpc(context, 'session.setWorkspace')
    return call(() => options.sessionService.setWorkspace(params as SessionSetWorkspaceParams))
  })

  router.register('session.summary.model.get', (_params, _message, context) => {
    requireIpc(context, 'session.summary.model.get')
    return call(() => options.sessionService.getSummaryModel())
  })

  router.register('session.summary.model.set', (params, _message, context) => {
    requireIpc(context, 'session.summary.model.set')
    return call(() => options.sessionService.setSummaryModel(params as SessionSummaryModelSetParams))
  })

  router.register('session.backend', (_params, _message, context): SessionBackendResult => {
    requireIpc(context, 'session.backend')
    return options.sessionService.backend()
  })
}

function rpcTransport(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
  const value = (context as { transport?: unknown }).transport
  return value === 'ipc' || value === 'http' || value === 'mcp' ? value : undefined
}
