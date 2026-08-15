import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  TaskGraphService,
  TaskGraphServiceError,
  TaskGraphStore,
  type JsonObject,
  type TaskGraphNode,
  type TaskGraphTaskBridge,
  type TaskGraphTaskHandle,
  type TaskGraphTaskRequest,
  type TaskGraphTaskTerminal,
  type ResolvedDefinitionContract,
  type TaskGraphTaskContractResolver,
} from '../../lib/core/taskgraph/index.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

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

  /** Simulate a task run the daemon no longer knows about at restart. */
  forget(taskRunId: string): void {
    this.handles.delete(taskRunId)
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

/**
 * FakeTaskBridge whose cancel() records the cancellation but does not resolve
 * the task terminal, so a graph mid-cancellation stays running until the real
 * task terminal arrives on its own (e.g. a later failure).
 */
class LazyCancelBridge extends FakeTaskBridge {
  override async cancel(taskRunId: string): Promise<void> {
    this.cancelled.push(taskRunId)
  }
}

class FakeContractResolver implements TaskGraphTaskContractResolver {
  private readonly contracts = new Map<string, unknown>()
  private readonly outputs = new Map<string, unknown>()

  setContract(kind: 'task', name: string, project: string, inputSchema: unknown, outputSchema?: unknown): void;
  /** Convenience: register a task contract for the default 'foreman' project. */
  setContract(kind: 'task', name: string, inputSchema: unknown): void;
  setContract(kind: 'task', name: string, inputSchemaOrProject: unknown, maybeSchema?: unknown, outputSchema?: unknown): void {
    if (arguments.length === 3) {
      this.contracts.set(`${kind}:foreman:${name}`, inputSchemaOrProject)
      return
    }
    const key = `${kind}:${inputSchemaOrProject}:${name}`
    this.contracts.set(key, maybeSchema)
    if (outputSchema !== undefined) {
      this.outputs.set(key, outputSchema)
    }
  }

  resolveDefinitionContract(
    kind: 'task',
    name: string,
    project: string,
  ): ResolvedDefinitionContract | null {
    const key = `${kind}:${project}:${name}`
    if (!this.contracts.has(key)) return null
    return {
      definitionId: name,
      kind,
      project,
      input: this.contracts.get(key) as any,
      ...(this.outputs.has(key) ? { output: this.outputs.get(key) as any } : {}),
    }
  }
}

afterEach(() => {
  closeTestDb()
})

describe('TaskGraph runtime kernel', () => {
  it('starts, dispatches a task, and reaches done', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: linearTaskGraph() } })
    const id = created.taskgraph.id

    assert.deepEqual(service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'hello' } },
    }), { accepted: true })
    await service.whenIdle(id)

    assert.equal(service.status({ taskgraph_id: id }).state, 'running')
    assert.equal(bridge.requests.length, 1)
    assert.deepEqual(
      JSON.parse(JSON.stringify(bridge.requests[0].input)),
      { seed: 'hello' },
    )

    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'done')
    assert.deepEqual(status.terminal, {
      outcome: 'done',
      end_output: { status: 'ok' },
    })
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'done')
    assert.ok(service.events({ taskgraph_id: id }).events
      .some((event) => event.type === 'taskgraph.done'))
  })

  it('persists tg_ctx and passes it to every dispatched task request', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({
      graph: { nodes: linearTaskGraph() },
      tg_ctx: { decision: 'preserve API', file: { path: 'src/a.ts', content: 'export const a = 1' } },
    })
    const id = created.taskgraph.id
    assert.deepEqual(service.inspectGraph({ taskgraph_id: id }).graph.tg_ctx, {
      decision: 'preserve API',
      file: { path: 'src/a.ts', content: 'export const a = 1' },
    })

    service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'hello' } } })
    await service.whenIdle(id)

    assert.deepEqual(bridge.requests[0]?.ctx, {
      decision: 'preserve API',
      file: { path: 'src/a.ts', content: 'export const a = 1' },
    })
  })

  it('preserves a literal array task input for builtin task contracts', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: literalArrayTaskGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: {} },
    })
    await service.whenIdle(id)

    assert.deepEqual(
      JSON.parse(JSON.stringify(bridge.requests[0]?.input)),
      [{ id: 'check', then: 'passes' }],
    )
    bridge.terminal('task_1', { status: 'done', output: { result: 'passed' } })
    await settle(service, id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'done')
  })

  it('pauses on task failure, resets a patched failed node, then resumes to done', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: linearTaskGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'first' } },
    })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    await settle(service, id)

    let status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'paused')
    assert.equal(status.node_counts.failed, 1)
    assert.equal(status.terminal, undefined)

    const replacement = taskNode()
    replacement.name = 'work-after-fix'
    const preview = await service.patch({
      taskgraph_id: id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'repair failed node',
          created_at: new Date().toISOString(),
          ops: [{ op: 'ReplaceNode', node: replacement }],
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
    const consumed = await service.patch({
      taskgraph_id: id,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    })
    assert.equal(consumed.type, 'rejected')
    if (consumed.type === 'rejected') {
      assert.equal(consumed.errors[0].code, 'PATCH_NOT_FOUND')
    }
    const stale = await service.patch({
      taskgraph_id: id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'stale',
          created_at: new Date().toISOString(),
          ops: [],
        },
      },
    })
    assert.equal(stale.type, 'rejected')
    if (stale.type === 'rejected') assert.equal(stale.errors[0].code, 'STALE_BASE')
    const reset = service.inspect({ taskgraph_id: id, node_id: 'work' })
    assert.equal(reset.run.state, 'planned')
    assert.equal(reset.run.error, undefined)
    assert.equal(reset.run.task_run_id, undefined)
    assert.equal(reset.output, undefined)
    assert.equal(service.status({ taskgraph_id: id }).state, 'paused')

    service.signal({ taskgraph_id: id, signal: { type: 'resume_graph' } })
    await service.whenIdle(id)
    assert.equal(bridge.requests.length, 2)
    bridge.terminal('task_2', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)

    status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'done')
    assert.equal(status.structure_revision, 2)
    const eventTypes = service.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(eventTypes.includes('taskgraph.node.failed'))
    assert.ok(eventTypes.includes('taskgraph.patch.applied'))
    assert.ok(eventTypes.includes('taskgraph.resumed'))
  })

  it('consumes a pending patch when an agent reviewer rejects it', async () => {
    const service = createService(new FakeTaskBridge())
    const created = await service.create({ graph: { nodes: linearTaskGraph() } })
    const preview = await service.patch({
      taskgraph_id: created.taskgraph.id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'review rejection',
          created_at: new Date().toISOString(),
          ops: [],
        },
      },
    })
    assert.equal(preview.type, 'preview')
    if (preview.type !== 'preview') return
    assert.equal(await service.rejectPatch(created.taskgraph.id, preview.patch_id), true)
    assert.equal(await service.rejectPatch(created.taskgraph.id, preview.patch_id), false)
    const consumed = await service.patch({
      taskgraph_id: created.taskgraph.id,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    })
    assert.equal(consumed.type, 'rejected')
  })

  it('routes condition output by downstream node id and cancels the unselected branch', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: conditionGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { status: 'ok' } },
    })
    await service.whenIdle(id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'done')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'choose' }).output?.branch, 'success')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'success' }).run.state, 'done')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'fallback' }).run.state, 'cancelled')
  })

  it('sets cancel_requested, interrupts a running task, and converges to cancelled', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: linearTaskGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'cancel-me' } },
    })
    await service.whenIdle(id)
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'running')

    assert.deepEqual(service.signal({
      taskgraph_id: id,
      signal: { type: 'cancel_graph' },
    }), { accepted: true })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    assert.equal(status.cancel_requested, undefined)
    assert.deepEqual(status.terminal, { outcome: 'cancelled' })
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'interrupted')
    assert.deepEqual(bridge.cancelled, ['task_1'])
  })

  it('keeps the graph running at a checkpoint and resumes only with schema-valid output', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: checkpointGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'checkpoint' } },
    })
    await service.whenIdle(id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'running')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'approval' }).run.state, 'waiting')

    service.signal({
      taskgraph_id: id,
      signal: { type: 'resume_checkpoint', node_id: 'approval', output: {} },
    })
    await service.whenIdle(id)
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'approval' }).run.state, 'waiting')
    const ignored = service.events({ taskgraph_id: id }).events
      .filter((event) => event.type === 'taskgraph.signal.ignored')
      .at(-1)
    assert.equal(ignored?.data.reason_code, 'CHECKPOINT_OUTPUT_SCHEMA_MISMATCH')

    service.signal({
      taskgraph_id: id,
      signal: {
        type: 'resume_checkpoint',
        node_id: 'approval',
        output: { decision: 'approved' },
      },
    })
    await service.whenIdle(id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'done')
    assert.deepEqual(service.status({ taskgraph_id: id }).terminal, {
      outcome: 'done',
      end_output: { decision: 'approved' },
    })
  })

  it('serializes simultaneous task terminals through the graph event queue', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({ graph: { nodes: parallelTaskGraph() } })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'parallel' } },
    })
    await service.whenIdle(id)
    assert.equal(bridge.requests.length, 2)

    bridge.terminal('task_1', { status: 'done', output: { left: 'L' } })
    bridge.terminal('task_2', { status: 'done', output: { right: 'R' } })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'done')
    assert.deepEqual(status.terminal, {
      outcome: 'done',
      end_output: { left: 'L', right: 'R' },
    })
    assert.equal(status.node_counts.failed, 0)
  })

  it('reads projections after service recreation and reattaches an in-flight task', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({
      db,
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
    })
    const created = await first.create({ graph: { nodes: linearTaskGraph() } })
    const id = created.taskgraph.id
    first.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'restart' } },
    })
    await first.whenIdle(id)

    const restored = new TaskGraphService({
      db,
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
    })
    assert.equal(restored.status({ taskgraph_id: id }).state, 'running')
    await restored.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(restored, id)
    assert.equal(restored.status({ taskgraph_id: id }).state, 'done')
  })

  it('validates literal task input and defers template input using contract resolver (B7)', async () => {
    const bridge = new FakeTaskBridge()
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'b7-task', { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] })
    const service = new TaskGraphService({
      db: initTestDb(),
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
      contractResolver,
    })

    // Create with a $inputs template — should defer, no validation error
    const templateGraph: { nodes: Record<string, TaskGraphNode> } = {
      nodes: {
        start: startNode(objectSchema({ seed: { type: 'string' } })),
        work: {
          id: 'work',
          name: 'work',
          action: {
            type: 'task',
            params: { name: 'b7-task', project: 'foreman', input: { val: '$inputs.seed' } },
          },
          deps: ['start'],
          input: [{ name: 'seed', source: 'start.seed' }],
          input_schema: objectSchema({ seed: { type: 'string' } }, []),
          output_schema: objectSchema({ status: { type: 'string' } }),
        } as TaskGraphNode,
        end: {
          id: 'end',
          name: 'end',
          action: { type: 'end', params: {} },
          deps: ['work'],
          input: [{ name: 'status', source: 'work.status' }],
          input_schema: objectSchema({ status: { type: 'string' } }),
          output_schema: objectSchema({ status: { type: 'string' } }),
        },
      },
    }
    const created = await service.create({ graph: templateGraph })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'ok' } },
    })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'done')
  })

  it('wait resolves without polling when the graph reaches a terminal done state', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'wait-done' } },
    })
    await service.whenIdle(id)
    assert.equal(service.status({ taskgraph_id: id }).state, 'running')

    const waiting = service.wait({ taskgraph_id: id, timeout_ms: 2_000 })
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    const result = await waiting

    assert.equal(result.reason, 'done')
    assert.equal(result.state, 'done')
    assert.deepEqual(result.terminal, {
      outcome: 'done',
      end_output: { status: 'ok' },
    })
  })

  it('wait reports an active waiting checkpoint without polling', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: checkpointGraph() } })).taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'checkpoint' } },
    })
    await service.whenIdle(id)

    const result = await service.wait({ taskgraph_id: id, timeout_ms: 2_000 })
    assert.equal(result.reason, 'waiting')
    assert.equal(result.state, 'running')
    assert.equal(result.checkpoint_node_id, 'approval')
  })

  it('does not treat a just-created graph as terminal and times out', async () => {
    const service = createService(new FakeTaskBridge())
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    const result = await service.wait({ taskgraph_id: id, timeout_ms: 50 })
    assert.equal(result.reason, 'timeout')
    assert.equal(result.state, 'created')
  })

  it('wait returns paused when a node failure pauses the graph', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'fail' } },
    })
    await service.whenIdle(id)

    const waiting = service.wait({ taskgraph_id: id, timeout_ms: 2_000 })
    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    const result = await waiting

    assert.equal(result.reason, 'paused')
    assert.equal(result.state, 'paused')
    assert.equal(result.terminal, undefined)
  })

  it('wait returns cancelled after the graph converges to cancelled', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'cancel' } },
    })
    await service.whenIdle(id)

    const waiting = service.wait({ taskgraph_id: id, timeout_ms: 2_000 })
    service.signal({ taskgraph_id: id, signal: { type: 'cancel_graph' } })
    const result = await waiting

    assert.equal(result.reason, 'cancelled')
    assert.equal(result.state, 'cancelled')
    assert.deepEqual(result.terminal, { outcome: 'cancelled' })
  })

  it('taskgraph list reports lifecycle state for CLI parity', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    let runs = service.list().runs
    assert.equal(runs.length, 1)
    assert.equal(runs[0].taskgraph_id, id)
    assert.equal(runs[0].state, 'created')
    assert.equal(runs[0].structure_revision, 1)
    assert.equal(typeof runs[0].created_at, 'string')
    assert.equal(typeof runs[0].updated_at, 'string')

    service.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'list' } } })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(service, id)

    runs = service.list().runs
    assert.equal(runs[0].state, 'done')
    assert.equal(typeof runs[0].ended_at, 'string')
  })

  it('materializes task node output schemas from the current task contract', async () => {
    const bridge = new FakeTaskBridge()
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract(
      'task',
      'contract-task',
      'foreman',
      { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
      { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    )
    const service = new TaskGraphService({
      db: initTestDb(),
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
      contractResolver,
    })

    const created = await service.create({ graph: { nodes: contractSchemaTaskGraph() } })
    const id = created.taskgraph.id

    const work = service.inspect({ taskgraph_id: id, node_id: 'work' })
    assert.deepEqual(work.node.output_schema, {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
    })
  })

  it('materializes a non-object task output under the task-bridge result wrapper', async () => {
    const bridge = new FakeTaskBridge()
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract(
      'task',
      'array-task',
      'foreman',
      {
        anyOf: [
          { type: 'object', properties: { changes: { type: 'array' } }, required: ['changes'] },
          { type: 'array' },
        ],
      },
      { type: 'array', items: { type: 'string' } },
    )
    const service = new TaskGraphService({
      db: initTestDb(),
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
      contractResolver,
    })

    const created = await service.create({ graph: { nodes: arrayContractTaskGraph() } })
    const work = service.inspect({ taskgraph_id: created.taskgraph.id, node_id: 'work' })
    assert.deepEqual(work.node.output_schema, {
      type: 'object',
      properties: {
        result: { type: 'array', items: { type: 'string' } },
      },
      required: ['result'],
      additionalProperties: false,
    })
  })

  it('materializes a task output schema carrying a Draft-07 tuple items array (strictTuples compat)', async () => {
    const bridge = new FakeTaskBridge()
    const contractResolver = new FakeContractResolver()
    // Real catalog shape: a task contract whose input and output schemas use a
    // Draft-07 tuple-form `items` array without redundant minItems/maxItems/
    // additionalItems declarations.
    const tupleSchema = {
      type: 'object',
      properties: {
        line_range: {
          type: 'array',
          items: [{ type: 'number' }, { type: 'number' }],
        },
      },
      required: ['line_range'],
      additionalProperties: false,
    }
    contractResolver.setContract('task', 'tuple-task', 'foreman', tupleSchema, tupleSchema)
    const service = new TaskGraphService({
      db: initTestDb(),
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
      contractResolver,
    })

    const created = await service.create({ graph: { nodes: tupleContractTaskGraph() } })
    const id = created.taskgraph.id

    const work = service.inspect({ taskgraph_id: id, node_id: 'work' })
    assert.deepEqual(work.node.output_schema, tupleSchema)
  })

  it('fails validation clearly when no task contract can resolve an omitted output schema', async () => {
    const bridge = new FakeTaskBridge()
    const service = new TaskGraphService({
      db: initTestDb(),
      workspaceRoot: process.cwd(),
      taskBridge: bridge,
      contractResolver: new FakeContractResolver(),
    })

    await assert.rejects(
      service.create({ graph: { nodes: contractSchemaTaskGraph() } }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_GRAPH')
        assert.match(error.message, /MAP_PATH_UNKNOWN|SCHEMA_REQUIRED/u)
        return true
      },
    )
  })

  it('fails a persisted running node with no task run binding on restart recovery', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({ graph: { nodes: linearTaskGraph() } })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'recover' } } })
    await first.whenIdle(id)
    assert.equal(first.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'running')

    // Simulate a daemon restart artifact: the running node persisted without
    // any task run binding, so it can never be reattached or redispatched.
    new TaskGraphStore(db).putNodeState(
      id,
      'work',
      { state: 'running', error: null, output: null, taskRunId: null },
      new Date().toISOString(),
    )

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'paused')
    assert.equal(status.node_counts.failed, 1)
    const work = restored.inspect({ taskgraph_id: id, node_id: 'work' })
    assert.equal(work.run.state, 'failed')
    assert.equal(work.run.error?.code, 'TASK_RUN_UNBOUND')
    const eventTypes = restored.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(eventTypes.includes('taskgraph.node.failed'))
    assert.ok(eventTypes.includes('taskgraph.paused'))
  })

  it('isolates reattach failures per node without aborting sibling recovery', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({ graph: { nodes: parallelTaskGraph() } })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'recover' } } })
    await first.whenIdle(id)
    assert.equal(first.status({ taskgraph_id: id }).node_counts.running, 2)

    // Simulate a restart where one task run is unknown to the daemon.
    bridge.forget('task_2')

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'paused')
    assert.equal(status.node_counts.failed, 1)
    // The healthy sibling reattached and keeps running.
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'left' }).run.state, 'running')
    const right = restored.inspect({ taskgraph_id: id, node_id: 'right' })
    assert.equal(right.run.state, 'failed')
    assert.equal(right.run.error?.code, 'TASK_RUN_REATTACH_FAILED')
  })

  it('omitted policy preserves node failure -> paused with no persisted cause', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const id = (await service.create({ graph: { nodes: linearTaskGraph() } })).taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'fail' } },
    })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'paused')
    assert.equal(status.on_node_failure, 'pause')
    assert.equal(status.terminal, undefined)
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.error?.code, 'TASK_RUN_FAILED')
    const eventTypes = service.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(eventTypes.includes('taskgraph.paused'))
    assert.ok(!eventTypes.includes('taskgraph.cancelled'))
  })

  it('cancel policy converges a failing task node to cancelled with full failure evidence', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({
      graph: { nodes: linearTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'fail' } },
    })
    await service.whenIdle(id)
    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    assert.equal(status.on_node_failure, 'cancel')
    assert.equal(status.cancel_requested, undefined)
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    const failure = terminal.failure
    assert.equal(failure?.kind, 'node_failed')
    assert.equal(failure?.node_id, 'work')
    assert.equal(failure?.task_run_id, 'task_1')
    assert.equal(failure?.error.code, 'TASK_RUN_FAILED')
    assert.equal(failure?.error.message, 'boom')
    assert.ok(typeof failure?.event_id === 'string' && failure.event_id.length > 0)

    // The failed node stays failed and no paused event is emitted.
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')
    const eventTypes = service.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(!eventTypes.includes('taskgraph.paused'))
    assert.ok(eventTypes.includes('taskgraph.node.failed'))
    assert.ok(eventTypes.includes('taskgraph.cancelled'))

    // Terminal evidence remains available through list and wait.
    const summary = service.list().runs[0]
    assert.equal(summary.state, 'cancelled')
    assert.equal(summary.on_node_failure, 'cancel')
    assert.equal(summary.failure?.node_id, 'work')
    assert.equal(summary.failure?.error.code, 'TASK_RUN_FAILED')

    const wait = await service.wait({ taskgraph_id: id, timeout_ms: 1_000 })
    assert.equal(wait.reason, 'cancelled')
    assert.equal(wait.state, 'cancelled')
    assert.equal(wait.on_node_failure, 'cancel')
    const waitTerminal = wait.terminal
    if (waitTerminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    assert.equal(waitTerminal.failure?.node_id, 'work')
  })

  it('cancel policy interrupts running siblings and cancels planned/waiting ones', async () => {
    const bridge = new FakeTaskBridge()
    const service = createService(bridge)
    const created = await service.create({
      graph: { nodes: parallelTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id

    service.signal({
      taskgraph_id: id,
      signal: { type: 'start_graph', input: { seed: 'go' } },
    })
    await service.whenIdle(id)
    assert.equal(service.status({ taskgraph_id: id }).node_counts.running, 2)

    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    await settle(service, id)

    const status = service.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    assert.equal(terminal.failure?.kind, 'node_failed')
    assert.equal(terminal.failure?.node_id, 'left')
    // Failing node stays failed; running sibling was cancelled via the bridge.
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'left' }).run.state, 'failed')
    assert.equal(service.inspect({ taskgraph_id: id, node_id: 'right' }).run.state, 'interrupted')
    assert.deepEqual(bridge.cancelled, ['task_2'])
    assert.ok(!service.events({ taskgraph_id: id }).events
      .some((event) => event.type === 'taskgraph.paused'))
  })

  it('tracks cancellation of multiple active task runs concurrently and is replay-idempotent', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({ graph: { nodes: parallelTaskGraph() } })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
    await first.whenIdle(id)
    assert.equal(first.status({ taskgraph_id: id }).node_counts.running, 2)

    // Cancel must request termination of every bound running task concurrently.
    first.signal({ taskgraph_id: id, signal: { type: 'cancel_graph' } })
    await settle(first, id)

    assert.deepEqual([...bridge.cancelled].sort(), ['task_1', 'task_2'])

    const status = first.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    assert.equal(status.cancel_requested, undefined, 'cancel_requested must converge back to absent')
    assert.deepEqual(status.terminal, { outcome: 'cancelled' })
    assert.equal(first.inspect({ taskgraph_id: id, node_id: 'left' }).run.state, 'interrupted')
    assert.equal(first.inspect({ taskgraph_id: id, node_id: 'right' }).run.state, 'interrupted')
    assert.equal(first.inspect({ taskgraph_id: id, node_id: 'end' }).run.state, 'cancelled')

    const events = first.events({ taskgraph_id: id }).events
    assert.equal(events.filter((e) => e.type === 'taskgraph.node.interrupted').length, 2,
      'each running node must interrupt exactly once')
    assert.equal(events.filter((e) => e.type === 'taskgraph.cancelled').length, 1,
      'graph cancelled must be emitted exactly once')

    // Replaying the converged graph through a fresh service must not duplicate
    // lifecycle events or mutate terminal evidence.
    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const restoredEvents = restored.events({ taskgraph_id: id }).events
    assert.equal(restoredEvents.filter((e) => e.type === 'taskgraph.node.interrupted').length, 2,
      'recovery must not duplicate interrupted events')
    assert.equal(restoredEvents.filter((e) => e.type === 'taskgraph.cancelled').length, 1,
      'recovery must not duplicate graph cancelled')
    assert.equal(restored.status({ taskgraph_id: id }).state, 'cancelled')

    // Late terminal delivery for an already-converged run is a no-op.
    bridge.terminal('task_1', { status: 'cancelled' })
    bridge.terminal('task_2', { status: 'done', output: { right: 'R' } })
    await settle(restored, id)
    const lateEvents = restored.events({ taskgraph_id: id }).events
    assert.equal(lateEvents.filter((e) => e.type === 'taskgraph.node.interrupted').length, 2,
      'late terminal delivery must not duplicate interrupted events')
    assert.equal(lateEvents.filter((e) => e.type === 'taskgraph.node.completed').length, 0,
      'late conflicting terminal delivery must not complete an interrupted node')
    assert.equal(lateEvents.filter((e) => e.type === 'taskgraph.cancelled').length, 1,
      'late terminal delivery must not duplicate graph cancelled')
    assert.equal(restored.status({ taskgraph_id: id }).state, 'cancelled')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'right' }).run.state, 'interrupted')
  })

  it('recovery failure under a cancel policy converges to cancelled with recovery_failed evidence', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: linearTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'recover' } } })
    await first.whenIdle(id)
    assert.equal(first.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'running')

    // Simulate a restart where the daemon can no longer reattach the task run.
    bridge.forget('task_1')

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    const failure = terminal.failure
    assert.equal(failure?.kind, 'recovery_failed')
    assert.equal(failure?.node_id, 'work')
    assert.equal(failure?.error.code, 'TASK_RUN_REATTACH_FAILED')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')
    assert.ok(!restored.events({ taskgraph_id: id }).events
      .some((event) => event.type === 'taskgraph.paused'))
  })

  it('restart with persisted cancellation intent and no running nodes finishes immediately', async () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: linearTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id

    // Simulate a crash mid-cancellation: failed node + cancel_requested + cause
    // persisted, end node still planned, no running nodes, run not yet terminal.
    const now = new Date().toISOString()
    store.putNodeState(id, 'work', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      output: null,
      taskRunId: null,
    }, now)
    store.updateRun(id, {
      state: 'paused',
      cancelRequested: true,
      failureCause: {
        kind: 'node_failed',
        node_id: 'work',
        error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      },
    }, now)

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    assert.equal(terminal.failure?.node_id, 'work')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'end' }).run.state, 'cancelled')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')
  })

  it('restart does not strand or mutate a converged cancel-policy graph', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: linearTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'x' } } })
    await first.whenIdle(id)
    bridge.terminal('task_1', { status: 'failed', error: 'boom' })
    await settle(first, id)
    assert.equal(first.status({ taskgraph_id: id }).state, 'cancelled')

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    assert.equal(terminal.failure?.node_id, 'work')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')

    // Recovery is idempotent: a second restart changes nothing and preserves evidence.
    const again = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    again.status({ taskgraph_id: id })
    await again.whenIdle(id)
    const againStatus = again.status({ taskgraph_id: id })
    assert.equal(againStatus.state, 'cancelled')
    const againTerminal = againStatus.terminal
    if (againTerminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    assert.equal(againTerminal.failure?.node_id, 'work')
    assert.equal(again.inspect({ taskgraph_id: id, node_id: 'work' }).run.state, 'failed')
  })

  it('restart repairs a cancel-policy failed node missing intent/evidence, recovers the live sibling, and keeps the first cause through a later failure', async () => {
    const db = initTestDb()
    const bridge = new LazyCancelBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: parallelTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'crash' } } })
    await first.whenIdle(id)
    assert.equal(first.status({ taskgraph_id: id }).node_counts.running, 2)

    // Crash artifact: left failed (node state + journal persisted) but the
    // cancel-policy cause/intent commit never landed; right is still running
    // and reattachable.
    const now = new Date().toISOString()
    const store = new TaskGraphStore(db)
    store.putNodeState(id, 'left', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
      output: null,
      taskRunId: null,
    }, now)
    const evidence = store.appendJournal({
      taskgraphId: id,
      type: 'taskgraph.node.failed',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'left' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
    })

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    // Recovery repaired left (intent + first cause) and cancelled the live
    // sibling, but the sibling's task run has not resolved yet, so convergence
    // awaits its terminal.
    assert.equal(restored.status({ taskgraph_id: id }).state, 'running')
    assert.deepEqual(bridge.cancelled, ['task_2'])

    // The reattached sibling then fails on its own — a later second failure.
    bridge.terminal('task_2', { status: 'failed', error: 'boom-right' })
    await settle(restored, id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    const failure = terminal.failure
    // Terminal evidence remains the first repaired cause/event.
    assert.equal(failure?.node_id, 'left')
    assert.equal(failure?.error.code, 'TASK_RUN_FAILED')
    assert.equal(failure?.error.message, 'boom-left')
    assert.equal(failure?.event_id, evidence.event_id)
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'right' }).run.state, 'interrupted')
    const eventTypes = restored.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(!eventTypes.includes('taskgraph.paused'))
    assert.ok(eventTypes.includes('taskgraph.cancelled'))
  })

  it('repairs the original failed-node cause before a secondary reattach failure can win the race', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: parallelTaskGraph() },
      on_node_failure: 'cancel',
    })
    const id = created.taskgraph.id
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'crash' } } })
    await first.whenIdle(id)
    assert.equal(first.status({ taskgraph_id: id }).node_counts.running, 2)

    // Crash artifact: left failed (node state + journal persisted) but the
    // cancel-policy cause/intent commit never landed; right is still running
    // but the daemon can no longer reattach it at restart.
    const now = new Date().toISOString()
    const store = new TaskGraphStore(db)
    store.putNodeState(id, 'left', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
      output: null,
      taskRunId: null,
    }, now)
    const evidence = store.appendJournal({
      taskgraphId: id,
      type: 'taskgraph.node.failed',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'left' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
    })
    bridge.forget('task_2')

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    restored.status({ taskgraph_id: id })
    await restored.whenIdle(id)

    const status = restored.status({ taskgraph_id: id })
    assert.equal(status.state, 'cancelled')
    const terminal = status.terminal
    if (terminal?.outcome !== 'cancelled') assert.fail('expected a cancelled terminal')
    // Recovery repaired the original cause first; the secondary reattach
    // failure could not replace it.
    assert.equal(terminal.failure?.node_id, 'left')
    assert.equal(terminal.failure?.error.code, 'TASK_RUN_FAILED')
    assert.equal(terminal.failure?.error.message, 'boom-left')
    assert.equal(terminal.failure?.event_id, evidence.event_id)
    // The sibling that failed to reattach recorded its own failure without
    // replacing the original cause, and remaining work was cancelled.
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'right' }).run.state, 'failed')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'right' }).run.error?.code, 'TASK_RUN_REATTACH_FAILED')
    assert.equal(restored.inspect({ taskgraph_id: id, node_id: 'end' }).run.state, 'cancelled')
    const eventTypes = restored.events({ taskgraph_id: id }).events.map((event) => event.type)
    assert.ok(!eventTypes.includes('taskgraph.paused'))
    assert.ok(eventTypes.includes('taskgraph.cancelled'))
  })

  it('normalizes, persists, and returns an immutable create title across reconstruction', async () => {
    const db = initTestDb()
    const bridge = new FakeTaskBridge()
    const first = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    const created = await first.create({
      graph: { nodes: linearTaskGraph() },
      title: '  deploy release v1.2.3  ',
    })
    const id = created.taskgraph.id
    assert.equal(created.taskgraph.title, 'deploy release v1.2.3')
    assert.equal(first.status({ taskgraph_id: id }).title, 'deploy release v1.2.3')

    // Graph state transitions leave the create-time title untouched.
    first.signal({ taskgraph_id: id, signal: { type: 'start_graph', input: { seed: 'go' } } })
    await first.whenIdle(id)
    bridge.terminal('task_1', { status: 'done', output: { status: 'ok' } })
    await settle(first, id)
    assert.equal(first.status({ taskgraph_id: id }).state, 'done')
    assert.equal(first.status({ taskgraph_id: id }).title, 'deploy release v1.2.3')

    const wait = await first.wait({ taskgraph_id: id, timeout_ms: 1_000 })
    assert.equal(wait.reason, 'done')
    assert.equal(wait.title, 'deploy release v1.2.3')

    const restored = new TaskGraphService({ db, workspaceRoot: process.cwd(), taskBridge: bridge })
    assert.equal(restored.status({ taskgraph_id: id }).title, 'deploy release v1.2.3')
    assert.equal(restored.list().runs[0].title, 'deploy release v1.2.3')
  })

  it('rejects a whitespace-only create title', async () => {
    const service = createService(new FakeTaskBridge())
    await assert.rejects(
      service.create({ graph: { nodes: linearTaskGraph() }, title: '   ' }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_TITLE')
        return true
      },
    )
  })

  it('rejects a multiline create title', async () => {
    const service = createService(new FakeTaskBridge())
    await assert.rejects(
      service.create({ graph: { nodes: linearTaskGraph() }, title: 'line one\nline two' }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_TITLE')
        return true
      },
    )
  })

  it('rejects a create title whose normalized length exceeds 120 code units', async () => {
    const service = createService(new FakeTaskBridge())
    await assert.rejects(
      service.create({ graph: { nodes: linearTaskGraph() }, title: `${'x'.repeat(120)} y` }),
      (error: unknown) => {
        assert(error instanceof TaskGraphServiceError)
        assert.equal(error.code, 'INVALID_TITLE')
        return true
      },
    )
  })

  it('accepts a create title at exactly the 120 code unit limit', async () => {
    const service = createService(new FakeTaskBridge())
    const created = await service.create({
      graph: { nodes: linearTaskGraph() },
      title: 'x'.repeat(120),
    })
    assert.equal(created.taskgraph.title, 'x'.repeat(120))
    assert.equal(service.status({ taskgraph_id: created.taskgraph.id }).title, 'x'.repeat(120))
  })
})

