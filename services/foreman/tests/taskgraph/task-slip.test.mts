import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Database from 'better-sqlite3'

import {
  TaskGraphService,
  TaskGraphServiceError,
  TaskGraphStore,
  buildTaskNodeSlip,
  buildTaskSlipNode,
  type JsonObject,
  type ResolvedDefinitionContract,
  type TaskGraphNode,
  type TaskGraphTaskBridge,
  type TaskGraphTaskContractResolver,
  type TaskGraphTaskHandle,
  type TaskGraphTaskRequest,
  type TaskGraphTaskTerminal,
} from '../../lib/core/taskgraph/index.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'
import { ExecutionEventStore } from '../../lib/db/stores/execution-event-store.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'

const T0 = '2026-08-01T00:00:00.000Z'

let db: ForemanDatabase
let store: TaskGraphStore

beforeEach(() => {
  db = initTestDb()
  store = new TaskGraphStore(db)
})

afterEach(() => {
  closeTestDb()
})

// ─── Fakes ──────────────────────────────────────────────────────────────────

class SlipContractResolver implements TaskGraphTaskContractResolver {
  private readonly contracts = new Map<string, ResolvedDefinitionContract>()

  set(
    kind: 'task',
    name: string,
    project: string,
    meta: Partial<ResolvedDefinitionContract>,
  ): void {
    this.contracts.set(`${kind}:${project}:${name}`, {
      definitionId: name,
      kind,
      project,
      input: undefined,
      ...meta,
    })
  }

  resolveDefinitionContract(
    kind: 'task',
    name: string,
    project: string,
  ): ResolvedDefinitionContract | null {
    return this.contracts.get(`${kind}:${project}:${name}`) ?? null
  }
}

class FakeTaskBridge implements TaskGraphTaskBridge {
  readonly requests: TaskGraphTaskRequest[] = []
  readonly cancelled: string[] = []
  private sequence = 0
  private readonly handles = new Map<string, {
    handle: TaskGraphTaskHandle
    resolve: (terminal: TaskGraphTaskTerminal) => void
  }>()

  async start(request: TaskGraphTaskRequest): Promise<TaskGraphTaskHandle> {
    this.requests.push(request)
    this.sequence += 1
    const taskRunId = `task_${this.sequence}`
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

// ─── Graph builders ─────────────────────────────────────────────────────────

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

function twoTaskGraph(): Record<string, TaskGraphNode> {
  const left = taskNode('left', 'test')
  const right = taskNode('right', 'test')
  return {
    start: startNode(),
    left,
    right,
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['left', 'right'],
      input: [
        { name: 'left', source: 'left.status' },
        { name: 'right', source: 'right.status' },
      ],
      input_schema: objectSchema({
        left: { type: 'string' },
        right: { type: 'string' },
      }),
      output_schema: objectSchema({
        left: { type: 'string' },
        right: { type: 'string' },
      }),
    },
  }
}

function makeService(bridge: FakeTaskBridge, resolver?: TaskGraphTaskContractResolver): TaskGraphService {
  return new TaskGraphService({
    db,
    workspaceRoot: process.cwd(),
    taskBridge: bridge,
    contractResolver: resolver,
  })
}

async function settle(service: TaskGraphService, id: string): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await service.whenIdle(id)
  await Promise.resolve()
  await service.whenIdle(id)
}

// ─── Telemetry row helpers (mirror tests/taskgraph/telemetry.test.mts) ──────

