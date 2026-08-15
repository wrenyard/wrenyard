import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { INVALID_PARAMS, TASK_NOT_FOUND } from '../lib/protocol/errors.mts'
import { ExecutionEventStore } from '../lib/db/stores/execution-event-store.mts'
import { registerCoreHandlers } from '../lib/server/handlers/core.mts'
import { RpcRouter } from '../lib/server/rpc-router.mts'
import { closeTestDb, initTestDb } from './helpers/test-db.mts'
import type { ForemanDatabase } from '../lib/db/types.mts'
import type { JsonRecord } from '../lib/server/http/shared.mts'

let db: ForemanDatabase
let router: RpcRouter

beforeEach(() => {
  db = initTestDb()
  router = new RpcRouter()
  registerCoreHandlers(router, {
    startedAt: Date.now(),
    workspaceRoot: process.cwd(),
  })
})

afterEach(() => {
  closeTestDb()
})

function setupTaskAndExecution(taskRunId: string, executionId: string): void {
  // FK-safe: insert execution first with task_id=NULL,
  // then insert task with execution_id referencing the execution row.
  db.prepare(
    `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(executionId, 'default', 'edit', '/tmp', 'test prompt', 'done', '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')
  db.prepare(
    `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskRunId, `template-${taskRunId}`, 'test-project', 'done', executionId, '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')
}

function insertEvent(executionId: string, taskRunId: string, seq: number, type: string, timestamp: string, data: unknown, extra?: { status?: string; exitCode?: number; isError?: number }): void {
  new ExecutionEventStore(db).insertExecutionEvent({
    executionId,
    taskId: taskRunId,
    seq,
    type,
    data,
    status: (extra?.status ?? undefined) as 'done' | 'failed' | undefined,
    exitCode: extra?.exitCode ?? null,
    isError: (extra?.isError ?? undefined) as 0 | 1 | undefined,
    timestamp,
  })
}

