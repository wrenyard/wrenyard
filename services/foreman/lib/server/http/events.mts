import type { ServerResponse } from 'node:http'

import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'
import {
  parseNonNegativeInteger,
  sendJson,
} from './shared.mts'

export async function handleEventsApiRequest(res: ServerResponse, url: URL, context: HttpRpcContext): Promise<void> {
  const params = parseEventQueryParams(url)
  if ('error' in params) {
    sendJson(res, 400, { error: params.error })
    return
  }

  try {
    sendJson(res, 200, await invokeHttpRpc('event.list', params, context))
  } catch (error) {
    sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'events query failed')
  }
}

function parseEventQueryParams(url: URL): { since: number; limit: number } | { error: string } {
  const since = parseNonNegativeInteger(url.searchParams.get('since'), 'since', 0)
  if (typeof since === 'string') return { error: since }
  const limit = parseNonNegativeInteger(url.searchParams.get('limit'), 'limit', 100)
  if (typeof limit === 'string') return { error: limit }
  if (limit < 1 || limit > 1000) return { error: 'limit must be between 1 and 1000' }
  return { since, limit }
}