function setupTaskAndExecution(
  targetDb: ForemanDatabase,
  taskRunId: string,
  executionId: string,
  opts?: { summary?: string; profile?: string },
): void {
  targetDb.prepare(
    `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(executionId, 'default', 'edit', '/tmp', 'p', 'done', T0, T0)
  targetDb.prepare(
    `INSERT INTO tasks (id, template, project, status, execution_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskRunId, `template-${taskRunId}`, 'foreman', 'done', executionId, T0, T0)
  if (opts?.summary !== undefined) {
    targetDb.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run(opts.summary, taskRunId)
  }
  if (opts?.profile !== undefined) {
    targetDb.prepare('UPDATE executions SET resolved_profile = ? WHERE id = ?').run(opts.profile, executionId)
  }
}

function writeEvent(
  targetDb: ForemanDatabase,
  executionId: string,
  taskRunId: string,
  seq: number,
  type: string,
  data: unknown,
): void {
  new ExecutionEventStore(targetDb).insertExecutionEvent({
    executionId,
    taskId: taskRunId,
    seq,
    type,
    data,
    timestamp: T0,
  })
}

// ─── Slip snapshot persistence ──────────────────────────────────────────────

describe('taskgraph slip snapshots', () => {
  it('snapshots bounded static metadata for task nodes at graph create', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    const service = makeService(new FakeTaskBridge(), resolver)
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.equal(result.schema_version, 'foreman.taskgraph.slip.v1')
    assert.equal(result.taskgraph_id, id)
    assert.equal(result.graph_state, 'created')
    assert.equal(result.structure_revision, 1)
    assert.equal(typeof result.latest_seq, 'number')
    assert.deepEqual(result.nodes, [
      {
        node_id: 'work',
        state: 'planned',
        task_id: 'edit',
        task_category: 'edit',
        display_label: '编码',
        description: 'File-level edit executor',
        agent_runtime: 'forge/fast',
      },
    ])
  })

  it('persists the slip beside node state in the store projection', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    const service = makeService(new FakeTaskBridge(), resolver)
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id

    const node = store.requireProjection(id).nodeStates.work
    assert.deepEqual(node.slip, {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
      taskId: 'edit',
    })
  })

  it('omits static fields for legacy graphs without a slip snapshot', async () => {
    const service = makeService(new FakeTaskBridge())
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.deepEqual(result.nodes, [{ node_id: 'work', state: 'planned' }])
    assert.equal(store.requireProjection(id).nodeStates.work.slip, undefined)
  })

  it('omits static fields when the definition cannot be resolved', async () => {
    // A resolver that skips contract validation (returns undefined) — the
    // graph stays valid but no slip metadata can be derived.
    const service = makeService(new FakeTaskBridge(), {
      resolveDefinitionContract: () => undefined,
    })
    const graph = linearGraph()
    graph.work = taskNode('work', 'unknown-task')
    const created = await service.create({ graph: { nodes: graph } })
    const id = created.taskgraph.id

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.deepEqual(result.nodes, [{ node_id: 'work', state: 'planned' }])
  })

  it('snapshots slips for AddNode and ReplaceNode patch ops and clears replaced ones', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    resolver.set('task', 'test', 'foreman', {
      category: { id: 'test', displayLabel: '测试' },
      description: 'Generic verification runner',
      agentRuntime: 'forge/general',
    })
    const service = makeService(new FakeTaskBridge(), resolver)
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id

    // Add a second task node and replace the existing one with a different
    // task definition in a single patch.
    const added = taskNode('work2', 'test')
    const replacement = taskNode('work', 'test')
    replacement.name = 'work-replaced'
    const preview = await service.patch({
      taskgraph_id: id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'add and replace',
          created_at: new Date().toISOString(),
          ops: [
            { op: 'AddNode', node: added },
            { op: 'ReplaceNode', node: replacement },
          ],
        },
      },
    })
    assert.equal(preview.type, 'preview')
    if (preview.type !== 'preview') return
    const applied = await service.patch({
      taskgraph_id: id,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    })
    assert.deepEqual(applied, { type: 'applied', revision: 2 })

    const result = service.slip({ taskgraph_id: id, node_ids: ['work', 'work2'] })
    assert.deepEqual(result.nodes, [
      {
        node_id: 'work',
        state: 'planned',
        task_id: 'test',
        task_category: 'test',
        display_label: '测试',
        description: 'Generic verification runner',
        agent_runtime: 'forge/general',
      },
      {
        node_id: 'work2',
        state: 'planned',
        task_id: 'test',
        task_category: 'test',
        display_label: '测试',
        description: 'Generic verification runner',
        agent_runtime: 'forge/general',
      },
    ])
    assert.equal(store.requireProjection(id).nodeStates.work.slip?.category?.id, 'test')
    assert.equal(store.requireProjection(id).nodeStates.work2.slip?.category?.id, 'test')
  })

  it('clears a stored slip when ReplaceNode no longer resolves task metadata', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', { category: { id: 'edit', displayLabel: '编码' } })
    const service = makeService(new FakeTaskBridge(), resolver)
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id
    assert.ok(store.requireProjection(id).nodeStates.work.slip)

    // Replace the task node with a non-task action node; the slip is cleared.
    const shellNode: TaskGraphNode = {
      ...taskNode('work', 'edit'),
      action: { type: 'shell', params: { command: 'true' } },
    }
    const preview = await service.patch({
      taskgraph_id: id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'replace with shell',
          created_at: new Date().toISOString(),
          ops: [{ op: 'ReplaceNode', node: shellNode }],
        },
      },
    })
    assert.equal(preview.type, 'preview')
    if (preview.type !== 'preview') return
    await service.patch({
      taskgraph_id: id,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    })

    assert.equal(store.requireProjection(id).nodeStates.work.slip, undefined)
  })

  it('does not expose raw output, error, or action params through the slip projection', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    const bridge = new FakeTaskBridge()
    const service = makeService(bridge, resolver)
    const created = await service.create({ graph: { nodes: linearGraph() } })
    const id = created.taskgraph.id

    // Drive the work node to done so raw output node data exists.
    service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'done')

    // The slip DTO is a whitelist: only bounded static display metadata and
    // node state, never output, error, or action params.
    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.deepEqual(Object.keys(result.nodes[0]).sort(), [
      'agent_runtime',
      'description',
      'display_label',
      'node_id',
      'state',
      'task_category',
      'task_id',
    ])
    assert.deepEqual(store.requireProjection(id).nodeStates.work.output, { status: 'ok' })
  })
})

