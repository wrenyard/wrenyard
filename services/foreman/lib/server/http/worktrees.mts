import type { IncomingMessage, ServerResponse } from 'node:http'

import { ProtocolError } from '../../protocol/errors.mts'
import type { ProjectWorktreeMergeResult } from '../../protocol/registry.mts'
import {
  errorMessage,
  methodNotAllowed,
  readJsonBody,
  requiredBodyString,
  sendJson,
} from './shared.mts'
import { invokeHttpRpc, sendProtocolHttpError, type HttpRpcContext } from './rpc.mts'

export async function handleWorktreesApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  context: HttpRpcContext,
): Promise<void> {
  if (segments.length === 2 && segments[1] === 'merge') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST')

    const body = await readJsonBody(req)
    if (typeof body === 'string') return sendJson(res, 400, { error: body })

    const project = requiredBodyString(body, 'project')
    if (typeof project !== 'string') return sendJson(res, 400, { error: project.error })
    const worktreeId = requiredBodyString(body, 'worktree_id')
    if (typeof worktreeId !== 'string') return sendJson(res, 400, { error: worktreeId.error })

    try {
      const result = await invokeHttpRpc('project.worktree.merge', {
        project,
        worktree_id: worktreeId,
      }, context)
      sendJson(res, worktreeMergeHttpStatus(result), result)
    } catch (error) {
      if (error instanceof Error && !(error instanceof ProtocolError)) {
        sendJson(res, 400, {
          error: 'worktree merge failed',
          message: errorMessage(error),
        })
        return
      }
      sendProtocolHttpError((statusCode, value) => sendJson(res, statusCode, value), error, 'worktree merge failed')
    }
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

function worktreeMergeHttpStatus(result: ProjectWorktreeMergeResult): number {
  if (result.merged) return result.removed ? 200 : 500
  if (result.reason === 'worktree_metadata_missing' || result.reason === 'worktree_path_missing') return 404
  if (
    result.reason === 'project_missing' ||
    result.reason === 'invalid_worktree_id' ||
    result.reason === 'metadata_project_missing' ||
    result.reason === 'project_unsupported' ||
    result.reason === 'project_path_missing' ||
    result.reason === 'project_mismatch'
  ) return 400
  return 409
}
