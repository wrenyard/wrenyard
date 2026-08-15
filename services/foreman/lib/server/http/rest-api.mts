import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleEventsApiRequest } from './events.mts'
import { handleHealthApiRequest } from './health.mts'
import { handlePmApiRequest } from './pm.mts'
import { handleStatsApiRequest } from './stats.mts'
import { handleTaskApiRequest, handleTasksApiRequest } from './task.mts'
import { handleTaskgraphApiRequest } from './taskgraph.mts'
import { handleWorktreesApiRequest } from './worktrees.mts'
import type { HttpRpcContext } from './rpc.mts'
import {
  errorMessage,
  isDbUnavailable,
  methodNotAllowed,
  sendJson,
} from './shared.mts'

export interface RestApiContext extends HttpRpcContext {
  startedAt?: number
}

/**
 * Handle REST API requests. Route handlers live under lib/server/http; this
 * dispatcher keeps legacy REST paths as compatibility forwards. The preferred
 * external surface is /api/v1/*, and business calls go through context.rpcRouter.
 */
export function handleRestApiRequest(req: IncomingMessage, res: ServerResponse, context: RestApiContext): boolean {
  res.setHeader('Content-Type', 'application/json')

  const parsedURL = new URL(req.url ?? '/', 'http://127.0.0.1')
  const rawSegments = parsedURL.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })
  const segments = restRouteSegments(rawSegments)

  if (!segments || !isRestPath(segments)) return false

  const method = req.method?.toUpperCase() ?? 'GET'

  if (segments[0] === 'worktrees') {
    void handleWorktreesApiRequest(req, res, segments, method, context).catch((error: unknown) => {
      sendJson(res, 500, {
        error: 'worktree request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (segments[0] === 'task') {
    void handleTaskApiRequest(req, res, segments, method, context).catch((error: unknown) => {
      sendJson(res, isDbUnavailable(error) ? 503 : 500, {
        error: 'task request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (segments[0] === 'pm') {
    void handlePmApiRequest(req, res, segments, method, context).catch((error: unknown) => {
      sendJson(res, isDbUnavailable(error) ? 503 : 500, {
        error: 'pm ticket request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (segments[0] === 'taskgraph') {
    void handleTaskgraphApiRequest(req, res, segments, method, context).catch((error: unknown) => {
      sendJson(res, isDbUnavailable(error) ? 503 : 500, {
        error: 'taskgraph request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return true
  }

  if (segments.length === 1 && segments[0] === 'health') {
    void handleHealthApiRequest(res, context).catch((error: unknown) => {
      sendJson(res, 500, {
        error: 'health request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (segments[0] === 'tasks' && (segments.length === 1 || segments.length === 2)) {
    void handleTasksApiRequest(res, segments, context).catch((error: unknown) => {
      sendJson(res, isDbUnavailable(error) ? 503 : 500, {
        error: 'task request failed',
        message: errorMessage(error),
      })
    })
    return true
  }

  if (segments.length === 1 && segments[0] === 'events') {
    void handleEventsApiRequest(res, parsedURL, context)
    return true
  }

  if (segments.length === 2 && segments[0] === 'stats' && segments[1] === 'today') {
    void handleStatsApiRequest(res, context)
    return true
  }

  return false
}

function restRouteSegments(segments: string[]): string[] | null {
  if (segments[0] === 'api' && segments[1] === 'v1') return segments.slice(2)
  return segments
}

function isRestPath(segments: string[]): boolean {
  if (segments.length === 0) return false
  const root = segments[0]
  return root === 'health' ||
    root === 'tasks' ||
    root === 'events' ||
    root === 'worktrees' ||
    root === 'stats' ||
    root === 'task' ||
    root === 'pm' ||
    root === 'taskgraph'
}
