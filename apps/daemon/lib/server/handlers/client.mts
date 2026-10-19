/**
 * Client handler — server-side protocol adapter.
 *
 * Registers the client.list RPC handler that delegates to an injected client
 * handler service (the daemon-wide agent-client listing). The service owns the
 * detection; this module is a pure adapter with no filesystem or process
 * imports.
 */

import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { ClientListEntry, ClientListResult } from '../../protocol/methods/client.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface ClientHandlerService {
  listClients(): Promise<ClientListEntry[]>
}

export function registerClientHandlers(router: RpcRouter, service?: ClientHandlerService): void {
  if (!service) {
    router.register('client.list', () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'client service not available in this runtime' },
        { service: 'client', code: 'client_unavailable' },
      )
    })
    return
  }

  router.register('client.list', async () => {
    return { clients: await service.listClients() } satisfies ClientListResult
  })
}
