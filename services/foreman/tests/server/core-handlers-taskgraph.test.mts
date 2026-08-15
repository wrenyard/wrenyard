import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { INVALID_PARAMS } from '../../lib/protocol/errors.mts'
import { registerCoreHandlers } from '../../lib/server/handlers/core.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'
import { taskgraphProtocolCases } from '../taskgraph/protocol-shell-fixtures.mts'
import { ensureDiscovered } from '../../lib/workspace/definition-registry.mts'

let router: RpcRouter

beforeEach(async () => {
  initTestDb()
  await ensureDiscovered(process.cwd())
  router = new RpcRouter()
  registerCoreHandlers(router, {
    startedAt: Date.now(),
    workspaceRoot: process.cwd(),
  })
})

afterEach(() => {
  closeTestDb()
})

describe('core RPC TaskGraph handlers', () => {
  it('drives the persisted kernel through all seven protocol methods', async () => {
    const created = await call('taskgraph.create', taskgraphProtocolCases[0].legalParams) as {
      taskgraph: { id: string; revision: number; status: string }
    }
    const id = created.taskgraph.id
    assert.equal(created.taskgraph.status, 'created')
    assert.equal(created.taskgraph.revision, 1)

    const status = await call('taskgraph.status', { taskgraph_id: id }) as {
      state: string
      structure_revision: number
    }
    assert.equal(status.state, 'created')
    assert.equal(status.structure_revision, 1)

    const inspected = await call('taskgraph.node.inspect', {
      taskgraph_id: id,
      node_id: 'start',
    }) as { run: { state: string } }
    assert.equal(inspected.run.state, 'planned')

    const graphInspect = await call('taskgraph.inspect', {
      taskgraph_id: id,
    }) as { graph: { id: string; revision: number; nodes: Record<string, unknown> } }
    assert.equal(graphInspect.graph.id, id)
    assert.equal(graphInspect.graph.revision, 1)
    assert.ok(graphInspect.graph.nodes)
    assert.ok(graphInspect.graph.nodes['start'])

    const preview = await call('taskgraph.patch', {
      taskgraph_id: id,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'test',
          reason: 'no-op patch',
          created_at: new Date().toISOString(),
          ops: [],
        },
      },
    }) as { type: string; patch_id: string }
    assert.equal(preview.type, 'preview')

    const applied = await call('taskgraph.patch', {
      taskgraph_id: id,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    })
    assert.deepEqual(applied, { type: 'applied', revision: 2 })

    const accepted = await call('taskgraph.signal', {
      taskgraph_id: id,
      signal: { type: 'start_graph', input: {} },
    })
    assert.deepEqual(accepted, { accepted: true })

    const events = await call('taskgraph.events', {
      taskgraph_id: id,
      after_seq: 0,
      limit: 100,
    }) as { events: Array<{ type: string }>; latest_seq: number }
    assert.ok(events.latest_seq >= 2)
    assert.ok(events.events.some((event) => event.type === 'taskgraph.created'))
  })

  it('accepts on_node_failure at create and returns structured cancelled failure evidence', async () => {
    const created = await call('taskgraph.create', {
      template: 'default',
      on_node_failure: 'cancel',
    }) as { taskgraph: { id: string; revision: number; status: string } }
    const id = created.taskgraph.id
    assert.equal(created.taskgraph.status, 'created')
    await installCancelFailureFixture(id)

    await call('taskgraph.signal', {
      taskgraph_id: id,
      signal: { type: 'start_graph', input: {} },
    })

    const wait = await call('taskgraph.wait', {
      taskgraph_id: id,
      timeout_ms: 2_000,
    }) as {
      state: string
      reason: string
      on_node_failure?: string
      terminal?: { outcome: string; failure?: { kind: string; node_id: string; error: { code: string } } }
    }
    assert.equal(wait.state, 'cancelled')
    assert.equal(wait.reason, 'cancelled')
    assert.equal(wait.on_node_failure, 'cancel')
    assert.equal(wait.terminal?.outcome, 'cancelled')
    assert.equal(wait.terminal?.failure?.kind, 'node_failed')
    assert.equal(wait.terminal?.failure?.node_id, 'run')
    assert.equal(wait.terminal?.failure?.error.code, 'ACTION_NOT_IMPLEMENTED')

    const status = await call('taskgraph.status', { taskgraph_id: id }) as {
      state: string
      on_node_failure?: string
      terminal?: { outcome: string; failure?: { node_id: string; error: { code: string } } }
    }
    assert.equal(status.state, 'cancelled')
    assert.equal(status.on_node_failure, 'cancel')
    assert.equal(status.terminal?.failure?.node_id, 'run')

    const list = await call('taskgraph.list', {}) as {
      runs: Array<{
        taskgraph_id: string
        state: string
        on_node_failure?: string
        failure?: { kind: string; node_id: string }
      }>
    }
    const run = list.runs.find((entry) => entry.taskgraph_id === id)
    assert.ok(run)
    assert.equal(run.state, 'cancelled')
    assert.equal(run.on_node_failure, 'cancel')
    assert.equal(run.failure?.kind, 'node_failed')
    assert.equal(run.failure?.node_id, 'run')
  })

  it('carries a trimmed create title through the RPC router to create/status/list', async () => {
    const created = await call('taskgraph.create', {
      template: 'default',
      title: '  deploy release v1.2.3  ',
    }) as { taskgraph: { id: string; title?: string } }
    const id = created.taskgraph.id
    assert.equal(created.taskgraph.title, 'deploy release v1.2.3')

    const status = await call('taskgraph.status', { taskgraph_id: id }) as {
      state: string
      title?: string
    }
    assert.equal(status.state, 'created')
    assert.equal(status.title, 'deploy release v1.2.3')

    const list = await call('taskgraph.list', {}) as {
      runs: Array<{ taskgraph_id: string; title?: string }>
    }
    const run = list.runs.find((entry) => entry.taskgraph_id === id)
    assert.ok(run)
    assert.equal(run.title, 'deploy release v1.2.3')
  })

  it('rejects an unknown on_node_failure policy at create', async () => {
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'taskgraph.create',
      params: {
        template: 'default',
        on_node_failure: 'failed',
      },
      id: 'test-create-invalid-policy',
    })
    const error = (response as {
      error?: { code: number; message: string }
    }).error
    assert.ok(error)
    assert.equal(error.code, INVALID_PARAMS.code)
  })

  it('creates parallel-explore when project is supplied', async () => {
    const created = await call('taskgraph.create', {
      template: 'parallel-explore',
      project: 'test-project',
      title: '三路探索',
    }) as { taskgraph: { id: string; status: string; title?: string } }
    assert.equal(created.taskgraph.status, 'created')
    assert.equal(created.taskgraph.title, '三路探索')
    const inspected = await call('taskgraph.inspect', {
      taskgraph_id: created.taskgraph.id,
    }) as { graph: { nodes: Record<string, { action?: { params?: { name?: string } } }> } }
    assert.ok(inspected.graph.nodes['explore-1'])
    assert.ok(inspected.graph.nodes['explore-2'])
    assert.ok(inspected.graph.nodes['explore-3'])
    assert.equal(inspected.graph.nodes['explore-1'].action?.params?.name, 'explore')
  })

  it('rejects task-bearing templates without project', async () => {
    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'taskgraph.create',
      params: { template: 'parallel-explore' },
      id: 'test-create-missing-project',
    })
    const error = (response as {
      error?: { code: number; message: string; data?: { code?: string } }
    }).error
    assert.ok(error)
    assert.equal(error.code, INVALID_PARAMS.code)
    assert.match(error.message, /project is required/)
  })

  it('creates closeout with a deploy placeholder', async () => {
    const created = await call('taskgraph.create', {
      template: 'closeout',
      project: 'test-project',
    }) as { taskgraph: { id: string; status: string } }
    assert.equal(created.taskgraph.status, 'created')
    const inspected = await call('taskgraph.inspect', {
      taskgraph_id: created.taskgraph.id,
    }) as { graph: { nodes: Record<string, { action?: { params?: { name?: string } } }> } }
    assert.equal(inspected.graph.nodes.deploy?.action?.params?.name, 'deploy')
  })

  for (const tc of taskgraphProtocolCases) {
    it(`returns INVALID_PARAMS for invalid ${tc.method} params`, async () => {
      const response = await router.handleMessage({
        jsonrpc: '2.0',
        method: tc.method,
        params: tc.invalidParams,
        id: `test-${tc.method}-invalid`,
      })

      const error = (response as {
        error?: { code: number; message: string; data?: Record<string, unknown> }
      }).error
      assert.ok(error, `expected error response for ${tc.method}`)
      assert.equal(error.code, INVALID_PARAMS.code)
      assert.equal(error.message, INVALID_PARAMS.message)
    })
  }
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

