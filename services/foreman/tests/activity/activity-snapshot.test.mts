import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { getDb } from '../../lib/db/connection.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { INVALID_PARAMS } from '../../lib/protocol/errors.mts'
import type { ActivitySnapshotV1 } from '../../lib/protocol/methods/activity.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

let router: RpcRouter

beforeEach(() => {
  initTestDb()
  router = new RpcRouter()
  registerCoreHandlers(router, {
    startedAt: Date.now(),
    workspaceRoot: process.cwd(),
  })
})

afterEach(() => {
  closeTestDb()
})

async function call(method: string, params: unknown): Promise<unknown> {
  const response = await router.handleMessage({
    jsonrpc: '2.0',
    method,
    params,
    id: `test-${method}-${Math.random()}`,
  }) as { result?: unknown; error?: unknown }
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  return response.result
}

describe('activity.snapshot', () => {
  it('returns schema v1 with a unique task set, graph/node counts, active, telemetry, and taskgraph/node association', async () => {
    seedActiveState(getDb())

    const result = await call('activity.snapshot', {}) as ActivitySnapshotV1
    assert.equal(result.schema_version, 'foreman.activity.snapshot.v1')
    assert.equal(typeof result.sampled_at, 'string')
    assert.ok(result.sampled_at.length > 0)

    // Unique task set covering direct and taskgraph-owned, queued and running.
    const taskIds = result.tasks.map((task) => task.task_run_id)
    assert.equal(new Set(taskIds).size, taskIds.length)
    assert.deepEqual(new Set(taskIds), new Set(['task_dq', 'task_dr', 'task_tq', 'task_tr']))

    const directQueued = result.tasks.find((task) => task.task_run_id === 'task_dq')!
    assert.equal(directQueued.status, 'queued')
    assert.equal(directQueued.task_id, 'commit')
    assert.equal(directQueued.project, 'p1')
    assert.equal(directQueued.taskgraph_id, undefined)
    assert.equal(directQueued.node_id, undefined)

    const directRunning = result.tasks.find((task) => task.task_run_id === 'task_dr')!
    assert.equal(directRunning.status, 'running')
    assert.equal(directRunning.task_id, 'review')
    assert.equal(directRunning.project, 'p2')
    assert.equal(directRunning.requested_agent_runtime, 'claude')
    assert.equal(directRunning.resolved_profile, 'fast')
    assert.equal(directRunning.taskgraph_id, undefined)

    const tgQueued = result.tasks.find((task) => task.task_run_id === 'task_tq')!
    assert.equal(tgQueued.status, 'queued')
    assert.equal(tgQueued.taskgraph_id, 'tg_running')
    assert.equal(tgQueued.node_id, 'main2')

    const tgRunning = result.tasks.find((task) => task.task_run_id === 'task_tr')!
    assert.equal(tgRunning.status, 'running')
    assert.equal(tgRunning.taskgraph_id, 'tg_running')
    assert.equal(tgRunning.node_id, 'main')

    // All non-terminal graphs are returned.
    assert.deepEqual(
      new Set(result.taskgraphs.map((graph) => graph.taskgraph_id)),
      new Set(['tg_created', 'tg_running', 'tg_paused']),
    )

    const created = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_created')!
    assert.equal(created.state, 'created')
    assert.equal(created.title, 'Blueprint A')
    assert.equal(created.project, 'p1')
    assert.equal(created.structure_revision, 1)
    assert.deepEqual(created.node_counts, {
      planned: 2, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0,
    })
    assert.deepEqual(created.active, { running: [], waiting: [] })

    // A planned node carries the authoritative definition name from its slip.
    const plannedNode = created.nodes.find((node) => node.node_id === 'a')!
    assert.equal(plannedNode.task_id, 'commit')
    assert.equal(plannedNode.task_run_id, undefined)

    const running = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_running')!
    assert.equal(running.state, 'running')
    assert.equal(running.on_node_failure, 'pause')
    assert.equal(running.cancel_requested, false)
    assert.equal(running.structure_revision, 2)
    assert.equal(running.latest_seq, 3)
    assert.equal(running.terminal_reason, undefined)
    assert.deepEqual(running.node_counts, {
      planned: 0, running: 2, waiting: 1, done: 1, failed: 0, interrupted: 0, cancelled: 0,
    })
    assert.deepEqual(running.active, { running: ['main', 'main2'], waiting: ['wait'] })

    const mainNode = running.nodes.find((node) => node.node_id === 'main')!
    assert.equal(mainNode.state, 'running')
    assert.equal(mainNode.task_run_id, 'task_tr')
    assert.equal(mainNode.task_status, 'running')
    assert.equal(mainNode.task_id, 'build')
    assert.deepEqual(mainNode.task_category, { id: 'build', display_label: 'Build' })
    assert.equal(mainNode.display_label, 'Build')
    assert.equal(mainNode.description, 'compile & test')
    assert.equal(mainNode.requested_agent_runtime, 'claude')
    assert.equal(mainNode.resolved_profile, 'fast')
    assert.equal(mainNode.tool_call_count, 7)
    assert.equal(mainNode.tps, 500)
    assert.equal(mainNode.summary, undefined)

    const queuedNode = running.nodes.find((node) => node.node_id === 'main2')!
    assert.equal(queuedNode.state, 'running')
    assert.equal(queuedNode.task_run_id, 'task_tq')
    assert.equal(queuedNode.task_status, 'queued')
    assert.equal(queuedNode.tool_call_count, undefined)
    assert.equal(queuedNode.tps, undefined)
    // The legacy node slip lacks task_id; the runtime id stays the only id.
    assert.equal(queuedNode.task_id, undefined)
    assert.equal(queuedNode.task_run_id, 'task_tq')

    const paused = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_paused')!
    assert.equal(paused.state, 'paused')
    assert.equal(paused.on_node_failure, 'pause')
    assert.equal(paused.node_counts.failed, 1)
    assert.equal(paused.terminal_reason, undefined)
  })

  it('exposes runtime_ms for running and terminal nodes and omits it when timing data is unavailable', async () => {
    const db = getDb()
    const createdAt = new Date(Date.now() - 120_000).toISOString()
    const endedAt = new Date(Date.now() - 30_000).toISOString()

    // Non-terminal task: runtime is sampled_at minus dispatch start.
    insertTask(db, { id: 'task_rt_run', template: 'build', project: 'p1', worktree: null, input: '{}', status: 'running' })
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(createdAt, 'task_rt_run')

    // Terminal task: runtime is frozen at ended_at minus dispatch start.
    insertTask(db, { id: 'task_rt_done', template: 'commit', project: 'p1', worktree: null, input: '{}', status: 'done' })
    db.prepare('UPDATE tasks SET created_at = ?, ended_at = ? WHERE id = ?').run(createdAt, endedAt, 'task_rt_done')

    // Terminal task without ended_at: no frozen value, field omitted.
    insertTask(db, { id: 'task_rt_noend', template: 'commit', project: 'p1', worktree: null, input: '{}', status: 'done' })
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(createdAt, 'task_rt_noend')

    insertGraph(db, { id: 'tg_runtime', state: 'running', structureRevision: 1 })
    insertNode(db, { taskgraphId: 'tg_runtime', nodeId: 'live', state: 'running', taskRunId: 'task_rt_run' })
    insertNode(db, { taskgraphId: 'tg_runtime', nodeId: 'finished', state: 'done', taskRunId: 'task_rt_done' })
    insertNode(db, { taskgraphId: 'tg_runtime', nodeId: 'lost_end', state: 'done', taskRunId: 'task_rt_noend' })
    insertNode(db, { taskgraphId: 'tg_runtime', nodeId: 'no_task', state: 'planned' })

    const result = await call('activity.snapshot', {}) as ActivitySnapshotV1
    const graph = result.taskgraphs.find((candidate) => candidate.taskgraph_id === 'tg_runtime')!
    const node = (nodeId: string) => graph.nodes.find((candidate) => candidate.node_id === nodeId)!

    const sampled = Date.parse(result.sampled_at)
    // Running runtime tracks the read time, rounded to integer ms.
    assert.equal(node('live').runtime_ms, Math.round(sampled - Date.parse(createdAt)))
    // Terminal runtime stays frozen at completion and does not drift with the sample.
    assert.equal(node('finished').runtime_ms, Math.round(Date.parse(endedAt) - Date.parse(createdAt)))
    assert.notEqual(node('finished').runtime_ms, Math.round(sampled - Date.parse(createdAt)))
    // Omitted when ended_at is absent on a terminal task or no task is joined.
    assert.equal(node('lost_end').runtime_ms, undefined)
    assert.equal(node('no_task').runtime_ms, undefined)
  })

  it('returns a tracked terminal graph once with a safe terminal_reason and omits untracked terminal graphs', async () => {
    seedTerminalState(getDb())

    const result = await call('activity.snapshot', {
      tracked_taskgraph_ids: ['tg_done', 'tg_cancelled'],
    }) as ActivitySnapshotV1

    assert.deepEqual(
      new Set(result.taskgraphs.map((graph) => graph.taskgraph_id)),
      new Set(['tg_done', 'tg_cancelled']),
    )

    const done = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_done')!
    assert.equal(done.state, 'done')
    assert.equal(done.terminal_reason, 'success')
    assert.equal(done.title, 'Finished')
    assert.equal(done.latest_seq, 5)

    // A done node keeps its authoritative definition name from the slip.
    const doneNode = done.nodes.find((node) => node.node_id === 'work')!
    assert.equal(doneNode.state, 'done')
    assert.equal(doneNode.task_id, 'investigate')

    // The cancelled graph's failed node has a runtime id but no slip task_id.
    const cancelled = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_cancelled')!
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(cancelled.cancel_requested, true)
    assert.equal(cancelled.on_node_failure, 'cancel')
    assert.equal(cancelled.terminal_reason, 'node_failed')
    const failedNode = cancelled.nodes.find((node) => node.node_id === 'run')!
    assert.equal(failedNode.task_run_id, 'task_done_run')
    assert.equal(failedNode.task_id, undefined)

    // The untracked historical terminal graph never enters the response.
    const untracked = result.taskgraphs.find((graph) => graph.taskgraph_id === 'tg_old_done')
    assert.equal(untracked, undefined)

    // A fresh client with an empty tracked set does not replay terminal history.
    const fresh = await call('activity.snapshot', {}) as ActivitySnapshotV1
    assert.deepEqual(fresh.taskgraphs, [])
  })

  it('deduplicates tracked_taskgraph_ids', async () => {
    seedTerminalState(getDb())
    const result = await call('activity.snapshot', {
      tracked_taskgraph_ids: ['tg_done', 'tg_done', 'tg_cancelled', 'tg_cancelled'],
    }) as ActivitySnapshotV1
    assert.equal(result.taskgraphs.length, 2)
  })

  it('surfaces only whitelist fields and never leaks sensitive data', async () => {
    seedSensitiveState(getDb())

    const result = await call('activity.snapshot', {
      tracked_taskgraph_ids: ['tg_secret'],
    }) as ActivitySnapshotV1

    const serialized = JSON.stringify(result)
    for (const secret of [
      'PROMPT_SECRET',
      'INPUT_SECRET',
      'OUTPUT_SECRET',
      'ERROR_SECRET',
      'RAW_RESULT_SECRET',
      'JOURNAL_SECRET',
      'PARAMS_SECRET',
      'SCHEMA_SECRET',
      'ACTION_PARAMS_SECRET',
    ]) {
      assert.ok(!serialized.includes(secret), `snapshot leaked sensitive value ${secret}`)
    }
    for (const key of [
      '"prompt"',
      '"params"',
      '"schema"',
      '"input"',
      '"output"',
      '"error"',
      '"data"',
      '"raw_result"',
      '"source_json"',
      '"refs_json"',
    ]) {
      assert.ok(!serialized.includes(key), `snapshot leaked forbidden field ${key}`)
    }
  })

  it('fails closed on over-limit tracked ids, task runs, and total nodes', async () => {
    const db = getDb()

    // More than 128 unique tracked ids.
    const tooManyTracked = Array.from({ length: 129 }, (_, index) => `tg_missing_${index}`)
    const trackedError = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'activity.snapshot',
      params: { tracked_taskgraph_ids: tooManyTracked },
      id: 'test-limit-tracked',
    }) as { error?: { code: number } }
    assert.equal(trackedError.error?.code, INVALID_PARAMS.code)

    // More than maxTasks queued/running task runs.
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, template, project, worktree, input, status, structured, retry_policy, created_at, updated_at)
       VALUES (?, 'bulk', NULL, NULL, NULL, 'running', 0, 'side-effects', ?, ?)`,
    )
    for (let index = 0; index < 1025; index += 1) {
      insertTask.run(`bulk_task_${index}`, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')
    }
    const taskError = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'activity.snapshot',
      params: {},
      id: 'test-limit-tasks',
    }) as { error?: { code: number } }
    assert.equal(taskError.error?.code, INVALID_PARAMS.code)
  })

  it('fails closed when a graph exceeds the per-graph node bound', async () => {
    seedOverNodeGraph(getDb())
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'activity.snapshot',
      params: {},
      id: 'test-limit-nodes',
    }) as { error?: { code: number } }
    assert.equal(response.error?.code, INVALID_PARAMS.code)
  })
})

// ─── Seed helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-08-05T00:00:00.000Z'

function insertTask(db: ForemanDatabase, task: {
  id: string
  template: string
  project: string | null
  worktree: string | null
  input: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  executionId?: string
}): void {
  db.prepare(
    `INSERT INTO tasks (id, template, project, worktree, input, status, structured, retry_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'side-effects', ?, ?)`,
  ).run(task.id, task.template, task.project, task.worktree, task.input, task.status, NOW, NOW)
  if (task.executionId) {
    db.prepare('UPDATE tasks SET execution_id = ? WHERE id = ?').run(task.executionId, task.id)
  }
}

function insertExecution(db: ForemanDatabase, execution: {
  id: string
  prompt: string
  requestedAgentRuntime: string | null
  resolvedProfile: string | null
}): void {
  db.prepare(
    `INSERT INTO executions (id, profile, permission, cwd, prompt, status, requested_agent_runtime, resolved_profile, created_at, updated_at)
     VALUES (?, 'default', 'readonly', '/tmp', ?, 'running', ?, ?, ?, ?)`,
  ).run(execution.id, execution.prompt, execution.requestedAgentRuntime, execution.resolvedProfile, NOW, NOW)
}

function insertGraph(db: ForemanDatabase, graph: {
  id: string
  state: 'created' | 'running' | 'paused' | 'done' | 'cancelled'
  cancelRequested?: boolean
  onNodeFailure?: 'pause' | 'cancel'
  failureCause?: string | null
  structureRevision: number
  project?: string | null
  title?: string | null
}): void {
  db.prepare(
    `INSERT INTO taskgraph_run (id, state, cancel_requested, on_node_failure, failure_cause, structure_revision, runner_version, project, title, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'taskgraph.runner.v1', ?, ?, ?, ?, NULL)`,
  ).run(
    graph.id,
    graph.state,
    graph.cancelRequested ? 1 : 0,
    graph.onNodeFailure ?? 'pause',
    graph.failureCause ?? null,
    graph.structureRevision,
    graph.project ?? null,
    graph.title ?? null,
    NOW,
    NOW,
  )
}

function insertNode(db: ForemanDatabase, node: {
  taskgraphId: string
  nodeId: string
  state: string
  taskRunId?: string | null
  slipJson?: string | null
  errorJson?: string | null
  outputJson?: string | null
}): void {
  db.prepare(
    `INSERT INTO taskgraph_node_state (taskgraph_id, node_id, state, error_json, output_json, task_run_id, slip_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    node.taskgraphId,
    node.nodeId,
    node.state,
    node.errorJson ?? null,
    node.outputJson ?? null,
    node.taskRunId ?? null,
    node.slipJson ?? null,
    NOW,
    NOW,
  )
}