// ─── taskgraph.slip request validation ──────────────────────────────────────

describe('taskgraph.slip request limits and atomic errors', () => {
  it('returns nodes in request order', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', { category: { id: 'edit', displayLabel: '编码' } })
    resolver.set('task', 'test', 'foreman', { category: { id: 'test', displayLabel: '测试' } })
    const service = makeService(new FakeTaskBridge(), resolver)
    const id = (await service.create({ graph: { nodes: twoTaskGraph() } })).taskgraph.id

    const ordered = service.slip({ taskgraph_id: id, node_ids: ['right', 'left'] })
    assert.deepEqual(ordered.nodes.map((node) => node.node_id), ['right', 'left'])
    assert.equal(ordered.nodes[0].task_category, 'test')
  })

  it('fails the whole request on duplicate node ids', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: ['work', 'work'] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        assert.match(error.message, /duplicate node_id/u)
        return true
      },
    )
  })

  it('fails the whole request on unknown node ids', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: ['missing'] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        assert.match(error.message, /not an existing task action node/u)
        return true
      },
    )
  })

  it('fails the whole request on non-task node ids', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: ['start'] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        assert.match(error.message, /not an existing task action node/u)
        return true
      },
    )
  })

  it('fails the whole request when one requested id is invalid among valid ones', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: ['work', 'missing'] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        return true
      },
    )
  })

  it('rejects empty and oversized node id lists', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: [] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        return true
      },
    )
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: Array.from({ length: 257 }, (_, index) => `n${index}`) }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        return true
      },
    )
  })

  it('rejects node ids longer than 128 UTF-16 code units', async () => {
    const service = makeService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id
    assert.throws(
      () => service.slip({ taskgraph_id: id, node_ids: ['x'.repeat(129)] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_SLIP_REQUEST')
        return true
      },
    )
  })

  it('fails the whole request for an unknown taskgraph', async () => {
    const service = makeService(new FakeTaskBridge())
    assert.throws(
      () => service.slip({ taskgraph_id: 'tg_nope', node_ids: ['work'] }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'TASKGRAPH_NOT_FOUND')
        return true
      },
    )
  })
})

// ─── slip DTO builder: bounds, truncation, telemetry omission ───────────────

