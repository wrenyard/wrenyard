// @ts-nocheck
/**
 * taskgraph-run.test.mts — behavior tests for the compact literal task-graph
 * compiler and the `foreman taskgraph run` CLI orchestration.
 *
 * The compact surface is proven as a compiler/orchestration adapter over the
 * existing taskgraph methods — there is no alternative runner here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compileCompactTaskGraph,
  CompactTaskGraphError,
  validateTaskGraphPostImage,
  type TaskGraphAutoSchemaResolver,
} from '../../lib/core/taskgraph/index.mts'
import {
  runCompactTaskGraph,
  type CompactTaskGraphRunClient,
} from '../../lib/client/cli/commands/taskgraph.mts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const nodeCounts = {
  planned: 0,
  running: 0,
  waiting: 0,
  done: 2,
  failed: 0,
  interrupted: 0,
  cancelled: 0,
}

const doneWait = {
  taskgraph_id: 'tg-1',
  state: 'done',
  reason: 'done',
  structure_revision: 1,
  latest_seq: 4,
  node_counts: nodeCounts,
  active: { running: [], waiting: [] },
  terminal: { outcome: 'done' },
}

const cancelledWait = {
  taskgraph_id: 'tg-1',
  state: 'cancelled',
  reason: 'cancelled',
  structure_revision: 1,
  latest_seq: 6,
  node_counts: { ...nodeCounts, done: 1, failed: 1, cancelled: 1 },
  active: { running: [], waiting: [] },
  terminal: {
    outcome: 'cancelled',
    failure: { kind: 'node_failed', node_id: 'b', error: { code: 'NODE_FAILED', message: 'boom' } },
  },
}

function inspectResult(state, extra = {}) {
  return {
    structure_revision: 1,
    node: { id: 'n', name: 'n', action: { type: 'task', params: {} }, deps: [], input: [], input_schema: { type: 'object' }, output_schema: { type: 'object' } },
    run: { state, ...extra.run },
    ...(extra.output !== undefined ? { output: extra.output } : {}),
  }
}

function makeFakeClient(overrides = {}) {
  const calls = []
  const waitParams = []
  const signalCalls = []
  const client = {
    taskgraph: {
      create: async () => {
        calls.push('create')
        return { taskgraph: { id: 'tg-1', revision: 1, status: 'created', created_at: 'now' } }
      },
      patch: async (params) => {
        calls.push(params.operation.type === 'request_patch' ? 'patch:request' : 'patch:confirm')
        if (params.operation.type === 'request_patch') {
          return { type: 'preview', patch_id: 'p-1' }
        }
        return { type: 'applied', revision: 2 }
      },
      signal: async (params) => {
        calls.push('signal')
        signalCalls.push(params)
        return { accepted: true }
      },
      wait: async (params) => {
        calls.push('wait')
        waitParams.push(params)
        return doneWait
      },
      node: {
        inspect: async (params) => {
          calls.push(`inspect:${params.node_id}`)
          return inspectResult('done', { run: { task_run_id: `tr-${params.node_id}` }, output: { ok: true } })
        },
      },
    },
    ...overrides,
  }
  return { client, calls, waitParams, signalCalls }
}

function stubPatch() {
  return async (params) => params.operation.type === 'request_patch'
    ? { type: 'preview', patch_id: 'p-1' }
    : { type: 'applied', revision: 2 }
}

// ─── Pure compiler ────────────────────────────────────────────────────────────

describe('compact task graph compiler', () => {
  it('compiles one step into start/task/end with cancel policy and leaf return', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      tg_ctx: { decision: 'keep API', targets: ['src/a.ts'] },
      title: 'one',
      steps: [{ id: 'build', task: 'test', name: 'Build', input: { focus: 'x' } }],
    })
    assert.equal(compiled.create.on_node_failure, 'cancel')
    assert.equal(compiled.create.project, 'app')
    assert.deepEqual(compiled.create.tg_ctx, { decision: 'keep API', targets: ['src/a.ts'] })
    assert.equal(compiled.create.title, 'one')
    assert.deepEqual(compiled.return_nodes, ['build'])
    assert.deepEqual(Object.keys(compiled.create.graph.nodes), ['start', 'build', 'end'])

    const start = compiled.create.graph.nodes.start
    assert.equal(start.action.type, 'start')
    assert.deepEqual(start.deps, [])

    const task = compiled.create.graph.nodes.build
    assert.equal(task.action.type, 'task')
    assert.deepEqual(task.action.params, { name: 'test', project: 'app', input: { focus: 'x' } })
    assert.deepEqual(task.deps, ['start'])
    assert.deepEqual(task.input, [])

    const end = compiled.create.graph.nodes.end
    assert.equal(end.action.type, 'end')
    assert.deepEqual(end.deps, ['build'])
  })

  it('wires parallel leaves and explicit deps without injecting start for dependent steps', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', deps: ['a'] },
        { id: 'c', task: 'lint', deps: ['a'] },
      ],
    })
    assert.deepEqual(compiled.create.graph.nodes.a.deps, ['start'])
    assert.deepEqual(compiled.create.graph.nodes.b.deps, ['a'])
    assert.deepEqual(compiled.create.graph.nodes.c.deps, ['a'])
    assert.deepEqual(compiled.create.graph.nodes.end.deps, ['b', 'c'])
    assert.deepEqual(compiled.return_nodes, ['b', 'c'])
  })

  it('defaults failure policy to cancel and return_nodes to leaves', () => {
    const compiled = compileCompactTaskGraph({ project: 'app', steps: [{ id: 's1', task: 'edit' }] })
    assert.equal(compiled.create.on_node_failure, 'cancel')
    assert.equal(compiled.create.project, 'app')
    assert.equal(compiled.timeout_ms, undefined)
    assert.deepEqual(compiled.return_nodes, ['s1'])
  })

  it('preserves explicit return_nodes order and passes timeout_ms through', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      timeout_ms: 5000,
      return_nodes: ['c', 'a'],
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', deps: ['a'] },
        { id: 'c', task: 'lint', deps: ['b'] },
      ],
    })
    assert.equal(compiled.timeout_ms, 5000)
    assert.deepEqual(compiled.return_nodes, ['c', 'a'])
  })

  it('uses step project and task name literals, defaulting project from the top level', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', project: 'other' },
      ],
    })
    assert.deepEqual(compiled.create.graph.nodes.a.action.params, { name: 'edit', project: 'app' })
    assert.deepEqual(compiled.create.graph.nodes.b.action.params, { name: 'test', project: 'other' })
  })

  it('rejects compact input mistakes with stable concise errors', () => {
    const cases = [
      [null, 'INVALID_INPUT', /must be a JSON object/],
      [[], 'INVALID_INPUT', /must be a JSON object/],
      [{}, 'STEPS_REQUIRED', /non-empty array/],
      [{ steps: [] }, 'STEPS_REQUIRED', /non-empty array/],
      [{ steps: [{ id: 'a', task: 'edit' }] }, 'PROJECT_REQUIRED', /project must be a non-empty string/],
      [{ project: '', steps: [{ id: 'a', task: 'edit' }] }, 'PROJECT_REQUIRED', /project must be a non-empty string/],
      [{ project: '   ', steps: [{ id: 'a', task: 'edit' }] }, 'PROJECT_REQUIRED', /project must be a non-empty string/],
      [{ project: 'app', steps: [{}] }, 'STEP_INVALID', /step id must be a non-empty string/],
      [{ project: 'app', steps: [{ id: 'a' }] }, 'STEP_INVALID', /task must be a non-empty string/],
      [{ project: 'app', steps: [{ id: 'start', task: 'edit' }] }, 'RESERVED_STEP_ID', /"start" is reserved/],
      [{ project: 'app', steps: [{ id: 'end', task: 'edit' }] }, 'RESERVED_STEP_ID', /"end" is reserved/],
      [
        { project: 'app', steps: [{ id: 'a', task: 'edit' }, { id: 'a', task: 'test' }] },
        'DUPLICATE_STEP_ID',
        /duplicate step id "a"/,
      ],
      [{ project: 'app', steps: [{ id: 'a', task: 'edit', deps: ['a'] }] }, 'SELF_DEP', /cannot depend on itself/],
      [{ project: 'app', steps: [{ id: 'a', task: 'edit', deps: ['missing'] }] }, 'UNKNOWN_DEP', /unknown step "missing"/],
      [{ project: 'app', steps: [{ id: 'a', task: 'edit', deps: 'nope' }] }, 'DEPS_INVALID', /deps must be an array of step ids/],
      [
        { project: 'app', steps: [{ id: 'a', task: 'edit' }], return_nodes: ['missing'] },
        'UNKNOWN_RETURN_NODE',
        /"missing" is not a declared step/,
      ],
      [
        { project: 'app', steps: [{ id: 'a', task: 'edit' }], return_nodes: 'nope' },
        'RETURN_NODES_INVALID',
        /return_nodes must be an array of declared step ids/,
      ],
    ]
    for (const [input, code, message] of cases) {
      assert.throws(() => compileCompactTaskGraph(input), (error) => {
        assert.ok(error instanceof CompactTaskGraphError, `expected CompactTaskGraphError for ${code}`)
        assert.equal(error.code, code)
        assert.match(error.message, message)
        return true
      })
    }
  })

  it('compiled create always carries the top-level project and preserves prototype-like step ids as own enumerable node keys', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      steps: [{ id: '__proto__', task: 'edit' }],
      return_nodes: ['__proto__'],
    })
    assert.equal(compiled.create.project, 'app')
    assert.equal(Object.hasOwn(compiled.create.graph.nodes, '__proto__'), true)
    assert.deepEqual(Object.keys(compiled.create.graph.nodes), ['start', '__proto__', 'end'])
    const serialized = JSON.stringify(compiled.create.graph.nodes)
    assert.ok(serialized.includes('"__proto__"'))
    assert.equal(JSON.parse(serialized).__proto__.action.type, 'task')
  })

  it('performs a mutation-free preflight on the input object', () => {
    const input = {
      project: 'app',
      steps: [
        { id: 'a', task: 'edit', input: { changes: [] } },
        { id: 'b', task: 'test', deps: ['a'] },
      ],
      return_nodes: ['a', 'b'],
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    compileCompactTaskGraph(input)
    assert.deepEqual(input, snapshot)
  })

  it('emits a full graph accepted by current validation and materialization', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      steps: [
        { id: 'a', task: 'edit', input: { changes: [] } },
        { id: 'b', task: 'test', deps: ['a'], input: {} },
      ],
    })
    const graph = { id: 'g-compiled', revision: 1, nodes: compiled.create.graph.nodes }
    const ops = Object.values(graph.nodes).map((node) => ({ op: 'AddNode', node }))
    const resolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: {} },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema: () => null,
      resolveLlmStructuredOpts: () => null,
    }
    // Project-dependent task contract resolution (B7): the validator consults
    // the contract resolver under each node's action.params.project scope.
    const contractCalls = []
    const contractResolver = {
      resolveDefinitionContract(kind, name, project) {
        contractCalls.push({ kind, name, project })
        if (kind === 'task' && project === 'app') {
          return {
            definitionId: name,
            kind: 'task',
            project: 'app',
            input: { type: 'object', properties: {}, required: [] },
          }
        }
        return null
      },
    }
    const result = validateTaskGraphPostImage({ id: 'g', revision: 0, nodes: {} }, ops, undefined, resolver, contractResolver, 'app')
    assert.equal(result.issues.length, 0, JSON.stringify(result.issues))
    assert.ok(result.graph)
    assert.equal(result.graph.nodes.a.action.params.name, 'edit')
    assert.deepEqual(contractCalls, [
      { kind: 'task', name: 'edit', project: 'app' },
      { kind: 'task', name: 'test', project: 'app' },
    ])
  })

  it('materialization resolves task contracts under the per-node project scope', () => {
    const compiled = compileCompactTaskGraph({
      project: 'app',
      steps: [{ id: 'a', task: 'edit', project: 'other', input: { changes: [] } }],
    })
    const graph = { id: 'g-scoped', revision: 1, nodes: compiled.create.graph.nodes }
    const ops = Object.values(graph.nodes).map((node) => ({ op: 'AddNode', node }))
    const resolver = {
      resolveActionSchema(type) {
        return type === 'task'
          ? { input: { type: 'object', properties: {} }, output: { type: 'object', properties: {} } }
          : null
      },
      resolveLlmInputSchema: () => null,
      resolveLlmStructuredOpts: () => null,
    }
    const contractResolver = {
      resolveDefinitionContract(kind, name, project) {
        return kind === 'task' && name === 'edit' && project === 'app'
          ? { definitionId: 'edit', kind: 'task', project: 'app', input: { type: 'object', properties: {} } }
          : null
      },
    }
    // Node "a" overrides project to "other", which the contract registry does
    // not know — validation must reject the payload under that project scope.
    const result = validateTaskGraphPostImage({ id: 'g', revision: 0, nodes: {} }, ops, undefined, resolver, contractResolver, 'app')
    assert.ok(
      result.issues.some((issue) => /definition "edit" not found for project "other"/.test(issue.message)),
      JSON.stringify(result.issues),
    )
  })
})

// ─── CLI run orchestration (fake ForemanClient) ───────────────────────────────

describe('foreman taskgraph run orchestration', () => {
  it('calls create, patch, signal, wait, then node-inspect in exact order', async () => {
    const { client, calls } = makeFakeClient()
    const envelope = await runCompactTaskGraph(client, JSON.stringify({
      project: 'app',
      timeout_ms: 1000,
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', deps: ['a'] },
      ],
      return_nodes: ['a', 'b'],
    }))
    assert.deepEqual(calls, ['create', 'patch:request', 'patch:confirm', 'signal', 'wait', 'inspect:a', 'inspect:b'])
    assert.deepEqual(Object.keys(envelope.results), ['a', 'b'])
  })

  it('signals start_graph with {} and passes timeout_ms to wait', async () => {
    const { client, calls, waitParams, signalCalls } = makeFakeClient()
    await runCompactTaskGraph(client, JSON.stringify({
      project: 'app',
      timeout_ms: 1234,
      steps: [{ id: 'a', task: 'edit' }],
    }))
    assert.equal(calls[3], 'signal')
    assert.equal(signalCalls.length, 1)
    assert.deepEqual(signalCalls[0].signal, { type: 'start_graph', input: {} })
    assert.equal(waitParams[0].timeout_ms, 1234)
  })

  it('omits timeout_ms from wait when not requested', async () => {
    const { client, waitParams } = makeFakeClient()
    await runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'a', task: 'edit' }] }))
    assert.equal(Object.hasOwn(waitParams[0], 'timeout_ms'), false)
  })

  it('projects done wait envelope fields plus default leaf-only results', async () => {
    const { client, calls } = makeFakeClient()
    const envelope = await runCompactTaskGraph(client, JSON.stringify({
      project: 'app',
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', deps: ['a'] },
      ],
    }))
    assert.equal(envelope.state, 'done')
    assert.equal(envelope.reason, 'done')
    assert.equal(envelope.taskgraph_id, 'tg-1')
    assert.deepEqual(calls, ['create', 'patch:request', 'patch:confirm', 'signal', 'wait', 'inspect:b'])
    assert.deepEqual(Object.keys(envelope.results), ['b'])
    assert.deepEqual(envelope.results.b, { state: 'done', task_run_id: 'tr-b', output: { ok: true } })
    assert.equal(envelope.results.a, undefined)
  })

  it('projects cancelled wait envelope with default leaf-only node result facts', async () => {
    const inspected: string[] = []
    const client = {
      taskgraph: {
        create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
        patch: async (params) => params.operation.type === 'request_patch'
          ? { type: 'preview', patch_id: 'p-1' }
          : { type: 'applied', revision: 2 },
        signal: async () => ({ accepted: true }),
        wait: async () => cancelledWait,
        node: {
          inspect: async (params) => {
            inspected.push(params.node_id)
            return params.node_id === 'a'
              ? inspectResult('done', { run: { task_run_id: 'tr-a' }, output: { ok: true } })
              : inspectResult('failed', { run: { error: { code: 'NODE_FAILED', message: 'boom' } } })
          },
        },
      },
    }
    const envelope = await runCompactTaskGraph(client, JSON.stringify({
      project: 'app',
      steps: [
        { id: 'a', task: 'edit' },
        { id: 'b', task: 'test', deps: ['a'] },
      ],
    }))
    assert.equal(envelope.state, 'cancelled')
    assert.equal(envelope.reason, 'cancelled')
    assert.deepEqual(inspected, ['b'])
    assert.deepEqual(Object.keys(envelope.results), ['b'])
    assert.deepEqual(envelope.results.b, { state: 'failed', error: { code: 'NODE_FAILED', message: 'boom' } })
    assert.equal(envelope.results.a, undefined)
  })

  it('rejects compact input mistakes before any client call', async () => {
    let calls = 0
    const client = {
      taskgraph: {
        create: async () => { calls += 1; return { taskgraph: { id: 'tg-1', revision: 1 } } },
        signal: async () => { calls += 1; return { accepted: true } },
        wait: async () => { calls += 1; return doneWait },
        node: { inspect: async () => { calls += 1; return inspectResult('done') } },
      },
    }
    await assert.rejects(
      () => runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'start', task: 'edit' }] })),
      (error) => error instanceof CompactTaskGraphError && error.code === 'RESERVED_STEP_ID',
    )
    assert.equal(calls, 0)
  })

  it('rejects malformed JSON before any client call', async () => {
    let calls = 0
    const client = {
      taskgraph: {
        create: async () => { calls += 1; return { taskgraph: { id: 'tg-1', revision: 1 } } },
        signal: async () => { calls += 1; return { accepted: true } },
        wait: async () => { calls += 1; return doneWait },
        node: { inspect: async () => { calls += 1; return inspectResult('done') } },
      },
    }
    await assert.rejects(
      () => runCompactTaskGraph(client, '{ not json'),
      (error) => error instanceof Error && /Invalid <json-params>/.test(error.message),
    )
    assert.equal(calls, 0)
  })

  it('propagates create errors unchanged', async () => {
    const boom = new Error('create boom')
    const client = {
      taskgraph: {
        create: async () => { throw boom },
        patch: stubPatch(),
        signal: async () => ({ accepted: true }),
        wait: async () => doneWait,
        node: { inspect: async () => inspectResult('done') },
      },
    }
    await assert.rejects(() => runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'a', task: 'edit' }] })), boom)
  })

  it('propagates wait errors unchanged', async () => {
    const boom = new Error('wait boom')
    const client = {
      taskgraph: {
        create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
        patch: stubPatch(),
        signal: async () => ({ accepted: true }),
        wait: async () => { throw boom },
        node: { inspect: async () => inspectResult('done') },
      },
    }
    await assert.rejects(() => runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'a', task: 'edit' }] })), boom)
  })

  it('propagates node-inspect errors unchanged', async () => {
    const boom = new Error('inspect boom')
    const client = {
      taskgraph: {
        create: async () => ({ taskgraph: { id: 'tg-1', revision: 1 } }),
        patch: stubPatch(),
        signal: async () => ({ accepted: true }),
        wait: async () => doneWait,
        node: { inspect: async () => { throw boom } },
      },
    }
    await assert.rejects(() => runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'a', task: 'edit' }] })), boom)
  })

  it('inspects exactly the default leaf node for a single-step graph', async () => {
    const { client, calls } = makeFakeClient()
    await runCompactTaskGraph(client, JSON.stringify({ project: 'app', steps: [{ id: 'a', task: 'edit' }] }))
    assert.deepEqual(calls, ['create', 'patch:request', 'patch:confirm', 'signal', 'wait', 'inspect:a'])
  })

  it('rejects missing or blank project before any client call', async () => {
    const paramsList = [
      JSON.stringify({ steps: [{ id: 'a', task: 'edit' }] }),
      JSON.stringify({ project: '', steps: [{ id: 'a', task: 'edit' }] }),
      JSON.stringify({ project: '   ', steps: [{ id: 'a', task: 'edit' }] }),
    ]
    for (const params of paramsList) {
      let calls = 0
      const client = {
        taskgraph: {
          create: async () => { calls += 1; return { taskgraph: { id: 'tg-1', revision: 1 } } },
          signal: async () => { calls += 1; return { accepted: true } },
          wait: async () => { calls += 1; return doneWait },
          node: { inspect: async () => { calls += 1; return inspectResult('done') } },
        },
      }
      await assert.rejects(
        () => runCompactTaskGraph(client, params),
        (error) => error instanceof CompactTaskGraphError && error.code === 'PROJECT_REQUIRED',
      )
      assert.equal(calls, 0)
    }
  })

  it('emits a prototype-like step id as an own enumerable result key that survives JSON', async () => {
    const { client, calls } = makeFakeClient()
    const envelope = await runCompactTaskGraph(client, JSON.stringify({
      project: 'app',
      steps: [{ id: '__proto__', task: 'edit' }],
      return_nodes: ['__proto__'],
    }))
    assert.deepEqual(calls, ['create', 'patch:request', 'patch:confirm', 'signal', 'wait', 'inspect:__proto__'])
    assert.equal(Object.hasOwn(envelope.results, '__proto__'), true)
    assert.equal(envelope.results.__proto__.state, 'done')
    assert.ok(JSON.stringify(envelope).includes('"__proto__"'))
  })
})
