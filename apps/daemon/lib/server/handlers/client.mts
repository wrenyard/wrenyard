/**
 * Client handler — server-side protocol adapter.
 *
 * Registers the client.list and client.action RPC handlers that delegate to an
 * injected client handler service (the daemon-wide agent-client listing and
 * install/upgrade). The service owns the detection and the npm jobs; this module
 * is a pure adapter with no filesystem or process imports.
 */

import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type {
  ClientAction,
  ClientActionParams,
  ClientActionResult,
  ClientListEntry,
  ClientListHost,
  ClientListParams,
  ClientListResult,
} from '../../protocol/methods/client.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface ClientHandlerService {
  listClients(params?: ClientListParams): Promise<ClientListEntry[]>
  act(id: string, action: ClientAction): Promise<ClientListEntry>
  host(): ClientListHost
}

export function registerClientHandlers(router: RpcRouter, service?: ClientHandlerService): void {
  if (!service) {
    router.register('client.list', () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'client service not available in this runtime' },
        { service: 'client', code: 'client_unavailable' },
      )
    })
    router.register('client.action', () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'client service not available in this runtime' },
        { service: 'client', code: 'client_unavailable' },
      )
    })
    return
  }

  router.register('client.list', async (params: ClientListParams) => {
    return { clients: await service.listClients(params), host: await service.host() } satisfies ClientListResult
  })

  router.register('client.action', async (params: ClientActionParams) => {
    return { client: await service.act(params.id, params.action) } satisfies ClientActionResult
  })
}
