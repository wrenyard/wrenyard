import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closeDb, initDb, run as dbRun } from '../../lib/db/connection.mts'
import { handleRestApiRequest } from '../../lib/server/http/rest-api.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { taskgraphProtocolCases } from '../taskgraph/protocol-shell-fixtures.mts'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  closeDb()
  initDb(':memory:')
})

afterEach(() => {
  closeDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('Foreman HTTP status API', () => {
  it('rejects non-GET requests on owned REST paths with 405', async () => {
    const running = await startTestApi()
    try {
      const resp = await fetch(`${running.url}/tasks`, { method: 'POST' })
      assert.equal(resp.status, 405)
    } finally {
      await running.close()
    }
  })

  it('lets non-GET requests for non-REST paths fall through', async () => {
    const running = await startTestApi()
    try {
      const resp = await fetch(`${running.url}/message/inbound`, { method: 'POST' })
      // handleRestApiRequest returns false for /message/*, so the test server
      // fallback returns 404 — but not the blanket 405 that blocked message routes before.
      assert.equal(resp.status, 404)
    } finally {
      await running.close()
    }
  })

  it('does not expose the legacy sessions REST surface', async () => {
    const running = await startTestApi()
    try {
      const resp = await fetch(`${running.url}/sessions`)
      assert.equal(resp.status, 404)
    } finally {
      await running.close()
    }
  })

  it('serves health from the merged REST handler', async () => {
    const running = await startTestApi()

    try {
      const health = await getJson(`${running.url}/health`) as {
        status: string
        uptime: number
        startedAt: number
        tasksActive: number
      }
      assert.equal(health.status, 'ok')
      assert.equal(typeof health.uptime, 'number')
      assert.equal(health.startedAt, running.startedAt)
      assert.equal(health.tasksActive, 0)
    } finally {
      await running.close()
    }
  })

  it('serves the preferred /api/v1 health route through the same handler', async () => {
    const running = await startTestApi()

    try {
      const health = await getJson(`${running.url}/api/v1/health`) as {
        status: string
        startedAt: number
      }
      assert.equal(health.status, 'ok')
      assert.equal(health.startedAt, running.startedAt)
    } finally {
      await running.close()
    }
  })

  it('serves DB-backed local-day dispatch and token totals', async () => {
    const running = await startTestApi()
    try {
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).toISOString()
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0).toISOString()

      insertExecutionRow('exec_stats_today_1', today)
      insertExecutionRow('exec_stats_today_2', today)
      insertExecutionRow('exec_stats_yesterday', yesterday)

      insertEventRow('exec_stats_today_1', 1, 'dispatch', today, {})
      insertEventRow('exec_stats_today_1', 2, 'turn_usage', today, { input_tokens: 120, output_tokens: 34 })
      insertEventRow('exec_stats_today_2', 1, 'dispatch', today, {})
      insertEventRow('exec_stats_today_2', 2, 'turn_usage', today, { input_tokens: 10, output_tokens: 5 })
      insertEventRow('exec_stats_yesterday', 1, 'dispatch', yesterday, {})
      insertEventRow('exec_stats_yesterday', 2, 'turn_usage', yesterday, { input_tokens: 999, output_tokens: 999 })

      const stats = await getJson(`${running.url}/stats/today`) as {
        dayKey: string
        dispatchCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        source: string
      }

      assert.match(stats.dayKey, /^\d{4}-\d{2}-\d{2}$/u)
      assert.equal(stats.dispatchCount, 2)
      assert.equal(stats.inputTokens, 130)
      assert.equal(stats.outputTokens, 39)
      assert.equal(stats.totalTokens, 169)
      assert.equal(stats.source, 'sqlite')
    } finally {
      await running.close()
    }
  })

  it('returns task status from execution records without output payloads', async () => {
    const running = await startTestApi()
    try {
      insertTaskRow({
        task_id: 'task_http_structured',
        status: 'done',
        summary: 'classified as urgent',
        output: { summary: 'classified as urgent', priority: 'high' },
        structured: true,
      })

      const status = await getJson(`${running.url}/tasks/task_http_structured`) as {
        task_run_id: string
        status: string
        output?: string
        summary?: string
        has_output?: boolean
      }

      assert.equal(status.task_run_id, 'task_http_structured')
      assert.equal(status.status, 'done')
      assert.equal(status.output, undefined)
      assert.equal(status.summary, 'classified as urgent')
      assert.equal(status.has_output, true)
    } finally {
      await running.close()
    }
  })

  it('returns failure details from execution records', async () => {
    const running = await startTestApi()
    try {
      insertTaskRow({
        task_id: 'task_http_failed',
        status: 'failed',
        output: '',
        error: 'quota exhausted',
        failure_category: 'failure_quota_exhausted',
        suggestion: 'use codex-mini',
        error_message: '429 rate limit',
      })

      const status = await getJson(`${running.url}/tasks/task_http_failed`) as {
        task_run_id: string
        status: string
        error: string
        failure_category: string
        suggestion: string
        error_message: string
      }

      assert.equal(status.task_run_id, 'task_http_failed')
      assert.equal(status.status, 'failed')
      assert.equal(status.error, 'quota exhausted')
      assert.equal(status.failure_category, 'failure_quota_exhausted')
      assert.equal(status.suggestion, 'use codex-mini')
      assert.equal(status.error_message, '429 rate limit')
    } finally {
      await running.close()
    }
  })



  it('returns fuzzy project suggestions through the task API', async () => {
    const workspace = makeTempDir('foreman-http-workspace-')
    writeFmproj(workspace, 'ure/knowledge')
    const running = await startTestApi(workspace)
    try {
      const response = await fetch(`${running.url}/task/list/knowledge`)
      const body = await response.json() as {
        error?: string
        message?: string
        details?: { suggestions?: string[] }
      }

      assert.equal(response.status, 404)
      assert.equal(body.error, 'project_not_found')
      assert.match(body.message ?? '', /Did you mean: ure\/knowledge/u)
      assert.deepEqual(body.details?.suggestions, ['ure/knowledge'])
    } finally {
      await running.close()
    }
  })

  it('serves PM ticket CRUD through the preferred REST API', async () => {
    const workspace = makeTempDir('foreman-http-pm-workspace-')
    writeFmproj(workspace, 'foreman')
    const running = await startTestApi(workspace)
    try {
      const createdMain = await postJson(`${running.url}/api/v1/pm/tickets`, {
        kind: 'main',
        project_id: 'foreman',
        title: 'Main ticket',
        assignee: { session_id: 'session_main' },
      }) as {
        status: number
        body: { ticket?: { id?: string; kind?: string; title?: string; assignee?: { session_id?: string } } }
      }
      assert.equal(createdMain.status, 201)
      assert.match(createdMain.body.ticket?.id ?? '', /^pm_/u)
      assert.equal(createdMain.body.ticket?.kind, 'main')
      assert.equal(createdMain.body.ticket?.assignee?.session_id, 'session_main')

      const mainTicketId = createdMain.body.ticket?.id ?? ''
      const createdSub = await postJson(`${running.url}/api/v1/pm/tickets`, {
        kind: 'sub',
        project_id: 'foreman',
        title: 'Sub ticket',
        parent_id: mainTicketId,
      }) as {
        status: number
        body: { ticket?: { id?: string; kind?: string; parent_id?: string } }
      }
      assert.equal(createdSub.status, 201)
      assert.match(createdSub.body.ticket?.id ?? '', /^pm_/u)
      assert.equal(createdSub.body.ticket?.kind, 'sub')
      assert.equal(createdSub.body.ticket?.parent_id, mainTicketId)

      const list = await getJson(`${running.url}/api/v1/pm/tickets?project_id=foreman`) as {
        count: number
        tickets: Array<{ id?: string }>
      }
      assert.equal(list.count, 2)
      assert.equal(list.tickets.some((ticket) => ticket.id === mainTicketId), true)

      const subTicketId = createdSub.body.ticket?.id ?? ''
      const updatedSub = await patchJson(`${running.url}/api/v1/pm/tickets/${subTicketId}`, {
        action: 'set_status',
        status: 'in_progress',
      }) as {
        status: number
        body: { ticket?: { id?: string; status?: string } }
      }
      assert.equal(updatedSub.status, 200)
      assert.equal(updatedSub.body.ticket?.id, subTicketId)
      assert.equal(updatedSub.body.ticket?.status, 'in_progress')

      const mismatchedPatch = await patchJson(`${running.url}/api/v1/pm/tickets/${subTicketId}`, {
        id: mainTicketId,
        action: 'set_status',
        status: 'blocked',
      }) as { status: number; body: { error?: string } }
      assert.equal(mismatchedPatch.status, 400)
      assert.equal(mismatchedPatch.body.error, 'id in path and body must match')

      const deleted = await deleteJson(`${running.url}/api/v1/pm/tickets/${subTicketId}`) as {
        status: number
        body: { deleted?: boolean; id?: string }
      }
      assert.equal(deleted.status, 200)
      assert.equal(deleted.body.deleted, true)
      assert.equal(deleted.body.id, subTicketId)

      const missing = await fetch(`${running.url}/api/v1/pm/tickets/${subTicketId}`)
      const missingBody = await missing.json() as { error?: string }
      assert.equal(missing.status, 404)
      assert.equal(missingBody.error, 'ticket_not_found')
    } finally {
      await running.close()
    }
  })

  it('routes worktree merge requests through the ProjectManager core', async () => {
    const workspace = makeTempDir('foreman-http-workspace-')
    const projectDir = writeFmproj(workspace, 'app')
    const running = await startTestApi(workspace)
    try {
      const response = await postJson(`${running.url}/worktrees/merge`, {
        project: 'app',
        worktree_id: 'deadbeef',
      }) as {
        status: number
        body: { project?: string; worktree_id?: string; reason?: string; worktree_path?: string; error?: string }
      }

      assert.equal(projectDir.endsWith(join('projects', 'app')), true)
      assert.equal(response.status, 404)
      assert.deepEqual(response.body, {
        project: 'app',
        worktree_id: 'deadbeef',
        merged: false,
        removed: false,
        reason: 'worktree_metadata_missing',
        error: "Worktree 'deadbeef' metadata was not found",
      })
    } finally {
      await running.close()
    }
  })

  it('validates worktree merge JSON bodies', async () => {
    const running = await startTestApi()
    try {
      const response = await postJson(`${running.url}/worktrees/merge`, {
        project: 'app',
      }) as { status: number; body: { error?: string } }

      assert.equal(response.status, 400)
      assert.deepEqual(response.body, { error: 'worktree_id is required' })
    } finally {
      await running.close()
    }
  })

  it('does not expose cc-channel notification state in task status', async () => {
    const running = await startTestApi()
    try {
      insertTaskRow({
        task_id: 'task_notified',
        status: 'done',
        output: 'ok',
        notified_via_channel: true,
      })

      const status = await getJson(`${running.url}/tasks/task_notified`) as {
        task_run_id: string
        notified_via_channel?: boolean
      }

      assert.equal(status.task_run_id, 'task_notified')
      assert.equal(status.notified_via_channel, undefined)
    } finally {
      await running.close()
    }
  })


  it('omits notified_via_channel when not set on the record', async () => {
    const running = await startTestApi()
    try {
      insertTaskRow({
        task_id: 'task_plain',
        status: 'done',
        output: 'ok',
      })

      const status = await getJson(`${running.url}/tasks/task_plain`) as Record<string, unknown>
      assert.equal(status.task_run_id, 'task_plain')
      assert.equal('notified_via_channel' in status, false)
    } finally {
      await running.close()
    }
  })

  describe('task.run.events HTTP parity', () => {
    function setupEventsTask(taskRunId: string, executionId: string): void {
      insertExecutionRow(executionId, new Date().toISOString())
      insertTaskRow({ task_id: taskRunId, status: 'done', output: 'ok' })
      dbRun(`UPDATE tasks SET execution_id = ? WHERE id = ?`, executionId, taskRunId)
    }

    it('omitted pagination defaults are valid', async () => {
      const running = await startTestApi()
      try {
        setupEventsTask('tr_http_omit', 'exec_http_omit')
        const resp = await postJson(`${running.url}/task/run/events/tr_http_omit`, {})
        assert.equal(resp.status, 200)
        const body = resp.body as { task_run_id?: string; events?: unknown[] }
        assert.equal(body.task_run_id, 'tr_http_omit')
        assert.ok(Array.isArray(body.events))
      } finally {
        await running.close()
      }
    })

    it('rejects non-number after_seq with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: 'abc', limit: 10 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })

    it('rejects fractional after_seq with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: 1.5, limit: 10 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })

    it('rejects negative after_seq with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: -1, limit: 10 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })

    it('rejects zero limit with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: 0, limit: 0 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })

    it('rejects out-of-range limit with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: 0, limit: 999999 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })

    it('rejects negative limit with INVALID_PARAMS', async () => {
      const running = await startTestApi()
      try {
        const resp = await postJson(`${running.url}/task/run/events/tr_noid`, { after_seq: 0, limit: -5 })
        assert.equal(resp.status, 400)
        assert.equal((resp.body as { message?: string }).message, 'Invalid params')
      } finally {
        await running.close()
      }
    })
  })
})

describe('Foreman TaskGraph HTTP adapter', () => {
  it('drives all seven TaskGraph kernel methods over HTTP', async () => {
    const running = await startTestApi()
    try {
      const create = await postJson(
        `${running.url}/api/v1/taskgraph/create`,
        taskgraphProtocolCases[0].legalParams as Record<string, unknown>,
      )
      assert.equal(create.status, 200)
      const created = create.body as { taskgraph: { id: string; status: string } }
      const taskgraphId = created.taskgraph.id
      assert.equal(created.taskgraph.status, 'created')

      const status = await postJson(`${running.url}/api/v1/taskgraph/status`, {
        taskgraph_id: taskgraphId,
      })
      assert.equal(status.status, 200)
      assert.equal((status.body as { state: string }).state, 'created')

      const inspect = await postJson(`${running.url}/api/v1/taskgraph/node/inspect`, {
        taskgraph_id: taskgraphId,
        node_id: 'start',
      })
      assert.equal(inspect.status, 200)
      assert.equal((inspect.body as { run: { state: string } }).run.state, 'planned')

      const graphInspect = await postJson(`${running.url}/api/v1/taskgraph/inspect`, {
        taskgraph_id: taskgraphId,
      })
      assert.equal(graphInspect.status, 200)
      const graphInspectBody = graphInspect.body as { graph: { id: string; revision: number } }
      assert.equal(graphInspectBody.graph.id, taskgraphId)
      assert.equal(graphInspectBody.graph.revision, 1)

      const previewResponse = await postJson(`${running.url}/api/v1/taskgraph/patch`, {
        taskgraph_id: taskgraphId,
        operation: {
          type: 'request_patch',
          patch: {
            base_revision: 1,
            actor: 'http-test',
            reason: 'no-op',
            created_at: new Date().toISOString(),
            ops: [],
          },
        },
      })
      assert.equal(previewResponse.status, 200)
      const preview = previewResponse.body as { type: string; patch_id: string }
      assert.equal(preview.type, 'preview')

      const applied = await postJson(`${running.url}/api/v1/taskgraph/patch`, {
        taskgraph_id: taskgraphId,
        operation: { type: 'confirm_patch', patch_id: preview.patch_id },
      })
      assert.equal(applied.status, 200)
      assert.deepEqual(applied.body, { type: 'applied', revision: 2 })

      const signal = await postJson(`${running.url}/api/v1/taskgraph/signal`, {
        taskgraph_id: taskgraphId,
        signal: { type: 'start_graph', input: {} },
      })
      assert.equal(signal.status, 200)
      assert.deepEqual(signal.body, { accepted: true })

      const events = await postJson(`${running.url}/api/v1/taskgraph/events`, {
        taskgraph_id: taskgraphId,
        after_seq: 0,
        limit: 100,
      })
      assert.equal(events.status, 200)
      assert.ok((events.body as { events: unknown[] }).events.length >= 2)
    } finally {
      await running.close()
    }
  })

  for (const tc of taskgraphProtocolCases) {
    const path = tc.route
    it(`rejects invalid params on ${tc.method} with INVALID_PARAMS`, async () => {
      const running = await startTestApi()
      try {
        const response = await fetch(`${running.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(tc.invalidParams),
        })
        const body = await response.json() as {
          error?: string
          message?: string
        }
        assert.equal(response.status, 400)
        assert.equal(body.message, 'Invalid params')
        assert.notEqual(body.error, 'NOT_IMPLEMENTED')
      } finally {
        await running.close()
      }
    })
  }

  it('selects the correct taskgraph RPC method and passes params through', async () => {
    const startedAt = Date.now()
    const spyCall: { method?: string; params?: unknown } = {}
    const rpcRouter = createTestRpcRouter(startedAt)
    rpcRouter.register('taskgraph.status', async (params) => {
        spyCall.method = 'taskgraph.status'
        spyCall.params = params
        return { taskgraph_id: 'tg-1', state: 'created', structure_revision: 0, latest_seq: 0, node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }
      })
    const server = createServer((req, res) => {
      if (!handleRestApiRequest(req, res, { rpcRouter, startedAt })) {
        res.statusCode = 404
        res.end('Not Found')
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${address.port}`

    try {
      const params = { taskgraph_id: 'tg-1' }
      const response = await fetch(`${url}/api/v1/taskgraph/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
      assert.equal(response.status, 200)
      assert.equal(spyCall.method, 'taskgraph.status')
      assert.deepEqual(spyCall.params, params)
    } finally {
      await closeServer(server)
    }
  })

  it('rejects non-POST methods on taskgraph routes', async () => {
    const running = await startTestApi()
    try {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const resp = await fetch(`${running.url}/api/v1/taskgraph/status`, { method })
        assert.equal(resp.status, 405)
        const body = await resp.json() as { error?: string }
        assert.equal(body.error, 'method not allowed')
      }
    } finally {
      await running.close()
    }
  })

  it('returns 404 for unknown taskgraph suffixes', async () => {
    const running = await startTestApi()
    try {
      const resp = await fetch(`${running.url}/api/v1/taskgraph/unknown`, { method: 'POST' })
      const body = await resp.json() as { error?: string }
      assert.equal(resp.status, 404)
      assert.equal(body.error, 'not found')
    } finally {
      await running.close()
    }
  })
})

async function startTestApi(workspaceRoot?: string) {
  const startedAt = Date.now()
  const rpcRouter = createTestRpcRouter(startedAt, workspaceRoot)
  const server = createServer((req, res) => {
    if (!handleRestApiRequest(req, res, { rpcRouter, startedAt })) {
      res.statusCode = 404
      res.end('Not Found')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    startedAt,
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

function createTestRpcRouter(startedAt: number, workspaceRoot?: string): RpcRouter {
  const router = new RpcRouter()
  registerCoreHandlers(router, {
    startedAt,
    workspaceRoot: workspaceRoot ?? process.cwd(),
  })
  return router
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  return response.json()
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

async function patchJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

async function deleteJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'DELETE' })
  return {
    status: response.status,
    body: await response.json(),
  }
}

function writeFmproj(workspace: string, projectId: string): string {
  const parts = projectId.split('/')
  const name = parts.at(-1)
  assert.ok(name)
  const projectDir = join(workspace, 'projects', ...parts)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${name}.fmproj`),
    `name: ${name}
description: Test project ${projectId}
git:
  remote: https://example.test/${name}.git
  default_branch: main
hosts:
  ${hostname()}: ${projectDir}
`,
    'utf-8',
  )
  return projectDir
}

function insertTaskRow(overrides: {
  task_id: string
  status?: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  output?: unknown
  summary?: string
  error?: string | null
  structured?: boolean
  failure_category?: string
  suggestion?: string
  error_message?: string
  notified_via_channel?: boolean
}): void {
  const now = new Date().toISOString()
  dbRun(
    `INSERT INTO tasks (
      id, template, project, worktree, input, output, summary, error,
      failure_category, suggestion, error_message, notified_via_channel,
      status, structured, retry_policy, created_at, updated_at, ended_at
    ) VALUES (?, 'echo', 'workspace', NULL, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'side-effects', ?, ?, ?)`,
    overrides.task_id,
    taskOutputText(overrides.output ?? ''),
    overrides.summary ?? null,
    overrides.error ?? null,
    overrides.failure_category ?? null,
    overrides.suggestion ?? null,
    overrides.error_message ?? null,
    overrides.notified_via_channel ? 1 : 0,
    overrides.status ?? 'running',
    overrides.structured ? 1 : 0,
    now,
    now,
    isTerminalTaskStatus(overrides.status ?? 'running') ? now : null,
  )
}


function insertExecutionRow(executionId: string, createdAt: string): void {
  dbRun(
    `INSERT INTO executions (
      id, task_id, profile, permission, cwd, prompt, status,
      native_session_id, client_family, pid, pgid, started_at, ended_at,
      exit_code, kill_signal, kill_reason, output, raw_result, error, timeout_ms,
      created_at, updated_at
    ) VALUES (
      ?, NULL, 'codex', 'readonly', '/tmp', 'prompt', 'done',
      NULL, 'codex', NULL, NULL, ?, ?, 0, NULL, NULL, '', NULL, NULL, NULL,
      ?, ?
    )`,
    executionId,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
  )
}

function insertEventRow(
  executionId: string,
  seq: number,
  type: string,
  createdAt: string,
  data: Record<string, unknown>,
): void {
  dbRun(
    `INSERT INTO events (
      execution_id, task_id, seq, type, timestamp, data,
      status, exit_code, is_error, created_at
    ) VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    executionId,
    seq,
    type,
    createdAt,
    JSON.stringify(data),
    createdAt,
  )
}

function taskOutputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function isTerminalTaskStatus(status: string): boolean {
  return status !== 'queued' && status !== 'running'
}

