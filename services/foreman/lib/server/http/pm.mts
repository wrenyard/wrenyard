import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  PmTicketCreateParams,
  PmTicketListParams,
  PmTicketUpdateParams,
} from '../../protocol/registry.mts'
import {
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from './shared.mts'
import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'

export async function handlePmApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  context: HttpRpcContext,
): Promise<void> {
  if (segments.length === 2 && segments[0] === 'pm' && segments[1] === 'tickets') {
    if (method !== 'GET' && method !== 'POST') return methodNotAllowed(res, 'GET, POST')
    if (method === 'GET') return listTickets(req, res, context)
    return createTicket(req, res, context)
  }

  if (segments.length === 3 && segments[0] === 'pm' && segments[1] === 'tickets') {
    if (method !== 'GET' && method !== 'PATCH' && method !== 'DELETE') {
      return methodNotAllowed(res, 'GET, PATCH, DELETE')
    }
    const id = segments[2]
    if (method === 'GET') return getTicket(res, id, context)
    if (method === 'PATCH') return updateTicket(req, res, id, context)
    return deleteTicket(res, id, context)
  }

  sendJson(res, 404, { error: 'not found' })
}

async function listTickets(
  req: IncomingMessage,
  res: ServerResponse,
  context: HttpRpcContext,
): Promise<void> {
  const parsedURL = new URL(req.url ?? '/', 'http://127.0.0.1')
  const projectId = queryString(parsedURL, 'project_id', true)
  if (typeof projectId !== 'string') {
    return sendJson(res, 400, { error: isQueryError(projectId) ? projectId.error : 'project_id is required' })
  }

  const kind = queryString(parsedURL, 'kind')
  if (isQueryError(kind)) return sendJson(res, 400, { error: kind.error })
  const status = queryString(parsedURL, 'status')
  if (isQueryError(status)) return sendJson(res, 400, { error: status.error })
  const parentId = queryString(parsedURL, 'parent_id')
  if (isQueryError(parentId)) return sendJson(res, 400, { error: parentId.error })
  const assigneeSessionId = queryString(parsedURL, 'assignee_session_id')
  if (isQueryError(assigneeSessionId)) return sendJson(res, 400, { error: assigneeSessionId.error })

  const params: PmTicketListParams = {
    project_id: projectId,
    ...(kind ? { kind: kind as PmTicketListParams['kind'] } : {}),
    ...(status ? { status: status as PmTicketListParams['status'] } : {}),
    ...(parentId ? { parent_id: parentId } : {}),
    ...(assigneeSessionId ? { assignee_session_id: assigneeSessionId } : {}),
  }

  try {
    sendJson(res, 200, await invokeHttpRpc('pm.ticket.list', params, context))
  } catch (error) {
    sendPmRpcError(res, error)
  }
}

async function createTicket(
  req: IncomingMessage,
  res: ServerResponse,
  context: HttpRpcContext,
): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body === 'string') return sendJson(res, 400, { error: body })

  try {
    sendJson(res, 201, await invokeHttpRpc('pm.ticket.create', body as unknown as PmTicketCreateParams, context))
  } catch (error) {
    sendPmRpcError(res, error)
  }
}

async function getTicket(
  res: ServerResponse,
  id: string,
  context: HttpRpcContext,
): Promise<void> {
  try {
    sendJson(res, 200, await invokeHttpRpc('pm.ticket.get', { id }, context))
  } catch (error) {
    sendPmRpcError(res, error)
  }
}

async function updateTicket(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  context: HttpRpcContext,
): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body === 'string') return sendJson(res, 400, { error: body })

  if ('id' in body && body.id !== id) {
    return sendJson(res, 400, { error: 'id in path and body must match' })
  }

  try {
    const params = { ...body, id } as unknown as PmTicketUpdateParams
    sendJson(res, 200, await invokeHttpRpc('pm.ticket.update', params, context))
  } catch (error) {
    sendPmRpcError(res, error)
  }
}

async function deleteTicket(
  res: ServerResponse,
  id: string,
  context: HttpRpcContext,
): Promise<void> {
  try {
    sendJson(res, 200, await invokeHttpRpc('pm.ticket.delete', { id }, context))
  } catch (error) {
    sendPmRpcError(res, error)
  }
}

function queryString(parsedURL: URL, key: string, required = false): string | undefined | { error: string } {
  const raw = parsedURL.searchParams.get(key)
  if (raw === null) {
    return required ? { error: `${key} is required` } : undefined
  }
  const trimmed = raw.trim()
  if (!trimmed) return { error: `${key} must be non-empty when provided` }
  return trimmed
}

function isQueryError(value: string | undefined | { error: string }): value is { error: string } {
  return !!value && typeof value === 'object'
}

function sendPmRpcError(res: ServerResponse, error: unknown): void {
  sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'pm ticket request failed')
}
