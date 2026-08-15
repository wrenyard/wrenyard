import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Database from 'better-sqlite3'

import {
  TaskGraphService,
  TaskGraphStore,
  type JsonObject,
  type TaskGraphNode,
  type TaskGraphTaskBridge,
  type TaskGraphTaskHandle,
  type TaskGraphTaskRequest,
  type TaskGraphTaskTerminal,
} from '../../lib/core/taskgraph/index.mts'
import { ExecutionEventStore } from '../../lib/db/stores/execution-event-store.mts'
import { mapStreamEventToBClass } from '../../lib/daemon/execution/agent-supervisor.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

const T0 = '2026-08-01T00:00:00.000Z'

let db: ForemanDatabase

beforeEach(() => {
  db = initTestDb()
})

afterEach(() => {
  closeTestDb()
})

// ─── Fake task bridge / graph builders ──────────────────────────────────────

class FakeTaskBridge implements TaskGraphTaskBridge {
  readonly requests: TaskGraphTaskRequest[] = []
  readonly cancelled: string[] = []
  readonly taskRunIds: string[] = []
  private sequence: number
  private readonly handles = new Map<string, {
    handle: TaskGraphTaskHandle
    resolve: (terminal: TaskGraphTaskTerminal) => void
  }>()

  constructor(startSequence = 1) {
    this.sequence = startSequence - 1
  }

  async start(request: TaskGraphTaskRequest): Promise<TaskGraphTaskHandle> {
    this.requests.push(request)
    this.sequence += 1
    const taskRunId = `task_${this.sequence}`
    this.taskRunIds.push(taskRunId)
    let resolve!: (terminal: TaskGraphTaskTerminal) => void
    const terminal = new Promise<TaskGraphTaskTerminal>((done) => {
      resolve = done
    })
    const handle = { taskRunId, terminal }
    this.handles.set(taskRunId, { handle, resolve })
    return handle
  }

  reattach(taskRunId: string): TaskGraphTaskHandle {
    const entry = this.handles.get(taskRunId)
    if (!entry) throw new Error(`unknown fake task '${taskRunId}'`)
    return entry.handle
  }

  async cancel(taskRunId: string): Promise<void> {
    this.cancelled.push(taskRunId)
    const entry = this.handles.get(taskRunId)
    if (entry) entry.resolve({ status: 'cancelled' })
  }

  terminal(taskRunId: string, terminal: TaskGraphTaskTerminal): void {
    const entry = this.handles.get(taskRunId)
    if (!entry) throw new Error(`unknown fake task '${taskRunId}'`)
    entry.resolve(terminal)
  }
}

function objectSchema(
  properties: Record<string, JsonObject>,
  required = Object.keys(properties),
): TaskGraphNode['input_schema'] {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

function startNode(): TaskGraphNode {
  return {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: objectSchema({}, []),
    output_schema: objectSchema({ seed: { type: 'string' } }),
  }
}

function taskNode(id = 'work', definitionName = 'edit'): TaskGraphNode {
  return {
    id,
    name: id,
    action: {
      type: 'task',
      params: { name: definitionName, project: 'foreman', input: { seed: '$inputs.seed' } },
    },
    deps: ['start'],
    input: [{ name: 'seed', source: 'start.seed' }],
    input_schema: objectSchema({ seed: { type: 'string' } }),
    output_schema: objectSchema({ status: { type: 'string' } }),
  }
}

function endNode(): TaskGraphNode {
  return {
    id: 'end',
    name: 'end',
    action: { type: 'end', params: {} },
    deps: ['work'],
    input: [{ name: 'status', source: 'work.status' }],
    input_schema: objectSchema({ status: { type: 'string' } }),
    output_schema: objectSchema({ status: { type: 'string' } }),
  }
}

function linearGraph(): Record<string, TaskGraphNode> {
  return { start: startNode(), work: taskNode(), end: endNode() }
}

function makeService(bridge: FakeTaskBridge): TaskGraphService {
  return new TaskGraphService({
    db,
    workspaceRoot: process.cwd(),
    taskBridge: bridge,
  })
}

async function settle(service: TaskGraphService, id: string): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await service.whenIdle(id)
  await Promise.resolve()
  await service.whenIdle(id)
}