describe('buildTaskSlipNode field bounds and telemetry omission', () => {
  it('collapses and truncates a long multiline description to 280 units', () => {
    const node = buildTaskSlipNode({
      nodeId: 'work',
      state: 'planned',
      slip: buildTaskNodeSlip({
        definitionId: 'edit',
        kind: 'task',
        project: 'foreman',
        input: undefined,
        description: `line one\n   ${'x'.repeat(300)}`,
      }),
    })
    assert.equal(typeof node.description, 'string')
    assert.equal(node.description!.length, 280)
    assert.equal(node.description!.includes('\n'), false)
  })

  it('truncates an over-long agent runtime to 128 units', () => {
    const node = buildTaskSlipNode({
      nodeId: 'work',
      state: 'planned',
      slip: { agentRuntime: 'forge/'.concat('r'.repeat(140)) },
    })
    assert.equal(node.agent_runtime!.length, 128)
  })

  it('projects task_id from the resolved definition and bounds it to 128 units', () => {
    const node = buildTaskSlipNode({
      nodeId: 'work',
      state: 'planned',
      slip: buildTaskNodeSlip({
        definitionId: 'forge-deploy',
        kind: 'task',
        project: 'foreman',
        input: undefined,
      }),
    })
    assert.equal(node.task_id, 'forge-deploy')
    const long = buildTaskSlipNode({
      nodeId: 'work',
      state: 'planned',
      slip: { taskId: 'x'.repeat(200) },
    })
    assert.equal(long.task_id!.length, 128)
  })

  it('omits task_id for legacy slips without a definition name', () => {
    const node = buildTaskSlipNode({
      nodeId: 'work',
      state: 'planned',
      slip: { category: { id: 'edit', displayLabel: '编码' } },
    })
    assert.equal('task_id' in node, false)
    assert.equal(node.task_category, 'edit')
  })

  it('omits telemetry and summary fields until telemetry work', () => {
    // The slip DTO is a strict whitelist: no tool call count, tps, or
    // execution summary is invented while telemetry data is unavailable.
    const done = buildTaskSlipNode({ nodeId: 'work', state: 'done' })
    assert.deepEqual(Object.keys(done).sort(), ['node_id', 'state'])
    const withSlip = buildTaskSlipNode({
      nodeId: 'work',
      state: 'done',
      slip: { category: { id: 'edit', displayLabel: '编码' }, description: 'x', agentRuntime: 'forge/fast' },
    })
    assert.deepEqual(Object.keys(withSlip).sort(), [
      'agent_runtime',
      'description',
      'display_label',
      'node_id',
      'state',
      'task_category',
    ])
  })

  it('includes only the required node_id and state when nothing else is present', () => {
    const node = buildTaskSlipNode({ nodeId: 'work', state: 'planned' })
    assert.deepEqual(node, { node_id: 'work', state: 'planned' })
  })
})

// ─── Atomic snapshot and v1 wire contract ───────────────────────────────────

interface SlipNodeWithTelemetry {
  node_id: string
  state: string
  tool_call_count?: number
  tps?: number
  profile?: string
  summary?: string
  [key: string]: unknown
}

