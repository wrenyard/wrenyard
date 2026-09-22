import type { IncomingMessage, ServerResponse } from 'node:http'

import { isTaskRunRejection } from '../../core/task/service.mts'
import {
  type JsonRecord,
  methodNotAllowed,
  readJsonBody,
  requiredBodyString,
  sendJson,
} from './shared.mts'
import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'

export async function handleTasksApiRequest(
  res: ServerResponse,
  segments: string[],
  context: HttpRpcContext,
): Promise<boolean> {
  if (segments.length === 1 && segments[0] === 'tasks') {
    try {
      sendJson(res, 200, await invokeHttpRpc('task.run.list', {}, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return true
  }

  if (segments.length === 2 && segments[0] === 'tasks') {
    try {
      const status = await invokeHttpRpc('task.run.status', { task_run_id: segments[1] }, context)
      sendJson(res, 200, status)
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return true
  }

  return false
}

export async function handleTaskApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  context: HttpRpcContext,
): Promise<void> {
  if (method !== 'POST' && method !== 'GET') return methodNotAllowed(res, 'GET, POST')

  if (segments.length === 2 && segments[0] === 'task' && segments[1] === 'list' && method === 'GET') {
    try {
      const tasks = await invokeHttpRpc('task.definition.list', {}, context)
      sendJson(res, 200, { tasks })
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'list' && method === 'GET') {
    const project = decodeURIComponent(segments[2])
    try {
      const tasks = await invokeHttpRpc('task.definition.list', { project }, context)
      sendJson(res, 200, { tasks, project })
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'describe' && method === 'GET') {
    const taskId = decodeURIComponent(segments[2])
    try {
      sendJson(res, 200, await invokeHttpRpc('task.definition.describe', { task_id: taskId }, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'status' && method === 'GET') {
    try {
      sendJson(res, 200, await invokeHttpRpc('task.run.status', { task_run_id: segments[2] }, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'output' && method === 'GET') {
    try {
      sendJson(res, 200, await invokeHttpRpc('task.run.output', { task_run_id: segments[2] }, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'run' && method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body === 'string') return sendJson(res, 400, { error: body })

    const taskId = decodeURIComponent(segments[2])
    const project = requiredBodyString(body, 'project')
    if (typeof project !== 'string') return sendJson(res, 400, { error: project.error })

    try {
      const result = await invokeHttpRpc('task.run.create', {
        task_id: taskId,
        project,
        input: body.input as JsonRecord | null | undefined,
        ctx: body.ctx as JsonRecord | undefined,
      }, context)
      sendJson(res, isTaskRunRejection(result) ? 400 : 200, result)
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 3 && segments[0] === 'task' && segments[1] === 'cancel' && method === 'POST') {
    try {
      sendJson(res, 200, await invokeHttpRpc('task.run.cancel', { task_run_id: segments[2] }, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  if (segments.length === 4 && segments[0] === 'task' && segments[1] === 'run' && segments[2] === 'events' && method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body === 'string') return sendJson(res, 400, { error: body })

    try {
      sendJson(res, 200, await invokeHttpRpc('task.run.events', {
        task_run_id: segments[3],
        after_seq: body?.after_seq as number | undefined,
        limit: body?.limit as number | undefined,
      }, context))
    } catch (error) {
      sendTaskRpcError(res, error)
    }
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

function sendTaskRpcError(res: ServerResponse, error: unknown): void {
  sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'task request failed')
}
