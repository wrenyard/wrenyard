import type { IncomingMessage, ServerResponse } from 'node:http'

import { methodNotAllowed, readJsonBody, sendJson } from './shared.mts'
import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'
import type { ForemanMethod, MethodParams } from '../../protocol/registry.mts'

const SUFFIX_MAP: Record<string, string> = {
  create: 'taskgraph.create',
  patch: 'taskgraph.patch',
  status: 'taskgraph.status',
  events: 'taskgraph.events',
  signal: 'taskgraph.signal',
  'node/inspect': 'taskgraph.node.inspect',
  inspect: 'taskgraph.inspect',
  list: 'taskgraph.list',
  wait: 'taskgraph.wait',
  slip: 'taskgraph.slip',
}

export async function handleTaskgraphApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  context: HttpRpcContext,
): Promise<void> {
  if (method !== 'POST') return methodNotAllowed(res, 'POST')

  if (segments.length < 2 || segments[0] !== 'taskgraph') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const suffix = segments.slice(1).join('/')
  const rpcMethod = SUFFIX_MAP[suffix] as ForemanMethod
  if (!rpcMethod) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const body = await readJsonBody(req)
  if (typeof body === 'string') return sendJson(res, 400, { error: body })

  try {
    sendJson(res, 200, await invokeHttpRpc(rpcMethod, body as MethodParams<ForemanMethod>, context))
  } catch (error) {
    sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'TaskGraph')
  }
}