function createService(bridge: FakeTaskBridge): TaskGraphService {
  return new TaskGraphService({
    db: initTestDb(),
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

function startNode(schema: TaskGraphNode['output_schema']): TaskGraphNode {
  return {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: objectSchema({}, []),
    output_schema: schema,
  }
}

function taskNode(
  id = 'work',
  output = objectSchema({ status: { type: 'string' } }),
): TaskGraphNode {
  return {
    id,
    name: id,
    action: {
      type: 'task',
      params: {
        name: 'fake-task',
        project: 'foreman',
        input: { seed: '$inputs.seed' },
      },
    },
    deps: ['start'],
    input: [{ name: 'seed', source: 'start.seed' }],
    input_schema: objectSchema({ seed: { type: 'string' } }),
    output_schema: output,
  }
}

function linearTaskGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({ seed: { type: 'string' } })),
    work: taskNode(),
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['work'],
      input: [{ name: 'status', source: 'work.status' }],
      input_schema: objectSchema({ status: { type: 'string' } }),
      output_schema: objectSchema({ status: { type: 'string' } }),
    },
  }
}

function literalArrayTaskGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({}, [])),
    verify: {
      id: 'verify',
      name: 'verify',
      action: {
        type: 'task',
        params: {
          name: 'test',
          project: 'foreman',
          input: [{ id: 'check', then: 'passes' }],
        },
      },
      deps: ['start'],
      input: [],
      input_schema: objectSchema({ unused: { type: 'string' } }, []),
      output_schema: objectSchema({ result: { type: 'string' } }),
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['verify'],
      input: [],
      input_schema: objectSchema({}, []),
      output_schema: objectSchema({}, []),
    },
  }
}

function conditionGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({ status: { type: 'string' } })),
    choose: {
      id: 'choose',
      name: 'choose',
      action: {
        type: 'condition',
        params: {
          cases: [{
            when: { path: '$.status', op: 'eq', value: 'ok' },
            branch: 'success',
          }],
          default: 'fallback',
        },
      },
      deps: ['start'],
      input: [{ name: 'status', source: 'start.status' }],
      input_schema: objectSchema({ status: { type: 'string' } }),
      output_schema: objectSchema({ branch: { type: 'string' } }),
    },
    success: {
      id: 'success',
      name: 'success',
      action: { type: 'end', params: {} },
      deps: ['choose'],
      input: [{ name: 'branch', source: 'choose.branch' }],
      input_schema: objectSchema({ branch: { type: 'string' } }),
      output_schema: objectSchema({ branch: { type: 'string' } }),
    },
    fallback: {
      id: 'fallback',
      name: 'fallback',
      action: { type: 'end', params: {} },
      deps: ['choose'],
      input: [{ name: 'branch', source: 'choose.branch' }],
      input_schema: objectSchema({ branch: { type: 'string' } }),
      output_schema: objectSchema({ branch: { type: 'string' } }),
    },
  }
}

function parallelTaskGraph(): Record<string, TaskGraphNode> {
  const left = taskNode('left', objectSchema({ left: { type: 'string' } }))
  left.action.params.input = { seed: '$inputs.seed' }
  const right = taskNode('right', objectSchema({ right: { type: 'string' } }))
  right.action.params.input = { seed: '$inputs.seed' }
  return {
    start: startNode(objectSchema({ seed: { type: 'string' } })),
    left,
    right,
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['left', 'right'],
      input: [
        { name: 'left', source: 'left.left' },
        { name: 'right', source: 'right.right' },
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

function checkpointGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({ seed: { type: 'string' } })),
    approval: {
      id: 'approval',
      name: 'approval',
      action: { type: 'checkpoint', params: {} },
      deps: ['start'],
      input: [{ name: 'seed', source: 'start.seed' }],
      input_schema: objectSchema({ seed: { type: 'string' } }),
      output_schema: objectSchema({ decision: { type: 'string' } }),
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['approval'],
      input: [{ name: 'decision', source: 'approval.decision' }],
      input_schema: objectSchema({ decision: { type: 'string' } }),
      output_schema: objectSchema({ decision: { type: 'string' } }),
    },
  }
}

