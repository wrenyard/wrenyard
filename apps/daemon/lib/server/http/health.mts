import type { ServerResponse } from 'node:http'

import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'
import { sendJson } from './shared.mts'

export async function handleHealthApiRequest(
  res: ServerResponse,
  context: HttpRpcContext & { startedAt?: number },
): Promise<void> {
  try {
    const ping = await invokeHttpRpc('health.ping', {}, context)
    const activeTasks = await invokeHttpRpc('task.run.list', {}, context)
    sendJson(res, 200, {
      status: ping.ok ? 'ok' : 'error',
      uptime: typeof ping.uptimeMs === 'number' ? ping.uptimeMs / 1000 : process.uptime(),
      startedAt: context.startedAt ?? null,
      tasksActive: activeTasks.count,
    })
  } catch (error) {
    sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'health request failed')
  }
}