describe('taskgraph.slip atomic snapshot and v1 wire', () => {
  it('emits exactly the reviewed v1 wire with a literal version and no legacy aliases', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', { category: { id: 'edit', displayLabel: '编码' } })
    const service = makeService(new FakeTaskBridge(), resolver)
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id

    const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.equal(result.schema_version, 'foreman.taskgraph.slip.v1')
    assert.equal(typeof result.schema_version, 'string')
    assert.equal(result.taskgraph_id, id)
    assert.equal(result.graph_state, 'created')
    assert.equal(typeof result.structure_revision, 'number')
    assert.equal(typeof result.latest_seq, 'number')
    // No numeric version or legacy graph_id/state aliases on the wire.
    assert.deepEqual(Object.keys(result).sort(), [
      'graph_state',
      'latest_seq',
      'nodes',
      'schema_version',
      'structure_revision',
      'taskgraph_id',
    ])
  })

  it('freezes static slip data at snapshot time and never mutates a structure revision', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    const service = makeService(new FakeTaskBridge(), resolver)
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id

    const before = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    // A later definition hot reload must not mutate the already-snapshotted
    // structure revision: static slip data is immutable once persisted.
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'editor', displayLabel: '编辑器' },
      description: 'Changed by hot reload',
      agentRuntime: 'forge/slow',
    })
    const after = service.slip({ taskgraph_id: id, node_ids: ['work'] })
    assert.equal(after.structure_revision, 1)
    assert.deepEqual(after.nodes[0], before.nodes[0])
    assert.equal(after.nodes[0].task_category, 'edit')
    assert.equal(store.requireProjection(id).nodeStates.work.slip?.category?.id, 'edit')
  })

  it('serves any requested node count with one batched read (no N+1)', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', { category: { id: 'edit', displayLabel: '编码' } })
    resolver.set('task', 'test', 'foreman', { category: { id: 'test', displayLabel: '测试' } })
    const service = makeService(new FakeTaskBridge(), resolver)
    const id = (await service.create({ graph: { nodes: twoTaskGraph() } })).taskgraph.id

    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = ((sql: string) => {
      prepareCount += 1
      return originalPrepare(sql)
    }) as typeof db.prepare
    try {
      service.slip({ taskgraph_id: id, node_ids: ['left'] })
      const countForOne = prepareCount
      prepareCount = 0
      service.slip({ taskgraph_id: id, node_ids: ['left', 'right'] })
      const countForTwo = prepareCount
      assert.equal(countForOne, countForTwo, 'node count must not change the number of queries')
      assert.ok(countForOne <= 8, `expected a bounded batch, got ${countForOne} prepared statements`)
    } finally {
      db.prepare = originalPrepare
    }
  })

  it('serves revision, seq, state and telemetry from one committed snapshot across a concurrent-commit seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-slip-seam-'))
    const path = join(dir, 'slip.db')
    let readerDb: ForemanDatabase | undefined
    let writerDb: ForemanDatabase | undefined
    try {
      readerDb = new Database(path)
      readerDb.pragma('journal_mode = WAL')
      bootstrapSchema(readerDb)
      writerDb = new Database(path)

      const resolver = new SlipContractResolver()
      resolver.set('task', 'edit', 'foreman', {
        category: { id: 'edit', displayLabel: '编码' },
        description: 'File-level edit executor',
        agentRuntime: 'forge/fast',
      })
      const bridge = new FakeTaskBridge()
      const service = new TaskGraphService({
        db: readerDb,
        workspaceRoot: process.cwd(),
        taskBridge: bridge,
        contractResolver: resolver,
      })
      const created = await service.create({ graph: { nodes: linearGraph() } })
      const id = created.taskgraph.id

      // Durable telemetry plus a done work node so dynamic facts exist.
      setupTaskAndExecution(readerDb, 'task_1', 'exec_seam', {
        summary: 'All criteria passed.',
        profile: 'forge/fast',
      })
      writeEvent(readerDb, 'exec_seam', 'task_1', 1, 'tool_call', { name: 'bash' })
      service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
      await service.whenIdle(id)
      bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
      await settle(service, id)

      // Snapshot the pre-seam facts the reader must report.
      const preSeam = readerDb.prepare<[string], { state: string; structure_revision: number }>(
        'SELECT state, structure_revision FROM taskgraph_run WHERE id = ?',
      ).get(id)
      assert.ok(preSeam)
      const preSeamSeq = readerDb.prepare<[string], { latest_seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM taskgraph_journal WHERE taskgraph_id = ?',
      ).get(id)?.latest_seq ?? 0

      // Controlled seam: the writer commits from a second connection at the
      // exact moment the reader's slip snapshot reads the journal latest-seq.
      // The reader's transaction snapshot is already fixed, so the commit must
      // be invisible to every fact in the same response — any mix of the
      // pre/post snapshots fails this test.
      const latestSeqSql = 'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM taskgraph_journal WHERE taskgraph_id = ?'
      const originalPrepare = readerDb.prepare.bind(readerDb)
      let seamArmed = false
      let seamFired = false
      readerDb.prepare = ((sql: string) => {
        const stmt = originalPrepare(sql)
        if (seamArmed && !seamFired && sql === latestSeqSql) {
          seamFired = true
          writerDb!.prepare(
            `INSERT INTO taskgraph_journal (
              taskgraph_id, seq, event_id, type, occurred_at, structure_revision,
              source_json, refs_json, data_json
            ) VALUES (?, ?, ?, 'taskgraph.paused', ?, ?, ?, NULL, ?)`,
          ).run(
            id, preSeamSeq + 1, 'tge_seam', new Date().toISOString(),
            preSeam.structure_revision + 1, JSON.stringify({ kind: 'client' }), '{}',
          )
          writerDb!.prepare(
            'UPDATE taskgraph_node_state SET state = ?, updated_at = ? WHERE taskgraph_id = ? AND node_id = ?',
          ).run('interrupted', T0, id, 'work')
          writerDb!.prepare(
            'UPDATE taskgraph_run SET state = ?, structure_revision = ?, updated_at = ? WHERE id = ?',
          ).run('paused', preSeam.structure_revision + 1, T0, id)
          writerDb!.prepare(
            'UPDATE task_run_telemetry SET tool_call_count = ? WHERE task_run_id = ?',
          ).run(99, 'task_1')
        }
        return stmt
      }) as typeof readerDb.prepare

      seamArmed = true
      const result = service.slip({ taskgraph_id: id, node_ids: ['work'] })
      seamArmed = false

      // Every fact corresponds to one committed snapshot; the mid-flight
      // writer commit must not leak into any field.
      assert.equal(result.schema_version, 'foreman.taskgraph.slip.v1')
      assert.equal(result.taskgraph_id, id)
      assert.equal(result.graph_state, preSeam.state)
      assert.equal(result.structure_revision, preSeam.structure_revision)
      assert.equal(result.latest_seq, preSeamSeq)
      const node = result.nodes[0] as SlipNodeWithTelemetry
      assert.equal(node.state, 'done')
      assert.equal(node.tool_call_count, 1)
      assert.equal(node.profile, 'forge/fast')
      assert.equal(node.summary, 'All criteria passed.')

      // The next slip call sees the committed seam atomically: state,
      // revision, seq, node state and telemetry all advanced together.
      const after = service.slip({ taskgraph_id: id, node_ids: ['work'] })
      assert.equal(after.graph_state, 'paused')
      assert.equal(after.structure_revision, preSeam.structure_revision + 1)
      assert.equal(after.latest_seq, preSeamSeq + 1)
      const afterNode = after.nodes[0] as SlipNodeWithTelemetry
      assert.equal(afterNode.state, 'interrupted')
      assert.equal(afterNode.tool_call_count, 99)
    } finally {
      readerDb?.close()
      writerDb?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds dynamic telemetry fields and folds done-only summaries', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', {
      category: { id: 'edit', displayLabel: '编码' },
      description: 'File-level edit executor',
      agentRuntime: 'forge/fast',
    })
    const bridge = new FakeTaskBridge()
    const service = makeService(bridge, resolver)
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id

    const longSummary = `line one\n\n   ${'x'.repeat(300)}`
    setupTaskAndExecution(db, 'task_1', 'exec_slip_bounds', {
      summary: longSummary,
      profile: 'forge/'.concat('r'.repeat(140)),
    })
    // 1000 * 2_000_000 / 1000 = 2_000_000 > 1_000_000 bound → tps omitted.
    writeEvent(db, 'exec_slip_bounds', 'task_1', 1, 'turn_usage', {
      output_tokens: 2_000_000,
      duration_ms: 1000,
      token_scope: 'agent_turn',
      duration_scope: 'agent_turn',
      tps_contract: 'agent_turn_v1',
    })
    writeEvent(db, 'exec_slip_bounds', 'task_1', 2, 'tool_call', { name: 'bash' })

    service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)

    const node = service.slip({ taskgraph_id: id, node_ids: ['work'] }).nodes[0] as SlipNodeWithTelemetry
    assert.equal(node.tool_call_count, 1)
    assert.equal('tps' in node, false, 'out-of-bound tps must be omitted')
    assert.equal('profile' in node, false, 'over-long profile must be omitted')
    assert.equal(typeof node.summary, 'string')
    assert.equal(node.summary!.length, 280)
    assert.equal(node.summary!.includes('\n'), false)
  })

  it('omits tps for missing/invalid agent_turn and hides the summary for non-done nodes', async () => {
    const resolver = new SlipContractResolver()
    resolver.set('task', 'edit', 'foreman', { category: { id: 'edit', displayLabel: '编码' } })
    const bridge = new FakeTaskBridge()
    const service = makeService(bridge, resolver)
    const id = (await service.create({ graph: { nodes: linearGraph() } })).taskgraph.id

    // A persisted usage event without an agent_turn scope permanently disables TPS.
    setupTaskAndExecution(db, 'task_1', 'exec_slip_bad', { summary: 'All criteria passed.' })
    writeEvent(db, 'exec_slip_bad', 'task_1', 1, 'turn_usage', { output_tokens: 100, duration_ms: 200 })
    service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)

    const doneNode = service.slip({ taskgraph_id: id, node_ids: ['work'] }).nodes[0] as SlipNodeWithTelemetry
    assert.equal(doneNode.state, 'done')
    assert.equal('tps' in doneNode, false, 'missing agent_turn scope must disable tps')
    assert.equal(doneNode.summary, 'All criteria passed.')

    // Flip the node back to running: the summary is done-only and must vanish
    // even though the same task summary is still present in the DB.
    store.putNodeState(id, 'work', { state: 'running', taskRunId: 'task_1' }, T0)
    const runningNode = service.slip({ taskgraph_id: id, node_ids: ['work'] }).nodes[0] as SlipNodeWithTelemetry
    assert.equal(runningNode.state, 'running')
    assert.equal('summary' in runningNode, false)
  })
})
