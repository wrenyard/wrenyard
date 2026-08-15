import type { ServerResponse } from 'node:http'

import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'
import { sendJson } from './shared.mts'

export async function handleStatsApiRequest(res: ServerResponse, context: HttpRpcContext): Promise<void> {
  try {
    sendJson(res, 200, await invokeHttpRpc('stats.today', {}, context))
  } catch (error) {
    sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'stats query failed')
  }
}