async function createGraph(startSequence = 1): Promise<{ service: TaskGraphService; id: string; bridge: FakeTaskBridge }> {
  const bridge = new FakeTaskBridge(startSequence)
  const service = makeService(bridge)
  const created = await service.create({ graph: { nodes: linearGraph() } })
  return { service, id: created.taskgraph.id, bridge }
}

async function driveWorkToDone(service: TaskGraphService, id: string, bridge: FakeTaskBridge): Promise<void> {
  service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
  await service.whenIdle(id)
  const taskRunId = bridge.taskRunIds[0] ?? 'task_1'
  bridge.terminal(taskRunId, { status: 'done', output: { status: 'ok' } })
  await settle(service, id)
}

// ─── Real-store row helpers ──────────────────────────────────────────────────

function setupTaskAndExecution(
  taskRunId: string,
  executionId: string,
  opts?: { summary?: string; profile?: string },
): void {
  db.prepare(
    `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(executionId, 'default', 'edit', '/tmp', 'p', 'done', T0, T0)
  db.prepare(
    `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskRunId, `template-${taskRunId}`, 'foreman', 'done', executionId, T0, T0)
  if (opts?.summary !== undefined) {
    db.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run(opts.summary, taskRunId)
  }
  if (opts?.profile !== undefined) {
    db.prepare('UPDATE executions SET resolved_profile = ? WHERE id = ?').run(opts.profile, executionId)
  }
}

interface TelemetryRow {
  tool_call_count: number
  usage_event_count: number
  output_tokens: number
  agent_turn_ms: number
  tps_complete: number
}

function readTelemetry(taskRunId: string): TelemetryRow | undefined {
  return db.prepare<[string], TelemetryRow>(
    `SELECT tool_call_count, usage_event_count, output_tokens, agent_turn_ms, tps_complete
     FROM task_run_telemetry WHERE task_run_id = ?`,
  ).get(taskRunId)
}

function countEvents(executionId: string): number {
  const row = db.prepare<[string], { c: number }>(
    'SELECT COUNT(*) AS c FROM events WHERE execution_id = ?',
  ).get(executionId)
  return row?.c ?? 0
}

function writeEvent(
  executionId: string,
  taskRunId: string,
  seq: number,
  type: string,
  data: unknown,
): void {
  new ExecutionEventStore(db).insertExecutionEvent({
    executionId,
    taskId: taskRunId,
    seq,
    type,
    data,
    timestamp: T0,
  })
}

/**
 * A Forge Agent Stream v1 turn_usage envelope after normalizeForgeStreamEvent:
 * the data fields are spread to the top alongside the envelope metadata. This is
 * exactly the input the production mapStreamEventToBClass mapper receives.
 */
function normalizedForgeUsage(data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_telemetry_map',
    seq: 2,
    type: 'turn_usage',
    timestamp: T0,
    ...data,
  }
}

interface SlipNodeWithTelemetry {
  node_id: string
  state: string
  tool_call_count?: number
  tps?: number
  profile?: string
  summary?: string
  [key: string]: unknown
}

// ─── Execution event store: telemetry semantics ──────────────────────────────