async function installCancelFailureFixture(taskgraphId: string): Promise<void> {
  const nodes = cancelFailureGraph()
  const preview = await call('taskgraph.patch', {
    taskgraph_id: taskgraphId,
    operation: {
      type: 'request_patch',
      patch: {
        base_revision: 1,
        actor: 'test',
        reason: 'install cancel-failure fixture',
        created_at: new Date().toISOString(),
        ops: [
          { op: 'AddNode', node: nodes.run },
          { op: 'ReplaceNode', node: nodes.end },
        ],
      },
    },
  }) as { type: string; patch_id: string }
  assert.equal(preview.type, 'preview')
  await call('taskgraph.patch', {
    taskgraph_id: taskgraphId,
    operation: { type: 'confirm_patch', patch_id: preview.patch_id },
  })
}

/**
 * Node map for a graph whose work node is a not-yet-implemented action:
 * creating and starting it always fails the node with ACTION_NOT_IMPLEMENTED,
 * which under the cancel policy must autonomously cancel the graph.
 */
function cancelFailureGraph(): Record<string, Record<string, unknown>> {
  return {
    start: {
      id: 'start',
      name: 'Start',
      action: { type: 'start', params: {} },
      deps: [],
      input: [],
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    },
    run: {
      id: 'run',
      name: 'run',
      action: { type: 'llm', params: {} },
      deps: ['start'],
      input: [],
      input_schema: { type: 'object', properties: { seed: { type: 'string' } }, required: [] },
      output_schema: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
    },
    end: {
      id: 'end',
      name: 'end',
      action: { type: 'end', params: {} },
      deps: ['run'],
      input: [],
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
      output_schema: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
    },
  }
}