/**
 * Task graph whose work node does not hand-copy a full output schema: the
 * empty object root is auto-resolved from the current task definition contract
 * during graph creation.
 */
function contractSchemaTaskGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({ seed: { type: 'string' } })),
    work: {
      id: 'work',
      name: 'work',
      action: {
        type: 'task',
        params: { name: 'contract-task', project: 'foreman', input: { val: '$inputs.seed' } },
      },
      deps: ['start'],
      input: [{ name: 'seed', source: 'start.seed' }],
      input_schema: objectSchema({ seed: { type: 'string' } }),
      output_schema: objectSchema({}, []),
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['work'],
      input: [{ name: 'status', source: 'work.result' }],
      input_schema: objectSchema({ status: { type: 'string' } }),
      output_schema: objectSchema({ status: { type: 'string' } }),
    },
  }
}

function arrayContractTaskGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({})),
    work: {
      id: 'work',
      name: 'work',
      action: {
        type: 'task',
        params: { name: 'array-task', project: 'foreman', input: { changes: [] } },
      },
      deps: ['start'],
      input: [],
      input_schema: objectSchema({}, []),
      output_schema: objectSchema({}, []),
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['work'],
      input: [{ name: 'evidences', source: 'work.result' }],
      input_schema: objectSchema({
        evidences: { type: 'array', items: { type: 'string' } },
      }),
      output_schema: objectSchema({
        evidences: { type: 'array', items: { type: 'string' } },
      }),
    },
  }
}

/**
 * Task graph whose work node omits an output schema and relies on a task
 * contract whose schemas carry a Draft-07 tuple-form `items` array.
 */
function tupleContractTaskGraph(): Record<string, TaskGraphNode> {
  return {
    start: startNode(objectSchema({ seed: { type: 'string' } })),
    work: {
      id: 'work',
      name: 'work',
      action: {
        type: 'task',
        params: { name: 'tuple-task', project: 'foreman', input: { val: '$inputs.seed' } },
      },
      deps: ['start'],
      input: [{ name: 'seed', source: 'start.seed' }],
      input_schema: objectSchema({ seed: { type: 'string' } }),
      output_schema: objectSchema({}, []),
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['work'],
      input: [],
      input_schema: objectSchema({}, []),
      output_schema: objectSchema({}, []),
    },
  }
}