describe('task_run_telemetry via ExecutionEventStore', () => {
  it('initializes a durable zero/true row for every new task run', () => {
    setupTaskAndExecution('tr_init', 'exec_init')
    const store = new ExecutionEventStore(db)
    store.insertTaskLifecycle({
      taskRunId: 'tr_init',
      kind: 'task.started',
      taskName: 'example',
      project: 'foreman',
      status: 'running',
      startedAt: T0,
      timestamp: T0,
    })
    const row = readTelemetry('tr_init')
    assert.ok(row, 'expected a telemetry row for the new task run')
    assert.equal(row.tool_call_count, 0)
    assert.equal(row.usage_event_count, 0)
    assert.equal(row.output_tokens, 0)
    assert.equal(row.agent_turn_ms, 0)
    assert.equal(row.tps_complete, 1)
  })

  it('counts each tool_call event once and never tool_result', () => {
    setupTaskAndExecution('tr_tools', 'exec_tools')
    writeEvent('exec_tools', 'tr_tools', 1, 'tool_call', { name: 'bash' })
    writeEvent('exec_tools', 'tr_tools', 2, 'tool_result', { content: 'ok' })
    writeEvent('exec_tools', 'tr_tools', 3, 'tool_call', { name: 'write' })
    const row = readTelemetry('tr_tools')
    assert.ok(row)
    assert.equal(row.tool_call_count, 2)
  })

  it('never double counts duplicate delivery of the same event', () => {
    setupTaskAndExecution('tr_dup', 'exec_dup')
    writeEvent('exec_dup', 'tr_dup', 1, 'tool_call', { name: 'bash' })
    writeEvent('exec_dup', 'tr_dup', 1, 'tool_call', { name: 'bash' })
    const row = readTelemetry('tr_dup')
    assert.ok(row)
    assert.equal(row.tool_call_count, 1)
    assert.equal(countEvents('exec_dup'), 1)
  })

  it('counts retried/resumed attempts only for genuinely new events', () => {
    setupTaskAndExecution('tr_retry', 'exec_retry')
    writeEvent('exec_retry', 'tr_retry', 1, 'tool_call', { name: 'bash' })
    writeEvent('exec_retry', 'tr_retry', 2, 'tool_call', { name: 'write' })
    // Replay of the second event (attach/restart) must not double count.
    writeEvent('exec_retry', 'tr_retry', 2, 'tool_call', { name: 'write' })
    const row = readTelemetry('tr_retry')
    assert.ok(row)
    assert.equal(row.tool_call_count, 2)
    assert.equal(countEvents('exec_retry'), 2)
  })

  it('sums valid agent_turn usage into output_tokens, agent_turn_ms and usage count', () => {
    setupTaskAndExecution('tr_usage', 'exec_usage')
    writeEvent('exec_usage', 'tr_usage', 1, 'turn_usage', {
      input_tokens: 100,
      output_tokens: 1000,
      duration_ms: 2000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    const row = readTelemetry('tr_usage')
    assert.ok(row)
    assert.equal(row.usage_event_count, 1)
    assert.equal(row.output_tokens, 1000)
    assert.equal(row.agent_turn_ms, 2000)
    assert.equal(row.tps_complete, 1)
  })

  it('sums multiple and parallel usage events into one run', () => {
    setupTaskAndExecution('tr_parallel', 'exec_parallel')
    writeEvent('exec_parallel', 'tr_parallel', 1, 'turn_usage', {
      output_tokens: 100,
      duration_ms: 100,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    writeEvent('exec_parallel', 'tr_parallel', 2, 'turn_usage', {
      output_tokens: 300,
      duration_ms: 300,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    const row = readTelemetry('tr_parallel')
    assert.ok(row)
    assert.equal(row.usage_event_count, 2)
    assert.equal(row.output_tokens, 400)
    assert.equal(row.agent_turn_ms, 400)
    assert.equal(row.tps_complete, 1)
  })

  it('ingests a production-mapped Forge agent_turn event into durable telemetry and omits TPS for missing or other contracts', () => {
    // The normalized shape is exactly what the supervisor's stream consumer feeds to
    // the production mapStreamEventToBClass mapper before persisting execution events.
    const mappedAgentTurn = mapStreamEventToBClass(normalizedForgeUsage({
      output_tokens: 2000,
      duration_ms: 4000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    }))
    const agentTurn = mappedAgentTurn.find((event) => event.type === 'turn_usage')
    assert.ok(agentTurn, 'production mapping must produce a turn_usage event')
    assert.equal(agentTurn.data.token_scope, 'agent_turn', 'the exact token_scope must survive the mapping')
    assert.equal(agentTurn.data.duration_scope, 'agent_turn', 'the exact duration_scope must survive the mapping')
    assert.equal(agentTurn.data.tps_contract, 'agent_turn_v1', 'the exact tps_contract must survive the mapping')

    setupTaskAndExecution('tr_mapped_ok', 'exec_mapped_ok')
    writeEvent('exec_mapped_ok', 'tr_mapped_ok', 1, agentTurn.type, agentTurn.data)
    const okRow = readTelemetry('tr_mapped_ok')
    assert.ok(okRow, 'expected telemetry row for the production-mapped agent_turn event')
    assert.equal(okRow.usage_event_count, 1)
    assert.equal(okRow.output_tokens, 2000)
    assert.equal(okRow.agent_turn_ms, 4000)
    assert.equal(okRow.tps_complete, 1, 'a genuine agent_turn_v1 event must keep TPS enabled')

    // Missing provenance is omitted by the mapper and must disable TPS.
    const mappedMissing = mapStreamEventToBClass(normalizedForgeUsage({
      output_tokens: 100,
      duration_ms: 200,
    }))
    const missing = mappedMissing.find((event) => event.type === 'turn_usage')
    assert.ok(missing, 'production mapping must produce a turn_usage event')
    assert.equal('token_scope' in missing.data, false, 'a missing token_scope must be omitted, not upgraded')
    assert.equal('duration_scope' in missing.data, false, 'a missing duration_scope must be omitted, not upgraded')
    assert.equal('tps_contract' in missing.data, false, 'a missing tps_contract must be omitted, not upgraded')

    setupTaskAndExecution('tr_mapped_missing', 'exec_mapped_missing')
    writeEvent('exec_mapped_missing', 'tr_mapped_missing', 1, missing.type, missing.data)
    const missingRow = readTelemetry('tr_mapped_missing')
    assert.ok(missingRow, 'expected telemetry row for the mapped scope-less event')
    assert.equal(missingRow.usage_event_count, 0)
    assert.equal(missingRow.tps_complete, 0, 'a mapped scope-less event must disable TPS')

    // Wrong provenance is preserved by the mapper and must disable TPS.
    const mappedModelOutput = mapStreamEventToBClass(normalizedForgeUsage({
      output_tokens: 100,
      duration_ms: 200,
      token_scope: 'model_output',
      duration_scope: 'model_output',
      tps_contract: 'agent_turn_v0',
    }))
    const modelOutput = mappedModelOutput.find((event) => event.type === 'turn_usage')
    assert.ok(modelOutput, 'production mapping must produce a turn_usage event')
    assert.equal(modelOutput.data.token_scope, 'model_output', 'a wrong token_scope must be preserved, never upgraded')
    assert.equal(modelOutput.data.duration_scope, 'model_output', 'a wrong duration_scope must be preserved, never upgraded')
    assert.equal(modelOutput.data.tps_contract, 'agent_turn_v0', 'a wrong tps_contract must be preserved, never upgraded')

    setupTaskAndExecution('tr_mapped_model', 'exec_mapped_model')
    writeEvent('exec_mapped_model', 'tr_mapped_model', 1, modelOutput.type, modelOutput.data)
    const modelRow = readTelemetry('tr_mapped_model')
    assert.ok(modelRow, 'expected telemetry row for the mapped model_output event')
    assert.equal(modelRow.usage_event_count, 0)
    assert.equal(modelRow.tps_complete, 0, 'a mapped non-agent_turn contract must disable TPS')
  })

  it('permanently disables TPS for missing, zero, negative, invalid, or wrong-contract usage', () => {
    const cases: Array<{ name: string; data: Record<string, unknown> }> = [
      { name: 'missing output_tokens', data: { duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'zero duration_ms', data: { output_tokens: 10, duration_ms: 0, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'negative output_tokens', data: { output_tokens: -1, duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'negative duration_ms', data: { output_tokens: 10, duration_ms: -5, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'non-integer output_tokens', data: { output_tokens: 2.5, duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'non-numeric duration_ms', data: { output_tokens: 10, duration_ms: 'fast', token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'missing duration_scope', data: { output_tokens: 10, duration_ms: 100, token_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'model_output duration scope', data: { output_tokens: 10, duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'model_output', tps_contract: 'agent_turn_v1' } },
      { name: 'missing token_scope', data: { output_tokens: 10, duration_ms: 100, duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'model_output token scope', data: { output_tokens: 10, duration_ms: 100, token_scope: 'model_output', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v1' } },
      { name: 'missing tps_contract', data: { output_tokens: 10, duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'agent_turn' } },
      { name: 'wrong tps_contract', data: { output_tokens: 10, duration_ms: 100, token_scope: 'agent_turn', duration_scope: 'agent_turn', tps_contract: 'agent_turn_v0' } },
    ]
    for (const [index, testCase] of cases.entries()) {
      const taskRunId = `tr_bad_${index}`
      const executionId = `exec_bad_${index}`
      setupTaskAndExecution(taskRunId, executionId)
      writeEvent(executionId, taskRunId, 1, 'turn_usage', testCase.data)
      const row = readTelemetry(taskRunId)
      assert.ok(row, `expected telemetry row for ${testCase.name}`)
      assert.equal(row.tps_complete, 0, `${testCase.name} must permanently disable TPS`)
      assert.equal(row.usage_event_count, 0, `${testCase.name} must not count as usage`)
    }
  })

  it('a persisted invalid usage disables TPS even after later valid usage', () => {
    setupTaskAndExecution('tr_sticky', 'exec_sticky')
    writeEvent('exec_sticky', 'tr_sticky', 1, 'turn_usage', { output_tokens: 10, duration_ms: 100 })
    writeEvent('exec_sticky', 'tr_sticky', 2, 'turn_usage', {
      output_tokens: 500,
      duration_ms: 1000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    const row = readTelemetry('tr_sticky')
    assert.ok(row)
    assert.equal(row.tps_complete, 0)
    assert.equal(row.usage_event_count, 1)
    assert.equal(row.output_tokens, 500)
  })

  it('rolls back the event insert and telemetry together on failure', () => {
    setupTaskAndExecution('tr_rollback', 'exec_rollback')
    db.exec(
      `CREATE TRIGGER test_telemetry_abort
       BEFORE INSERT ON task_run_telemetry
       BEGIN
         SELECT RAISE(ABORT, 'telemetry abort');
       END`,
    )
    try {
      assert.throws(
        () => writeEvent('exec_rollback', 'tr_rollback', 1, 'tool_call', { name: 'bash' }),
        /telemetry abort/u,
      )
      // Neither the event nor the telemetry row survived the failed transaction.
      assert.equal(countEvents('exec_rollback'), 0)
      assert.equal(readTelemetry('tr_rollback'), undefined)
    } finally {
      db.exec('DROP TRIGGER test_telemetry_abort')
    }
  })

  it('keeps telemetry durable across a database restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-telemetry-'))
    const path = join(dir, 'telemetry.db')
    try {
      const db1 = new Database(path)
      bootstrapSchema(db1)
      db1.pragma('foreign_keys = ON')
      db1.prepare(
        `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('exec_restart', 'default', 'edit', '/tmp', 'p', 'done', T0, T0)
      db1.prepare(
        `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('tr_restart', 'template-tr_restart', 'foreman', 'done', 'exec_restart', T0, T0)
      new ExecutionEventStore(db1).insertExecutionEvent({
        executionId: 'exec_restart',
        taskId: 'tr_restart',
        seq: 1,
        type: 'tool_call',
        data: { name: 'bash' },
        timestamp: T0,
      })
      db1.close()

      const db2 = new Database(path)
      bootstrapSchema(db2)
      db2.pragma('foreign_keys = ON')
      const row = db2.prepare<[string], TelemetryRow>(
        `SELECT tool_call_count, usage_event_count, output_tokens, agent_turn_ms, tps_complete
         FROM task_run_telemetry WHERE task_run_id = ?`,
      ).get('tr_restart')
      assert.ok(row, 'expected telemetry to survive the restart')
      assert.equal(row.tool_call_count, 1)
      assert.equal(row.tps_complete, 1)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── taskgraph.slip dynamic telemetry fields ─────────────────────────────────

describe('taskgraph.slip dynamic telemetry fields', () => {
  it('omits telemetry for legacy task runs without a telemetry row', async () => {
    const { service, id, bridge } = await createGraph()
    await driveWorkToDone(service, id, bridge)

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    const node = result.nodes[0] as SlipNodeWithTelemetry
    assert.equal(node.node_id, 'work')
    assert.equal(node.state, 'done')
    assert.equal('tool_call_count' in node, false)
    assert.equal('tps' in node, false)
    assert.equal('summary' in node, false)
    assert.equal('profile' in node, false)
  })

  it('surfaces tool_call_count, bounded tps, profile and done-only summary', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_1', {
      summary: 'All criteria passed.',
      profile: 'forge/fast',
    })
    writeEvent('exec_slip_1', 'task_1', 1, 'tool_call', { name: 'bash' })
    writeEvent('exec_slip_1', 'task_1', 2, 'tool_call', { name: 'write' })
    writeEvent('exec_slip_1', 'task_1', 3, 'turn_usage', {
      output_tokens: 2000,
      duration_ms: 4000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    await driveWorkToDone(service, id, bridge)

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    const node = result.nodes[0] as SlipNodeWithTelemetry
    assert.equal(node.tool_call_count, 2)
    assert.equal(node.tps, 500) // 1000 * 2000 / 4000
    assert.equal(node.profile, 'forge/fast')
    assert.equal(node.summary, 'All criteria passed.')
  })

  it('surfaces bounded agent-turn TPS from a production-mapped Forge usage event', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_mapped_ok', { profile: 'forge/fast' })
    const mapped = mapStreamEventToBClass(normalizedForgeUsage({
      output_tokens: 2000,
      duration_ms: 4000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    }))
    const usage = mapped.find((event) => event.type === 'turn_usage')
    assert.ok(usage, 'production mapping must produce a turn_usage event')
    writeEvent('exec_slip_mapped_ok', 'task_1', 1, usage.type, usage.data)
    await driveWorkToDone(service, id, bridge)

    const node = service.slip({ taskgraph_id: id, node_ids: ['work'] }).nodes[0] as SlipNodeWithTelemetry
    // End-to-end agent-turn effective output speed (1000 * output_tokens / duration_ms),
    // never provider generation speed.
    assert.equal(node.tps, 500)
  })

  it('omits TPS when the persisted usage is a production-mapped missing-provenance event', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_mapped_bad')
    const mapped = mapStreamEventToBClass(normalizedForgeUsage({
      output_tokens: 2000,
      duration_ms: 4000,
    }))
    const usage = mapped.find((event) => event.type === 'turn_usage')
    assert.ok(usage, 'production mapping must produce a turn_usage event')
    assert.equal('token_scope' in usage.data, false, 'a missing token_scope must be omitted, not upgraded')
    assert.equal('tps_contract' in usage.data, false, 'a missing tps_contract must be omitted, not upgraded')
    writeEvent('exec_slip_mapped_bad', 'task_1', 1, usage.type, usage.data)
    await driveWorkToDone(service, id, bridge)

    const node = service.slip({ taskgraph_id: id, node_ids: ['work'] }).nodes[0] as SlipNodeWithTelemetry
    assert.equal('tps' in node, false, 'TPS must be omitted when the persisted usage has no agent_turn contract')
  })

  it('omits tps when persisted usage permanently disabled the run', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_bad')
    writeEvent('exec_slip_bad', 'task_1', 1, 'turn_usage', { output_tokens: 10, duration_ms: 100 })
    writeEvent('exec_slip_bad', 'task_1', 2, 'turn_usage', {
      output_tokens: 2000,
      duration_ms: 4000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    await driveWorkToDone(service, id, bridge)

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    const node = result.nodes[0] as SlipNodeWithTelemetry
    assert.equal(node.tool_call_count, 0)
    assert.equal('tps' in node, false)
  })

  it('omits tps when the computed rate is outside the bounded range', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_oob')
    // 1000 * 2_000_000 / 1000 = 2_000_000 > 1_000_000 bound
    writeEvent('exec_slip_oob', 'task_1', 1, 'turn_usage', {
      output_tokens: 2_000_000,
      duration_ms: 1000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    await driveWorkToDone(service, id, bridge)

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    const node = result.nodes[0] as SlipNodeWithTelemetry
    assert.equal('tps' in node, false)
    assert.equal(node.tool_call_count, 0)
  })

  it('keeps large but safe counters finite and within the tps bound', async () => {
    const { service, id, bridge } = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_large')
    // 1000 * 1_000_000_000 / 1_000_000_000 = 1000
    writeEvent('exec_slip_large', 'task_1', 1, 'turn_usage', {
      output_tokens: 1_000_000_000,
      duration_ms: 1_000_000_000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    await driveWorkToDone(service, id, bridge)

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    const node = result.nodes[0] as SlipNodeWithTelemetry
    assert.equal(node.tps, 1000)
  })

  it('surfaces the resolved execution profile only when bounded to 128 units', async () => {
    const overLong = 'forge/'.concat('r'.repeat(140))

    const shortRun = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_short', { profile: 'forge/fast' })
    await driveWorkToDone(shortRun.service, shortRun.id, shortRun.bridge)
    const shortNode = shortRun.service.slip({ taskgraph_id: shortRun.id, node_ids: ['work'] })
      .nodes[0] as SlipNodeWithTelemetry
    assert.equal(shortNode.profile, 'forge/fast')

    const longRun = await createGraph(2)
    setupTaskAndExecution('task_2', 'exec_slip_long', { profile: overLong })
    await driveWorkToDone(longRun.service, longRun.id, longRun.bridge)
    const longNode = longRun.service.slip({ taskgraph_id: longRun.id, node_ids: ['work'] })
      .nodes[0] as SlipNodeWithTelemetry
    assert.equal('profile' in longNode, false)
  })

  it('returns a folded, 280-unit-bounded summary only for done nodes', async () => {
    const longSummary = `line one\n\n   ${'x'.repeat(300)}`

    const doneRun = await createGraph()
    setupTaskAndExecution('task_1', 'exec_slip_sum', { summary: longSummary })
    await driveWorkToDone(doneRun.service, doneRun.id, doneRun.bridge)
    const doneNode = doneRun.service.slip({ taskgraph_id: doneRun.id, node_ids: ['work'] })
      .nodes[0] as SlipNodeWithTelemetry
    assert.equal(typeof doneNode.summary, 'string')
    assert.equal(doneNode.summary!.length, 280)
    assert.equal(doneNode.summary!.includes('\n'), false)

    // Flip the same node back to a non-done state: the summary must vanish
    // even though the same task run summary is still present in the DB.
    const store = new TaskGraphStore(db)
    store.putNodeState(doneRun.id, 'work', { state: 'running', taskRunId: 'task_1' }, T0)
    const runningNode = doneRun.service.slip({ taskgraph_id: doneRun.id, node_ids: ['work'] })
      .nodes[0] as SlipNodeWithTelemetry
    assert.equal(runningNode.state, 'running')
    assert.equal('summary' in runningNode, false)
  })
})