describe('task.run.events', () => {
  it('returns ordered, paginated events from persisted execution', async () => {
    const taskRunId = 'tr_001'
    const execId = 'exec_001'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'message', '2026-07-01T00:00:10.000Z', { role: 'user', content: 'hello' })
    insertEvent(execId, taskRunId, 2, 'tool_call', '2026-07-01T00:00:20.000Z', { name: 'read_file' })
    insertEvent(execId, taskRunId, 3, 'tool_result', '2026-07-01T00:00:30.000Z', { content: 'file content' })
    insertEvent(execId, taskRunId, 4, 'turn_usage', '2026-07-01T00:00:40.000Z', { input_tokens: 10, output_tokens: 20 })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      task_run_id: string
      events: Array<{ seq: number; type: string; timestamp: string; data: unknown }>
      next_seq: number
      has_more: boolean
    }

    assert.equal(result.task_run_id, taskRunId)
    assert.equal(result.events.length, 4)
    assert.equal(result.events[0].seq, 1)
    assert.equal(result.events[1].seq, 2)
    assert.equal(result.events[2].seq, 3)
    assert.equal(result.events[3].seq, 4)
    assert.equal(result.next_seq, 4)
    assert.equal(result.has_more, false)
  })

  it('supports cursor-based pagination with has_more', async () => {
    const taskRunId = 'tr_002'
    const execId = 'exec_002'
    setupTaskAndExecution(taskRunId, execId)
    for (let i = 1; i <= 5; i++) {
      insertEvent(execId, taskRunId, i, 'message', `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`, { seq: i })
    }

    // Fetch limit=2 - should get 2 events + has_more=true
    const page1 = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 2,
    }) as {
      events: Array<{ seq: number; data: unknown }>
      next_seq: number
      has_more: boolean
    }

    assert.equal(page1.events.length, 2)
    assert.equal(page1.next_seq, 2)
    assert.equal(page1.has_more, true)

    // Fetch next page from cursor
    const page2 = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 2,
      limit: 2,
    }) as {
      events: Array<{ seq: number; data: unknown }>
      next_seq: number
      has_more: boolean
    }

    assert.equal(page2.events.length, 2)
    assert.equal(page2.next_seq, 4)
    assert.equal(page2.has_more, true)

    // Final page
    const page3 = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 4,
      limit: 2,
    }) as {
      events: Array<{ seq: number; data: unknown }>
      next_seq: number
      has_more: boolean
    }

    assert.equal(page3.events.length, 1)
    assert.equal(page3.next_seq, 5)
    assert.equal(page3.has_more, false)
  })

  it('includes optional status/exit_code/is_error on relevant events', async () => {
    const taskRunId = 'tr_003'
    const execId = 'exec_003'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'tool_call', '2026-07-01T00:00:10.000Z', { name: 'bash' }, { status: 'completed', exitCode: 0, isError: 0 })
    insertEvent(execId, taskRunId, 2, 'tool_call', '2026-07-01T00:00:20.000Z', { name: 'write' }, { status: 'error', exitCode: 1, isError: 1 })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      events: Array<{ seq: number; status?: string; exit_code?: number; is_error?: boolean }>
    }

    assert.equal(result.events[0].status, 'completed')
    assert.equal(result.events[0].exit_code, 0)
    assert.equal(result.events[0].is_error, false)
    assert.equal(result.events[1].status, 'error')
    assert.equal(result.events[1].exit_code, 1)
    assert.equal(result.events[1].is_error, true)
  })

  it('projects event data through allowlist-safe shape', async () => {
    const taskRunId = 'tr_004'
    const execId = 'exec_004'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'message', '2026-07-01T00:00:10.000Z', { role: 'user', content: 'hello world' })
    insertEvent(execId, taskRunId, 2, 'tool_call', '2026-07-01T00:00:20.000Z', { name: 'read_file', arguments: { path: '/tmp/test.txt' }, input_summary: '{"path":"/tmp/test.txt"}' })
    insertEvent(execId, taskRunId, 3, 'tool_result', '2026-07-01T00:00:30.000Z', { content: 'file content here', output_tail: 'file content here' })
    insertEvent(execId, taskRunId, 4, 'turn_usage', '2026-07-01T00:00:40.000Z', { input_tokens: 100 })
    insertEvent(execId, taskRunId, 5, 'unknown_type', '2026-07-01T00:00:50.000Z', { secret: 'data', nested: { x: 1 } })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      events: Array<{ seq: number; type: string; data: Record<string, unknown> }>
    }

    // message: role and message_summary allowed; content/blocked keys dropped
    assert.equal(result.events[0].type, 'message')
    assert.equal(result.events[0].data.role, 'user')
    assert.equal(result.events[0].data.message_summary, 'hello world')
    assert.equal('content' in result.events[0].data, false)
    assert.equal('text' in result.events[0].data, false)

    // tool_call: tool_name and input_summary allowed; arguments/input dropped
    assert.equal(result.events[1].type, 'tool_call')
    assert.equal(result.events[1].data.tool_name, 'read_file')
    assert.equal(result.events[1].data.input_summary, '{"path":"/tmp/test.txt"}')
    assert.equal('arguments' in result.events[1].data, false)
    assert.equal('input' in result.events[1].data, false)

    // tool_result: output_summary allowed; content dropped
    assert.equal(result.events[2].type, 'tool_result')
    assert.equal(result.events[2].data.output_summary, 'file content here')
    assert.equal('content' in result.events[2].data, false)
    assert.equal('text' in result.events[2].data, false)

    // turn_usage: numeric tokens allowed
    assert.equal(result.events[3].type, 'turn_usage')
    assert.equal(result.events[3].data.input_tokens, 100)
    assert.equal('output_tokens' in result.events[3].data, false)
    assert.equal('total_tokens' in result.events[3].data, false)

    // unknown type: empty object
    assert.equal(result.events[4].type, 'unknown_type')
    assert.deepEqual(result.events[4].data, {})
  })

  it('returns readable summaries while redacting credential forms', async () => {
    const taskRunId = 'tr_cred'
    const execId = 'exec_cred'
    const fakeApiKey = ['sk', '1234567890abcdef'].join('-')
    const fakeBearer = ['tok', 'abcdefghijklmnop'].join('_')
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'message', '2026-07-01T00:00:10.000Z', { role: 'assistant', content: `api_key=${fakeApiKey}` })
    insertEvent(execId, taskRunId, 2, 'tool_result', '2026-07-01T00:00:20.000Z', { content: `Authorization: Bearer ${fakeBearer}` })
    insertEvent(execId, taskRunId, 3, 'tool_call', '2026-07-01T00:00:30.000Z', { name: 'bash', input_summary: 'echo $TOKEN' })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      events: Array<{ seq: number; type: string; data: Record<string, unknown> }>
    }

    assert.equal(result.events[0].data.message_summary, 'api_key=[REDACTED]')
    assert.equal(result.events[1].data.output_summary, 'Authorization: [REDACTED]')
    assert.equal(result.events[2].data.input_summary, 'echo [REDACTED]')
    assert.equal(JSON.stringify(result).includes(fakeApiKey), false)
    assert.equal(JSON.stringify(result).includes(fakeBearer), false)
    assert.equal(JSON.stringify(result).includes('echo $TOKEN'), false)
  })

  it('does not disclose short or unusual credential values', async () => {
    const taskRunId = 'tr_short_cred'
    const execId = 'exec_short_cred'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'message', '2026-07-01T00:00:10.000Z', { content: 'password=abc' })
    insertEvent(execId, taskRunId, 2, 'tool_call', '2026-07-01T00:00:20.000Z', { name: 'bash', input: 'token=a+b/c==' })
    insertEvent(execId, taskRunId, 3, 'tool_result', '2026-07-01T00:00:30.000Z', { output: 'secret: x' })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    })
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('password=abc'), false)
    assert.equal(serialized.includes('a+b/c=='), false)
    assert.equal(serialized.includes('secret: x'), false)
  })

  it('derives lifecycle labels only from the allowlisted row type', async () => {
    const taskRunId = 'tr_lifecycle_cred'
    const execId = 'exec_lifecycle_cred'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'task.started', '2026-07-01T00:00:10.000Z', {
      event: 'credential_token_abc',
      status: 'secret_status_xyz',
    })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as { events: Array<{ data: Record<string, unknown> }> }

    assert.deepEqual(result.events[0].data, { event: 'task.started' })
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('credential_token_abc'), false)
    assert.equal(serialized.includes('secret_status_xyz'), false)
  })

  it('merges task lifecycle rows with execution events using a stable synthetic cursor', async () => {
    const taskRunId = 'tr_lifecycle'
    const execId = 'exec_lifecycle'
    setupTaskAndExecution(taskRunId, execId)
    const store = new ExecutionEventStore(db)
    store.insertTaskLifecycle({
      taskRunId,
      kind: 'task.started',
      taskName: 'example',
      project: 'test-project',
      status: 'running',
      startedAt: '2026-07-01T00:00:00.000Z',
      timestamp: '2026-07-01T00:00:00.000Z',
    })
    insertEvent(execId, taskRunId, 1, 'message', '2026-07-01T00:00:10.000Z', { content: 'private transcript' })
    store.insertTaskLifecycle({
      taskRunId,
      kind: 'task.done',
      taskName: 'example',
      project: 'test-project',
      status: 'done',
      startedAt: '2026-07-01T00:00:00.000Z',
      finishedAt: '2026-07-01T00:00:20.000Z',
      timestamp: '2026-07-01T00:00:20.000Z',
    })

    const page1 = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 2,
    }) as { events: Array<{ seq: number; type: string }>; next_seq: number; has_more: boolean }
    assert.deepEqual(page1.events.map((event) => [event.seq, event.type]), [
      [1, 'task.started'],
      [2, 'message'],
    ])
    assert.equal(page1.next_seq, 2)
    assert.equal(page1.has_more, true)

    const page2 = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: page1.next_seq,
      limit: 2,
    }) as { events: Array<{ seq: number; type: string; data: Record<string, unknown> }>; next_seq: number; has_more: boolean }
    assert.deepEqual(page2.events.map((event) => [event.seq, event.type]), [[3, 'task.done']])
    assert.equal(page2.events[0].data.event, 'task.done')
    assert.equal(page2.next_seq, 3)
    assert.equal(page2.has_more, false)
  })

  it('projects legacy unapproved data to empty for unknown event types', async () => {
    const taskRunId = 'tr_legacy'
    const execId = 'exec_legacy'
    setupTaskAndExecution(taskRunId, execId)
    insertEvent(execId, taskRunId, 1, 'legacy_action', '2026-07-01T00:00:10.000Z', { raw: 'data', output: 'big', nested: { a: 1 } })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      events: Array<{ seq: number; data: Record<string, unknown> }>
    }

    assert.deepEqual(result.events[0].data, {})
  })

  it('returns empty page when task has no execution id', async () => {
    const taskRunId = 'tr_empty_exec'
    db.prepare(
      `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskRunId, `template-${taskRunId}`, 'test-project', 'done', null, '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as {
      task_run_id: string
      events: unknown[]
      next_seq: number
      has_more: boolean
    }

    assert.equal(result.events.length, 0)
    assert.equal(result.next_seq, 0)
    assert.equal(result.has_more, false)
  })

  it('returns persisted lifecycle rows when task has no execution id', async () => {
    const taskRunId = 'tr_lifecycle_only'
    db.prepare(
      `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskRunId, 'example', 'test-project', 'running', null, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    new ExecutionEventStore(db).insertTaskLifecycle({
      taskRunId,
      kind: 'task.started',
      taskName: 'example',
      project: 'test-project',
      status: 'running',
      startedAt: '2026-07-01T00:00:00.000Z',
      timestamp: '2026-07-01T00:00:00.000Z',
    })

    const result = await call('task.run.events', {
      task_run_id: taskRunId,
      after_seq: 0,
      limit: 10,
    }) as { events: Array<{ seq: number; type: string; data: Record<string, unknown> }> }
    assert.deepEqual(result.events.map((event) => [event.seq, event.type]), [[1, 'task.started']])
    assert.equal(result.events[0].data.event, 'task.started')
  })

  it('throws TASK_NOT_FOUND for unknown task run', async () => {
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'task.run.events',
      params: { task_run_id: 'tr_does_not_exist', after_seq: 0, limit: 10 },
      id: 'test-unknown-task',
    }) as { error?: { code: number; message: string; data?: { code?: string } } }

    assert.ok(response.error)
    assert.equal(response.error.code, TASK_NOT_FOUND.code)
  })

  it('rejects malformed params (negative after_seq)', async () => {
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'task.run.events',
      params: { task_run_id: 'tr_001', after_seq: -1, limit: 10 },
      id: 'test-negative-seq',
    }) as { error?: { code: number; message: string } }

    assert.ok(response.error)
    assert.equal(response.error.code, INVALID_PARAMS.code)
  })

  it('rejects malformed params (limit 0)', async () => {
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'task.run.events',
      params: { task_run_id: 'tr_001', after_seq: 0, limit: 0 },
      id: 'test-zero-limit',
    }) as { error?: { code: number; message: string } }

    assert.ok(response.error)
    assert.equal(response.error.code, INVALID_PARAMS.code)
  })
})

async function call(method: string, params: unknown): Promise<unknown> {
  const response = await router.handleMessage({
    jsonrpc: '2.0',
    method,
    params,
    id: `test-${method}-${Math.random()}`,
  }) as { result?: unknown; error?: unknown }
  if (response.error) throw new Error(`RPC error: ${JSON.stringify(response.error)}`)
  return response.result
}