function insertJournal(db: ForemanDatabase, taskgraphId: string, seq: number, type: string): void {
  db.prepare(
    `INSERT INTO taskgraph_journal (taskgraph_id, seq, event_id, type, occurred_at, structure_revision, source_json, refs_json, data_json)
     VALUES (?, ?, ?, ?, ?, 1, '{"kind":"daemon"}', NULL, ?)`,
  ).run(taskgraphId, seq, `tge_${taskgraphId}_${seq}`, type, NOW, '{}')
}

function insertTelemetry(db: ForemanDatabase, telemetry: {
  taskRunId: string
  toolCallCount: number
  usageEventCount: number
  outputTokens: number
  agentTurnMs: number
  tpsComplete: number
}): void {
  db.prepare(
    `INSERT INTO task_run_telemetry (task_run_id, tool_call_count, usage_event_count, output_tokens, agent_turn_ms, tps_complete, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    telemetry.taskRunId,
    telemetry.toolCallCount,
    telemetry.usageEventCount,
    telemetry.outputTokens,
    telemetry.agentTurnMs,
    telemetry.tpsComplete,
    NOW,
    NOW,
  )
}

function seedActiveState(db: ForemanDatabase): void {
  // Direct tasks: one queued, one running with execution metadata.
  insertTask(db, { id: 'task_dq', template: 'commit', project: 'p1', worktree: null, input: '{}', status: 'queued' })
  insertExecution(db, { id: 'exec_direct', prompt: 'direct prompt', requestedAgentRuntime: 'claude', resolvedProfile: 'fast' })
  insertTask(db, { id: 'task_dr', template: 'review', project: 'p2', worktree: 'wt-1', input: '{}', status: 'running', executionId: 'exec_direct' })

  // Taskgraph-owned tasks: one queued, one running with telemetry.
  insertTask(db, { id: 'task_tq', template: 'checkout', project: 'p1', worktree: null, input: '{}', status: 'queued' })
  insertExecution(db, { id: 'exec_tg', prompt: 'tg prompt', requestedAgentRuntime: 'claude', resolvedProfile: 'fast' })
  insertTask(db, { id: 'task_tr', template: 'build', project: 'p1', worktree: null, input: '{}', status: 'running', executionId: 'exec_tg' })
  insertTelemetry(db, {
    taskRunId: 'task_tr',
    toolCallCount: 7,
    usageEventCount: 5,
    outputTokens: 500,
    agentTurnMs: 1000,
    tpsComplete: 1,
  })

  // created graph with two planned nodes.
  insertGraph(db, { id: 'tg_created', state: 'created', structureRevision: 1, project: 'p1', title: 'Blueprint A' })
  insertNode(db, {
    taskgraphId: 'tg_created',
    nodeId: 'a',
    state: 'planned',
    slipJson: JSON.stringify({ taskId: 'commit' }),
  })
  insertNode(db, { taskgraphId: 'tg_created', nodeId: 'b', state: 'planned' })

  // running graph: done/running/waiting nodes, one with slip + telemetry.
  insertGraph(db, { id: 'tg_running', state: 'running', structureRevision: 2, project: 'p1' })
  insertNode(db, { taskgraphId: 'tg_running', nodeId: 'start', state: 'done' })
  insertNode(db, {
    taskgraphId: 'tg_running',
    nodeId: 'main',
    state: 'running',
    taskRunId: 'task_tr',
    slipJson: JSON.stringify({
      taskId: 'build',
      category: { id: 'build', displayLabel: 'Build' },
      description: 'compile & test',
      agentRuntime: 'claude',
    }),
  })
  insertNode(db, { taskgraphId: 'tg_running', nodeId: 'wait', state: 'waiting' })
  insertNode(db, { taskgraphId: 'tg_running', nodeId: 'main2', state: 'running', taskRunId: 'task_tq' })
  insertJournal(db, 'tg_running', 1, 'taskgraph.created')
  insertJournal(db, 'tg_running', 2, 'taskgraph.started')
  insertJournal(db, 'tg_running', 3, 'taskgraph.node.started')

  // paused graph with a failed node.
  insertGraph(db, { id: 'tg_paused', state: 'paused', structureRevision: 1, onNodeFailure: 'pause' })
  insertNode(db, {
    taskgraphId: 'tg_paused',
    nodeId: 'run',
    state: 'failed',
    errorJson: JSON.stringify({ code: 'TASK_RUN_FAILED', message: 'boom' }),
  })
  insertNode(db, { taskgraphId: 'tg_paused', nodeId: 'rest', state: 'planned' })
}

function seedTerminalState(db: ForemanDatabase): void {
  insertGraph(db, { id: 'tg_done', state: 'done', structureRevision: 3, project: 'p1', title: 'Finished' })
  insertNode(db, { taskgraphId: 'tg_done', nodeId: 'start', state: 'done' })
  insertNode(db, {
    taskgraphId: 'tg_done',
    nodeId: 'work',
    state: 'done',
    slipJson: JSON.stringify({ taskId: 'investigate' }),
  })
  for (let seq = 1; seq <= 5; seq += 1) insertJournal(db, 'tg_done', seq, 'taskgraph.done')

  insertGraph(db, {
    id: 'tg_cancelled',
    state: 'cancelled',
    cancelRequested: true,
    onNodeFailure: 'cancel',
    structureRevision: 2,
    failureCause: JSON.stringify({
      kind: 'node_failed',
      node_id: 'run',
      error: { code: 'ACTION_NOT_IMPLEMENTED', message: 'failed' },
    }),
  })
  insertNode(db, {
    taskgraphId: 'tg_cancelled',
    nodeId: 'run',
    state: 'failed',
    taskRunId: 'task_done_run',
  })
  insertNode(db, { taskgraphId: 'tg_cancelled', nodeId: 'other', state: 'cancelled' })
  insertJournal(db, 'tg_cancelled', 1, 'taskgraph.node.failed')
  insertJournal(db, 'tg_cancelled', 2, 'taskgraph.cancelled')

  // Historical terminal graph that is never tracked.
  insertGraph(db, { id: 'tg_old_done', state: 'done', structureRevision: 1 })
  insertNode(db, { taskgraphId: 'tg_old_done', nodeId: 'old', state: 'done' })
}

function seedSensitiveState(db: ForemanDatabase): void {
  insertExecution(db, {
    id: 'exec_secret',
    prompt: 'PROMPT_SECRET',
    requestedAgentRuntime: null,
    resolvedProfile: null,
  })
  insertTask(db, {
    id: 'task_secret',
    template: 'secret-task',
    project: 'p1',
    worktree: null,
    input: JSON.stringify({ payload: 'INPUT_SECRET' }),
    status: 'running',
    executionId: 'exec_secret',
  })
  db.prepare(
    `UPDATE tasks SET output = ?, error = ?, summary = ? WHERE id = ?`,
  ).run(
    JSON.stringify({ leaked: 'OUTPUT_SECRET' }),
    'ERROR_SECRET',
    'a summary',
    'task_secret',
  )

  insertGraph(db, { id: 'tg_secret', state: 'running', structureRevision: 1 })
  insertNode(db, {
    taskgraphId: 'tg_secret',
    nodeId: 'secret_node',
    state: 'running',
    taskRunId: 'task_secret',
    slipJson: JSON.stringify({
      category: { id: 'build', displayLabel: 'Build' },
      description: 'desc',
      agentRuntime: 'claude',
    }),
    errorJson: JSON.stringify({ code: 'X', message: 'ERROR_SECRET' }),
    outputJson: JSON.stringify({ leaked: 'OUTPUT_SECRET' }),
  })
  insertJournal(db, 'tg_secret', 1, 'taskgraph.created')
  db.prepare(
    `UPDATE taskgraph_journal SET data_json = ? WHERE taskgraph_id = ? AND seq = 1`,
  ).run(JSON.stringify({ secret: 'JOURNAL_SECRET' }), 'tg_secret')
}

function seedOverNodeGraph(db: ForemanDatabase): void {
  insertGraph(db, { id: 'tg_huge', state: 'created', structureRevision: 1 })
  const insertNode = db.prepare(
    `INSERT INTO taskgraph_node_state (taskgraph_id, node_id, state, error_json, output_json, task_run_id, slip_json, created_at, updated_at)
     VALUES (?, ?, 'planned', NULL, NULL, NULL, NULL, ?, ?)`,
  )
  for (let index = 0; index < 2049; index += 1) {
    insertNode.run('tg_huge', `n_${index}`, NOW, NOW)
  }
}
