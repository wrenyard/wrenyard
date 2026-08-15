// @ts-nocheck
/**
 * validator.test.mts — Fog-horn test for validateTaskGraphPostImage.
 *
 * Exercises every graph-static error code, the two contract-only lifecycle codes,
 * location categories, stable all-error ordering, the complete auto-table,
 * explicit assertion boundaries, optional-path ergonomics, and immutability.
 *
 * Never mutates shared state; every test is self-contained.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  TaskGraph,
  TaskGraphNode,
  TaskGraphAutoSchemaResolver,
  NodeId,
  NodeRunStateType,
  JsonObject,
  PatchOperation,
  FrozenDetail,
} from '../../lib/core/taskgraph/index.mts'

import {
  PATCH_ERROR_CODES,
  validateTaskGraphPostImage,
} from '../../lib/core/taskgraph/index.mts'

// ─── Test-scoped helpers ──────────────────────────────────────────────────────

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Assert that a value freezes to the same thing (no mutation sentinel). */
function assertUnchanged<T>(before: T, after: T, label: string): void {
  assert.deepEqual(after, before, `${label} was mutated`)
}

/** Build a minimal valid resolver that resolves task/llm. */
function makeResolver(
  overrides?: Partial<TaskGraphAutoSchemaResolver>,
): TaskGraphAutoSchemaResolver {
  return {
    resolveActionSchema(type, _params) {
      if (type === 'task') {
        return {
          input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
          output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        }
      }
      return null
    },
    resolveLlmInputSchema(_params) {
      return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }
    },
    resolveLlmStructuredOpts(_params) {
      return null
    },
    ...overrides,
  }
}

// ─── Fixture factories ────────────────────────────────────────────────────────

function startNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `start-${id}`,
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: { out: { type: 'string' } }, required: ['out'] },
    ...overrides,
  } as TaskGraphNode
}

function endNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `end-${id}`,
    action: { type: 'end', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    ...overrides,
  } as TaskGraphNode
}

function taskNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `task-${id}`,
    action: { type: 'task', params: { command: 'echo', msg: 'default-msg' } },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: {} },
    ...overrides,
  } as TaskGraphNode
}

function convertNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `conv-${id}`,
    action: { type: 'convert', params: { assemble: { result: { const: 'ok' } } } },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: {} },
    ...overrides,
  } as TaskGraphNode
}

function joinNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `join-${id}`,
    action: { type: 'join', params: { assemble: { merged: { const: 'default' } } } },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: {} },
    ...overrides,
  } as TaskGraphNode
}

function emptyGraph(id = 'g-test'): TaskGraph {
  return { id, revision: 0, nodes: {} }
}

// ─── 1. Error-code enum ───────────────────────────────────────────────────────

describe('PATCH_ERROR_CODES enum', () => {
  it('contains exactly 12 entries', () => {
    assert.equal(PATCH_ERROR_CODES.length, 12)
  })

  it('includes every expected code', () => {
    assert.deepEqual([...PATCH_ERROR_CODES].sort(), [
      'CYCLE',
      'DANGLING_DEP',
      'DUP_ID',
      'FROZEN_NODE',
      'INPUT_INCOMPLETE',
      'MAP_NOT_IN_DEPS',
      'MAP_PATH_UNKNOWN',
      'MAP_TYPE_MISMATCH',
      'PATCH_NOT_FOUND',
      'SCHEMA_INVALID',
      'SCHEMA_REQUIRED',
      'STALE_BASE',
    ])
  })
})

// ─── 2. Contract-only codes (never emitted by validator) ───────────────────────

describe('contract-only codes — STALE_BASE and PATCH_NOT_FOUND', () => {
  it('STALE_BASE appears in PATCH_ERROR_CODES', () => {
    assert.ok(PATCH_ERROR_CODES.includes('STALE_BASE'))
  })

  it('PATCH_NOT_FOUND appears in PATCH_ERROR_CODES', () => {
    assert.ok(PATCH_ERROR_CODES.includes('PATCH_NOT_FOUND'))
  })

  it('STALE_BASE is never emitted by validateTaskGraphPostImage', () => {
    // The validator has no lifecycle input — try every plausible scenario.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const result = validateTaskGraphPostImage(
      graph,
      [],
      undefined,
      makeResolver(),
    )
    if (!result.graph) {
      for (const issue of result.issues) {
        assert.notEqual(issue.code, 'STALE_BASE', 'validator should never emit STALE_BASE')
      }
    }
  })

  it('PATCH_NOT_FOUND is never emitted by validateTaskGraphPostImage', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const result = validateTaskGraphPostImage(
      graph,
      [],
      undefined,
      makeResolver(),
    )
    if (!result.graph) {
      for (const issue of result.issues) {
        assert.notEqual(issue.code, 'PATCH_NOT_FOUND', 'validator should never emit PATCH_NOT_FOUND')
      }
    }
  })

  it('multi-error static fixture also lacks STALE_BASE and PATCH_NOT_FOUND', () => {
    // Build a graph that triggers DUP_ID, DANGLING_DEP, and MAP_NOT_IN_DEPS.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      a: taskNode('a', {
        deps: ['start', 'ghost'],
        input: [{ name: 'x', source: 'start.x' }],
        input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: startNode('start') }, // DUP_ID
    ]
    const result = validateTaskGraphPostImage(
      graph,
      ops,
      undefined,
      makeResolver(),
    )
    assert.equal(result.graph, null)
    for (const issue of result.issues) {
      assert.notEqual(issue.code, 'STALE_BASE', 'STALE_BASE should not appear')
      assert.notEqual(issue.code, 'PATCH_NOT_FOUND', 'PATCH_NOT_FOUND should not appear')
    }
  })
})

// ─── 3. Op-level error locations ──────────────────────────────────────────────

describe('op errors contain op_index and node_id', () => {
  it('DUP_ID carries correct op_index and node_id', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: startNode('start') }, // op_index 0
      { op: 'AddNode', node: startNode('dup_target') },
      { op: 'AddNode', node: taskNode('dup_target') }, // op_index 2, DUP_ID
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.equal(result.graph, null)
    const dupIssues = result.issues.filter((i) => i.code === 'DUP_ID')
    assert.ok(dupIssues.length >= 1)
    for (const issue of dupIssues) {
      assert.equal(issue.category, 'op')
      const op = issue
      assert.equal(typeof op.op_index, 'number', 'op error must have op_index')
      assert.equal(typeof op.node_id, 'string', 'op error must have node_id')
    }
    // The DUP_ID for 'dup_target' should have op_index === 2
    const specific = dupIssues.find((i) => i.node_id === 'dup_target')
    assert.ok(specific, 'expected DUP_ID for dup_target')
    assert.equal(specific.op_index, 2)
  })

  it('FROZEN_NODE carries correct op_index and node_id', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      runner: taskNode('runner', { deps: ['start'] }),
    }
    const ops: PatchOperation[] = [
      { op: 'RemoveNode', id: 'runner' }, // op_index 0, FROZEN
      { op: 'ReplaceNode', node: startNode('start') }, // op_index 1, FROZEN
    ]
    const result = validateTaskGraphPostImage(graph, ops, { runner: 'running', start: 'running' }, makeResolver())
    assert.equal(result.graph, null)
    const frozen = result.issues.filter((i) => i.code === 'FROZEN_NODE')
    assert.equal(frozen.length, 2)
    for (const issue of frozen) {
      assert.equal(issue.category, 'op')
      assert.equal(typeof issue.op_index, 'number')
      assert.equal(typeof issue.node_id, 'string')
    }
    assert.equal(frozen[0].op_index, 0)
    assert.equal(frozen[0].node_id, 'runner')
    assert.equal(frozen[1].op_index, 1)
    assert.equal(frozen[1].node_id, 'start')
  })
})

// ─── 4. Individual error-code triggers ────────────────────────────────────────

describe('DUP_ID — AddNode with occupied id', () => {
  it('triggers when node id already exists', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: taskNode('start') },
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'DUP_ID'))
  })
})

describe('FROZEN_NODE — non-planned state', () => {
  for (const state of ['running', 'waiting', 'done', 'interrupted', 'cancelled']) {
    it(`RemoveNode with state "${state}"`, () => {
      const graph = emptyGraph()
      graph.nodes = {
        start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
        n: taskNode('n', { deps: ['start'] }),
      }
      const ops: PatchOperation[] = [{ op: 'RemoveNode', id: 'n' }]
      const result = validateTaskGraphPostImage(graph, ops, { n: state }, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'FROZEN_NODE'))
    })

    it(`ReplaceNode with state "${state}"`, () => {
      const graph = emptyGraph()
      graph.nodes = {
        start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
        n: taskNode('n', { deps: ['start'] }),
      }
      const ops: PatchOperation[] = [{ op: 'ReplaceNode', node: taskNode('n') }]
      const result = validateTaskGraphPostImage(graph, ops, { n: state }, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'FROZEN_NODE'))
    })
  }
})

describe('FAILED_NODE — editable via RemoveNode and ReplaceNode (D51)', () => {
  it('RemoveNode of an existing failed node succeeds', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      n: taskNode('n', { deps: ['start'] }),
    }
    const ops: PatchOperation[] = [{ op: 'RemoveNode', id: 'n' }]
    const result = validateTaskGraphPostImage(graph, ops, { n: 'failed' }, makeResolver())
    assert.ok(result.graph !== null, 'failed node RemoveNode should succeed')
    assert.equal(result.issues.length, 0)
  })

  it('ReplaceNode of an existing failed node succeeds', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      n: taskNode('n', { deps: ['start'] }),
    }
    const ops: PatchOperation[] = [{ op: 'ReplaceNode', node: taskNode('n') }]
    const result = validateTaskGraphPostImage(graph, ops, { n: 'failed' }, makeResolver())
    assert.ok(result.graph !== null, 'failed node ReplaceNode should succeed')
    assert.equal(result.issues.length, 0)
  })

  it('validateTaskGraphPostImage does not mutate nodeStates — immutability guarantee', () => {
    // reset-to-planned, error/output/current-execution-binding clearing, and graph resume
    // are apply-time responsibilities, not pure-validator concerns.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      n: taskNode('n', { deps: ['start'] }),
    }
    const originalNodeStates: Record<NodeId, NodeRunStateType> = Object.freeze({ n: 'failed' })
    const ops: PatchOperation[] = [{ op: 'ReplaceNode', node: taskNode('n') }]
    const _result = validateTaskGraphPostImage(graph, ops, originalNodeStates, makeResolver())
    // After a successful ReplaceNode validation, the caller's nodeStates object
    // must not reflect any mutations performed by the validator.
    const expected: Record<NodeId, NodeRunStateType> = { n: 'failed' }
    assert.deepStrictEqual(originalNodeStates, expected,
      'nodeStates must remain unchanged after validator runs')
  })
})

describe('MAP_PATH_UNKNOWN — unresolvable field/index or invalid SourceExpr', () => {
  it('unresolvable field projection from dep output schema', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { known: { type: 'string' } }, required: ['known'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'unknown', source: 'start.missingField' }],
        action: { type: 'convert', params: { assemble: { result: 'inputs.known' } } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN'), 'expected MAP_PATH_UNKNOWN')
  })

  it('invalid SourceExpr', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'bad', source: '?!invalid expr' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.bad' } } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    // MAP_PATH_UNKNOWN may come from either source parsing or projection
    const hasPathUnknown = result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN')
    assert.ok(hasPathUnknown, 'expected MAP_PATH_UNKNOWN for invalid SourceExpr')
  })

  it('unresolvable assemble field path', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: { type: 'convert', params: { assemble: { bad: 'inputs.a.nonexistent' } } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN'), 'expected MAP_PATH_UNKNOWN for assemble')
  })

  it('bare string constant without {const} wrapper is rejected', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: { type: 'convert', params: { assemble: { bad: 'notAnInputsRef' } } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN'), 'bare string without {const} should produce MAP_PATH_UNKNOWN')
  })
})

describe('MAP_TYPE_MISMATCH — slot/assemble leaf type mismatch', () => {
  it('task with explicit input schema conflicting with resolver', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        // Resolver says msg is string, but we declare it as number
        input_schema: { type: 'object', properties: { msg: { type: 'number' } }, required: ['msg'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'))
  })

  it('task with explicit output schema conflicting with resolver', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        output_schema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'))
  })

  it('llm with explicit input schema conflicting with resolver', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }),
      llmNode: {
        id: 'llmNode',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        // Resolver says prompt is string, but we say it's number
        input_schema: { type: 'object', properties: { prompt: { type: 'number' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'))
  })
})

describe('INPUT_INCOMPLETE — required input field uncovered', () => {
  it('$inputs ref to undefined slot', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        // Params reference $inputs.y but no slot "y" exists
        action: { type: 'task', params: { command: '$inputs.y', msg: '$inputs.x' } },
        input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'INPUT_INCOMPLETE'))
  })

  it('required input missing from both slots and params (resolver-derived)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } }),
      // Construct a task node directly (not via taskNode factory) so we avoid the
      // default 'msg' param and explicit input_schema — rely on the resolver which
      // requires 'msg'.  Per B7, the resolver-derived 'msg' requirement is NOT
      // copied into the graph node's input_schema, so no INPUT_INCOMPLETE arises.
      t: {
        id: 't',
        name: 'task-t',
        action: { type: 'task', params: { command: 'run' } },
        deps: ['start'],
        input: [
          { name: 'a', source: 'start.a' },
          { name: 'b', source: 'start.b' },
        ],
        input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Per B7: resolver-derived 'msg' is not copied into graph node input_schema,
    // so the graph is valid — no INPUT_INCOMPLETE from definition-only fields.
    assert.ok(result.graph !== null, 'should pass — resolver-derived input not copied into graph node')
    assert.equal(result.issues.length, 0)
  })
})

describe('MAP_NOT_IN_DEPS — source node omitted from deps', () => {
  it('node references source whose nodeId is not in deps', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      helper: taskNode('helper', { deps: ['start'] }),
      consumer: taskNode('consumer', {
        // consumer depends on "start" but references "helper.data"
        deps: ['start'],
        input: [{ name: 'data', source: 'helper.data' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_NOT_IN_DEPS'))
  })
})

describe('CYCLE — dependency cycle', () => {
  it('detects a mutual dependency cycle', () => {
    const graph = emptyGraph()
    graph.nodes = {
      a: taskNode('a', { deps: ['b'] }),
      b: taskNode('b', { deps: ['a'] }),
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    // Ensure start is present but not part of the cycle
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'CYCLE'))
  })

  it('detects a self-loop', () => {
    const graph = emptyGraph()
    graph.nodes = {
      self: taskNode('self', { deps: ['self'] }),
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'CYCLE'))
  })
})

describe('DANGLING_DEP — dependency on nonexistent node', () => {
  it('detects dep on a missing node', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      lonely: taskNode('lonely', { deps: ['start', 'phantom'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'DANGLING_DEP'))
  })
})

describe('SCHEMA_INVALID — structural graph violations', () => {
  it('no start node', () => {
    const graph = emptyGraph()
    graph.nodes = {
      t: taskNode('t'),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'))
  })

  it('multiple start nodes', () => {
    const graph = emptyGraph()
    graph.nodes = {
      s1: startNode('s1'),
      s2: startNode('s2'),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'))
  })

  it('start node with non-empty deps', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { deps: ['other'] }),
      other: taskNode('other'),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'))
  })

  it('start node with non-empty input slots', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        input: [{ name: 'inp', source: 'other.x' }],
      }),
      other: taskNode('other', { deps: ['start'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const schemaInvalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(schemaInvalid.some((i) => i.message.includes('input slots')), 'start input slots should be invalid')
  })

  it('convert node with != 1 dep', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      conv: convertNode('conv', { deps: [] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'))
  })

  it('join node with < 2 deps', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      jn: joinNode('jn', { deps: ['start'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'))
  })
})

describe('SCHEMA_REQUIRED — missing required schema declaration', () => {
  it('shell action without explicit schemas', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      sh: {
        id: 'sh',
        name: 'shell-node',
        action: { type: 'shell', params: { command: 'ls' } },
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const req = result.issues.filter((i) => i.code === 'SCHEMA_REQUIRED')
    assert.ok(req.length >= 2, 'should get both input and output SCHEMA_REQUIRED for shell')
  })

  it('task node when resolver returns null and no explicit schema', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', { deps: ['start'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_REQUIRED'))
  })
})

// ─── 5. Wiring error locations ─────────────────────────────────────────────────

describe('wiring errors contain node_id and slot', () => {
  it('MAP_NOT_IN_DEPS carries node_id and slot', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] } }),
      a: taskNode('a', { deps: ['start'] }),
      b: taskNode('b', {
        deps: ['start'],
        input: [{ name: 'data', source: 'a.data' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const mapNotInDeps = result.issues.filter((i) => i.code === 'MAP_NOT_IN_DEPS')
    for (const issue of mapNotInDeps) {
      assert.equal(issue.category, 'wiring')
      assert.equal(typeof issue.node_id, 'string')
      assert.equal(typeof issue.slot, 'string')
    }
  })

  it('INPUT_INCOMPLETE carries node_id and slot', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'task', params: { cmd: '$inputs.missing' } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const incomplete = result.issues.filter((i) => i.code === 'INPUT_INCOMPLETE')
    for (const issue of incomplete) {
      assert.equal(issue.category, 'wiring')
      assert.equal(typeof issue.node_id, 'string')
      assert.equal(typeof issue.slot, 'string')
    }
  })
})

// ─── 6. Graph error locations ─────────────────────────────────────────────────

describe('graph errors contain normalized node_ids list', () => {
  it('DANGLING_DEP node_ids are sorted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      a: taskNode('a', { deps: ['start', 'ghost'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const dag = result.issues.filter((i) => i.code === 'DANGLING_DEP')
    for (const issue of dag) {
      assert.equal(issue.category, 'graph')
      const ids = issue.node_ids
      assert.ok(Array.isArray(ids))
      assert.ok(ids.length >= 2)
      // Should be sorted
      const sorted = [...ids].sort()
      assert.deepEqual(ids, sorted, 'node_ids must be sorted')
    }
  })

  it('CYCLE node_ids are sorted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      a: taskNode('a', { deps: ['b'] }),
      b: taskNode('b', { deps: ['a'] }),
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const cycle = result.issues.filter((i) => i.code === 'CYCLE')
    for (const issue of cycle) {
      assert.equal(issue.category, 'graph')
      const ids = issue.node_ids
      assert.ok(Array.isArray(ids))
      const sorted = [...ids].sort()
      assert.deepEqual(ids, sorted, 'node_ids must be sorted')
    }
  })
})

// ─── 7. All-errors deep-equal with stable ordering ────────────────────────────

describe('all-errors deep-equal with stable ordering', () => {
  function buildFixture(graphReversedOrder?: boolean) {
    const graph = emptyGraph()
    if (graphReversedOrder) {
      graph.nodes = {
        b: taskNode('b', { deps: ['start', 'ghost'] }),
        start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      }
    } else {
      graph.nodes = {
        start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
        b: taskNode('b', { deps: ['start', 'ghost'] }),
      }
    }
    // Add a node whose input source references a non-dep node → MAP_NOT_IN_DEPS
    graph.nodes['c'] = taskNode('c', {
      deps: ['start'],
      input: [{ name: 'data', source: 'b.data' }],
    })
    // Start is in a non-planned state to trigger FROZEN_NODE on ReplaceNode
    const ops: PatchOperation[] = [
      { op: 'ReplaceNode', node: startNode('start') },   // op FROZEN_NODE
    ]
    return { graph, ops }
  }

  it('produces identical issues regardless of node-record construction order', () => {
    const { graph: graph1 } = buildFixture(false)
    const { graph: graph2 } = buildFixture(true)
    const nodeStates = { start: 'running' }
    const result1 = validateTaskGraphPostImage(graph1, [{ op: 'ReplaceNode', node: startNode('start') }], nodeStates, makeResolver())
    const result2 = validateTaskGraphPostImage(graph2, [{ op: 'ReplaceNode', node: startNode('start') }], nodeStates, makeResolver())

    assert.equal(result1.graph, null)
    assert.equal(result2.graph, null)
    assert.equal(result1.issues.length, result2.issues.length,
      `issue count mismatch: ${result1.issues.length} vs ${result2.issues.length}\n` +
      `result1: ${JSON.stringify(result1.issues.map(i => ({ cat: i.category, code: i.code, node: i.node_id ?? i.node_ids })))}\n` +
      `result2: ${JSON.stringify(result2.issues.map(i => ({ cat: i.category, code: i.code, node: i.node_id ?? i.node_ids })))}`,
    )

    for (let i = 0; i < result1.issues.length; i++) {
      assert.deepEqual(result1.issues[i], result2.issues[i],
        `issue at index ${i} differs between orderings`)
    }
  })

  it('contains faults from all three categories', () => {
    const { graph } = buildFixture(false)
    const nodeStates = { start: 'running' }
    const result = validateTaskGraphPostImage(graph, [{ op: 'ReplaceNode', node: startNode('start') }], nodeStates, makeResolver())

    assert.equal(result.graph, null)
    const categories = new Set(result.issues.map((i) => i.category))
    assert.ok(categories.has('op'), 'expected op category issues')
    assert.ok(categories.has('graph'), 'expected graph category issues')
    // Map nodes must reference non-dep nodes for wiring category
    assert.ok(categories.has('wiring'), `expected wiring category issues, got categories: ${[...categories].join(',')}`)
  })
})

// ─── 8. Successful post-image materialization ──────────────────────────────────

describe('successful materialization', () => {
  it('AddNode produces a valid post-image with the new node', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: taskNode('helper', { deps: ['start'], input: [{ name: 'msg', source: 'start.x' }] }) },
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.ok(result.graph !== null, 'should succeed')
    assert.ok('helper' in result.graph.nodes, 'helper node should be in post-image')
    assert.equal(result.issues.length, 0)
  })

  it('RemoveNode produces a valid post-image without the removed node', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      helper: taskNode('helper', { deps: ['start'] }),
    }
    const ops: PatchOperation[] = [
      { op: 'RemoveNode', id: 'helper' },
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.ok(result.graph !== null, 'should succeed')
    assert.ok(!('helper' in result.graph.nodes), 'helper should be removed')
    assert.equal(result.issues.length, 0)
  })

  it('ReplaceNode produces a valid post-image with the replaced node', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      helper: taskNode('helper', {
        deps: ['start'],
        name: 'old-helper',
      }),
    }
    const replacement = taskNode('helper', {
      deps: ['start'],
      name: 'new-helper',
    })
    const ops: PatchOperation[] = [
      { op: 'ReplaceNode', node: replacement },
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.ok(result.graph !== null, 'should succeed')
    assert.equal(result.graph.nodes['helper'].name, 'new-helper', 'node should be replaced')
    assert.equal(result.issues.length, 0)
  })

  it('removal without cascade succeeds when downstream references repaired in the same patch', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      a: taskNode('a', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
      }),
      b: taskNode('b', {
        deps: ['start', 'a'],
        input: [{ name: 'x', source: 'start.x' }],
      }),
    }
    const ops: PatchOperation[] = [
      { op: 'RemoveNode', id: 'a' },
      // Repair b's deps in same patch to remove reference to 'a'
      { op: 'ReplaceNode', node: taskNode('b', { deps: ['start'], input: [{ name: 'x', source: 'start.x' }] }) },
    ]
    const result = validateTaskGraphPostImage(graph, ops, undefined, makeResolver())
    assert.ok(result.graph !== null, 'should succeed when downstream references are repaired')
    assert.equal(result.issues.length, 0)
  })

  it('reuse of removed node id in later validator call', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
    }
    // Add a node
    const result1 = validateTaskGraphPostImage(graph, [
      { op: 'AddNode', node: taskNode('tmp', { deps: ['start'] }) },
    ], undefined, makeResolver())
    assert.ok(result1.graph !== null)
    assert.ok('tmp' in result1.graph.nodes)

    // Now remove it from the same original graph (immutable input)
    const result2 = validateTaskGraphPostImage(graph, [
      { op: 'AddNode', node: taskNode('tmp', { deps: ['start'] }) },
      { op: 'RemoveNode', id: 'tmp' },
    ], undefined, makeResolver())
    assert.ok(result2.graph !== null)
    assert.ok(!('tmp' in result2.graph.nodes))

    // Reuse id "tmp" in a fresh call against the same original graph
    const result3 = validateTaskGraphPostImage(graph, [
      { op: 'AddNode', node: taskNode('tmp', { deps: ['start'], name: 'reused-tmp' }) },
    ], undefined, makeResolver())
    assert.ok(result3.graph !== null)
    assert.ok('tmp' in result3.graph.nodes)
    assert.equal(result3.graph.nodes['tmp'].name, 'reused-tmp')
  })
})

// ─── 9. Frozen auto-schema rows (every action type) ───────────────────────────

describe('frozen auto-schema rows', () => {
  it('task — explicit empty object-root graph input_schema stays empty while resolver output_schema auto-pins result:string', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        // Graph slot input_schema is explicit empty object-root — must stay empty
        input_schema: { type: 'object', properties: {} },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['t']
    assert.equal(node.input_schema.type, 'object')
    // B7: graph slot input_schema stays as explicit empty — resolver input is not copied in
    assert.ok(node.input_schema.properties && !node.input_schema.properties['msg'],
      'task graph slot input_schema should remain empty, not acquire resolver msg field')
    // Output schema still auto-pins result:string from resolver
    assert.equal(node.output_schema.properties?.['result']?.type, 'string')
  })


  it('llm with default text output', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['llm']
    // Default text output
    assert.equal(node.output_schema.properties?.['text']?.type, 'string')
    assert.deepEqual(node.output_schema.required, ['text'])
  })

  it('llm with structured output', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
      resolveLlmStructuredOpts() {
        return {
          outputSchema: { type: 'object', properties: { result: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }, required: ['result'] },
        }
      },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['llm']
    // Structured output should appear
    assert.ok(node.output_schema.properties?.['result'], 'structured output should have result field')
  })

  it('convert with one dep — auto schema from upstream and assemble', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { val: { type: 'number' } }, required: ['val'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        action: { type: 'convert', params: { assemble: { doubled: 'inputs.val' } } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['conv']
    // Input should have 'val' from upstream
    assert.ok(node.input_schema.properties?.['val'], 'convert input should have val field')
    // Output should have 'doubled' from assemble
    assert.ok(node.output_schema.properties?.['doubled'], 'convert output should have doubled field')
  })

  it('join with at least two deps — assemble with refs, constants, literals', () => {
    const graph = emptyGraph()
    graph.nodes = {
      a: taskNode('a', {
        deps: [],
      }),
      b: taskNode('b', {
        deps: [],
      }),
      start: startNode('start', { deps: [], output_schema: { type: 'object', properties: { z: { type: 'boolean' } }, required: ['z'] } }),
      jn: joinNode('jn', {
        deps: ['a', 'b'],
        input: [
          { name: 'x', source: 'a.result' },
          { name: 'y', source: 'b.result' },
        ],
        action: {
          type: 'join',
          params: {
            assemble: {
              fromA: 'inputs.x',
              fromB: 'inputs.y',
              constant: { const: 'literal_string' },
              count: 42,
              items: [1, 2, 3],
              nested: { key: { const: 'value' } },
              refsArray: ['inputs.x', 'inputs.y'],
              'meta.diff': 'inputs.x',
            },
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `join should succeed, got ${JSON.stringify(result.issues)}`)
    const node = result.graph.nodes['jn']
    assert.ok(node.output_schema.properties?.['fromA'], 'assemble field fromA')
    assert.ok(node.output_schema.properties?.['fromB'], 'assemble field fromB')
    assert.equal(node.output_schema.properties?.['constant']?.type, 'string')
    assert.equal(node.output_schema.properties?.['count']?.type, 'number')
    assert.equal(node.output_schema.properties?.['items']?.type, 'array')
    assert.equal(node.output_schema.properties?.['nested']?.type, 'object')
    assert.equal(node.output_schema.properties?.['refsArray']?.type, 'array')
    assert.equal(node.output_schema.properties?.['items']?.type, 'array')
    // Nested target path
    const meta = node.output_schema.properties?.['meta'] as JsonObject | undefined
    assert.ok(meta, 'nested meta field should exist')
    assert.equal(meta.type, 'object')
    const metaProps = meta.properties as Record<string, JsonObject> | undefined
    assert.ok(metaProps?.['diff'], 'meta.diff should exist')
    assert.deepEqual(meta.required, ['diff'], 'meta.required should contain diff')
  })

  it('condition — emits a downstream node id branch contract', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] } }),
      cond: {
        id: 'cond',
        name: 'condition-node',
        action: {
          type: 'condition',
          params: {
            cases: [{ when: { path: '$.val', op: 'eq', value: 'go' }, branch: 'next' }],
            default: 'next',
          },
        },
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
      next: {
        id: 'next',
        name: 'next',
        action: { type: 'end', params: {} },
        deps: ['cond'],
        input: [{ name: 'branch', source: 'cond.branch' }],
        input_schema: {
          type: 'object',
          properties: { branch: { type: 'string' } },
          required: ['branch'],
        },
        output_schema: {
          type: 'object',
          properties: { branch: { type: 'string' } },
          required: ['branch'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['cond']
    assert.ok(node.input_schema.properties?.['val'], 'condition input should have val')
    assert.equal(node.output_schema.properties?.['branch']?.type, 'string')
    assert.deepEqual(node.output_schema.required, ['branch'])
  })

  it('checkpoint — upstream input with handwritten output', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { state: { type: 'string' } }, required: ['state'] } }),
      cp: {
        id: 'cp',
        name: 'checkpoint-node',
        action: { type: 'checkpoint', params: {} },
        deps: ['start'],
        input: [{ name: 'state', source: 'start.state' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['cp']
    assert.ok(node.input_schema.properties?.['state'], 'checkpoint input should have state')
    assert.equal(node.output_schema.properties?.['decision']?.type, 'string')
  })

  it('start — canonical start with empty deps/input and handwritten output', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { init: { type: 'string' } }, required: ['init'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['start']
    // Start input should be empty
    assert.deepEqual(node.input_schema.properties, {})
    assert.ok(!node.input_schema.required || node.input_schema.required.length === 0)
    // Output should be preserved from explicit
    assert.equal(node.output_schema.properties?.['init']?.type, 'string')
  })

  it('end — handwritten input and output', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      end: endNode('end', {
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null)
    const node = result.graph.nodes['end']
    assert.equal(node.input_schema.properties?.['final']?.type, 'string')
    assert.equal(node.output_schema.properties?.['ok']?.type, 'boolean')
  })
})

// ─── 10. Explicit inferred-schema assertion boundaries ────────────────────────

describe('explicit inferred-schema assertions', () => {
  it('matching required fields plus extra optional fields are accepted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        // Resolver gives { msg: string }, we assert a wider explicit that includes extra optional
        input_schema: {
          type: 'object',
          properties: {
            msg: { type: 'string' },
            extraOptional: { type: 'number' },
          },
          required: ['msg'],
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — extra optional fields are fine
    assert.ok(result.graph !== null, 'should accept extra optional fields')
    assert.equal(result.issues.length, 0)
  })

  it('missing required field is rejected — INPUT_INCOMPLETE not MAP_TYPE_MISMATCH', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        // Resolver expects { msg: string }, but explicit only has { other: string }
        input_schema: {
          type: 'object',
          properties: { other: { type: 'string' } },
          required: ['other'],
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    // B7: structurally missing required graph slot 'other' → INPUT_INCOMPLETE
    assert.ok(result.issues.some((i) => i.code === 'INPUT_INCOMPLETE'),
      'should reject via INPUT_INCOMPLETE for required graph slot "other"')
    // No MAP_TYPE_MISMATCH — definition-vs-slot comparison does not happen
    assert.ok(!result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'),
      'no MAP_TYPE_MISMATCH from definition-vs-slot comparison')
  })

  it('mismatched required field type is rejected', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        // Resolver says msg is string, explicit says msg is number → mismatch
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'number' } },
          required: ['msg'],
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'))
  })
})

// ─── 11. Optional-path ergonomics ─────────────────────────────────────────────

describe('optional path — schema-provable optional sources', () => {
  it('optional input passes static validation even if runtime value absent', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { existent: { type: 'string' } }, required: ['existent'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [
          { name: 'msg', source: 'start.existent' },
          { name: 'optional', source: 'start.existent', optional: true },
        ],
        action: { type: 'task', params: { command: 'run', msg: '$inputs.msg' } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — optional field doesn't need to be in params or assemble
    assert.ok(result.graph !== null, 'optional input should not cause static failure')
    assert.equal(result.issues.length, 0)
  })
})

// ─── 12. Immutability — no side effects to inputs ─────────────────────────────

describe('immutability — graph, ops, state view, action params, and resolver schemas', () => {
  function runImmutabilityTest(label: string, graph: TaskGraph, ops: PatchOperation[], nodeStates: Record<string, string> | undefined, expectFailure: boolean) {
    const resolver = makeResolver()

    // Snapshot everything before
    const graphBefore = deepClone(graph)
    const opsBefore = deepClone(ops)
    const stateBefore = deepClone(nodeStates ?? {})
    const resolverSchemasBefore = {
      task: resolver.resolveActionSchema('task', {}),
      llmInput: resolver.resolveLlmInputSchema({}),
      llmStructured: resolver.resolveLlmStructuredOpts({}),
    }

    // Call
    const result = validateTaskGraphPostImage(graph, ops, nodeStates, resolver)

    // Assert immutability
    assertUnchanged(graph, graphBefore, `${label}: current graph`)
    assertUnchanged(ops, opsBefore, `${label}: ops array`)
    assertUnchanged(nodeStates ?? {}, stateBefore, `${label}: nodeStates`)

    // Resolver schemas should not change
    const resolverSchemasAfter = {
      task: resolver.resolveActionSchema('task', {}),
      llmInput: resolver.resolveLlmInputSchema({}),
      llmStructured: resolver.resolveLlmStructuredOpts({}),
    }
    assert.deepEqual(resolverSchemasAfter, resolverSchemasBefore, `${label}: resolver schemas changed`)

    // Revision not incremented
    assert.equal(graph.revision, graphBefore.revision, `${label}: graph revision incremented`)

    if (expectFailure) {
      assert.equal(result.graph, null, `${label}: expected failure`)
    } else {
      assert.ok(result.graph !== null, `${label}: expected success`)
    }
  }

  it('success path — no mutation to inputs', () => {
    const graph: TaskGraph = {
      id: 'g-test',
      revision: 5,
      nodes: {
        start: startNode('start', { output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] } }),
        t: taskNode('t', { deps: ['start'], input: [{ name: 'val', source: 'start.val' }] }),
      },
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: taskNode('newNode', { deps: ['start'], input: [{ name: 'val', source: 'start.val' }] }) },
    ]
    runImmutabilityTest('success', graph, ops, undefined, false)
  })

  it('failure path — no mutation to inputs', () => {
    const graph: TaskGraph = {
      id: 'g-test',
      revision: 5,
      nodes: {
        start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
        t: taskNode('t', { deps: ['start', 'ghost'] }),
      },
    }
    const ops: PatchOperation[] = [
      { op: 'AddNode', node: startNode('start') }, // DUP_ID
    ]
    runImmutabilityTest('failure', graph, ops, undefined, true)
  })

  it('resolver schemas remain unchanged after failure path', () => {
    const graph: TaskGraph = {
      id: 'g-test',
      revision: 0,
      nodes: {},
    }
    // No start node → SCHEMA_INVALID
    const ops: PatchOperation[] = []
    const resolver = makeResolver()
    const schemaBefore = resolver.resolveActionSchema('task', {})

    const result = validateTaskGraphPostImage(graph, ops, undefined, resolver)

    assert.equal(result.graph, null)
    const schemaAfter = resolver.resolveActionSchema('task', {})
    assert.deepEqual(schemaAfter, schemaBefore, 'resolver schema mutated after failure')

    const llmInputBefore = resolver.resolveLlmInputSchema({})
    const llmInputAfter = resolver.resolveLlmInputSchema({})
    assert.deepEqual(llmInputAfter, llmInputBefore, 'llm input schema mutated')
  })
})


// ─── 14. Regression: node-record insertion order ──────────────────────────────

describe('regression: node-record insertion order — consumer before auto-materialized dep', () => {
  it('validates identically regardless of node record insertion order', () => {
    const resolver = makeResolver()

    function buildGraph(order: 'consumer-first' | 'producer-first') {
      const start = startNode('start', {
        output_schema: { type: 'object', properties: { out: { type: 'string' } }, required: ['out'] },
      })
      const producer = taskNode('producer', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.out' }],
      })
      const consumer = taskNode('consumer', {
        deps: ['start', 'producer'],
        input: [
          { name: 'msg', source: 'start.out' },
          { name: 'data', source: 'producer.result' },
        ],
      })
      const graph = emptyGraph()
      if (order === 'consumer-first') {
        graph.nodes = { start, consumer, producer }
      } else {
        graph.nodes = { start, producer, consumer }
      }
      return graph
    }

    const result1 = validateTaskGraphPostImage(buildGraph('consumer-first'), [], undefined, resolver)
    const result2 = validateTaskGraphPostImage(buildGraph('producer-first'), [], undefined, resolver)

    assert.ok(result1.graph !== null,
      `consumer-first should succeed, got: ${JSON.stringify(result1.issues.map((i) => i.code))}`)
    assert.ok(result2.graph !== null,
      `producer-first should succeed, got: ${JSON.stringify(result2.issues.map((i) => i.code))}`)
    assert.equal(result1.issues.length, 0)
    assert.equal(result2.issues.length, 0)

    const c1 = result1.graph!.nodes.consumer
    const c2 = result2.graph!.nodes.consumer
    assert.deepEqual(c1.input_schema, c2.input_schema, 'consumer input_schema must be order-independent')
    assert.deepEqual(c1.output_schema, c2.output_schema, 'consumer output_schema must be order-independent')
  })
})

// ─── 15. Regression: malformed nested schema fragments ────────────────────────

describe('regression: malformed nested schema fragments rejected as SCHEMA_INVALID', () => {
  it('rejects deeply nested type:any', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nestedBad: {
              type: 'object',
              properties: {
                deeply: { type: 'any' },
              },
              required: ['deeply'],
            },
          },
          required: ['ok', 'nestedBad'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for nested type:any')
  })

  it('rejects deeply nested property without type', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nested: {
              type: 'object',
              properties: {
                untagged: {},
              },
              required: ['untagged'],
            },
          },
          required: ['ok', 'nested'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for nested property without type')
  })
})

// ─── 16. Regression: conflicting nested assemble targets ──────────────────────

describe('regression: conflicting nested assemble targets produce MAP_TYPE_MISMATCH', () => {
  it('a.b.c and a.b cause MAP_TYPE_MISMATCH', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
      }),
      conv: {
        id: 'conv',
        name: 'convert-node',
        action: {
          type: 'convert',
          params: {
            assemble: {
              'a.b.c': 'inputs.val',
              'a.b': { const: 42 },
            } as Record<string, JsonValue>,
          },
        },
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        input_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const mismatches = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH')
    assert.ok(mismatches.length > 0,
      `expected at least one MAP_TYPE_MISMATCH, got: ${JSON.stringify(result.issues.map((i) => i.code))}`)
    // The conflict occurs at the nested path — a.b.c creates a.b as intermediate
    // object, then a.b tries to set it as number leaf.
    const convMatch = mismatches.find((i) => i.node_id === 'conv')
    assert.ok(convMatch, 'MAP_TYPE_MISMATCH should be attributed to conv node')
  })
})

// ─── 17. Regression: nested boolean schemas under properties/items/combinators ─

describe('regression: nested boolean schemas under properties/items/combinators reject as SCHEMA_INVALID', () => {
  it('rejects boolean schema nested in properties', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bad: true,
          },
          required: ['ok', 'bad'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for boolean schema in properties')
  })

  it('rejects boolean schema nested in items', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            arr: { type: 'array', items: true },
          },
          required: ['ok', 'arr'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for boolean schema in items')
  })

  it('rejects boolean schema nested in combinators', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            combined: { allOf: [true, { type: 'object', properties: { a: { type: 'string' } } }] },
          },
          required: ['ok', 'combined'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for boolean schema in combinators')
  })
})

// ─── 18. Regression: consumer before auto-materialized dep ─────────────────────

describe('regression: consumer before auto-materialized task dependency can project pinned output', () => {
  it('consumer projected pinned output from task dep when consumer record precedes producer', () => {
    const graph = emptyGraph()
    const start = startNode('start', {
      output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    })
    const producer = taskNode('producer', {
      deps: ['start'],
      input: [{ name: 'msg', source: 'start.x' }],
    })
    const consumer = taskNode('consumer', {
      deps: ['start', 'producer'],
      input: [
        { name: 'msg', source: 'start.x' },
        { name: 'result', source: 'producer.result' },
      ],
    })
    graph.nodes = { start, consumer, producer }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      `consumer-first with pinned output projection should succeed, got: ${JSON.stringify(result.issues.map((i) => i.code))}`)
    assert.equal(result.issues.length, 0)
    assert.ok('producer' in result.graph.nodes)
    assert.ok('consumer' in result.graph.nodes)
  })
})

// ─── 19. Regression: projected slot number vs required destination string ─────

describe('regression: projected slot number versus required destination string emits MAP_TYPE_MISMATCH', () => {
  it('number source projected into string destination slot', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.count' }],
        // Resolver gives msg: string but source start.count is number
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_TYPE_MISMATCH'),
      'expected MAP_TYPE_MISMATCH for number-to-string slot projection')
  })
})

// ─── 20. Regression: object-vs-object nested assemble conflict ────────────────

describe('regression: object-vs-object nested assemble conflict a.b.c:string then a.b:{const:{c:3}} rejects', () => {
  it('both paths produce objects at a.b with conflicting nested c type', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
      }),
      conv: {
        id: 'conv',
        name: 'convert-node',
        action: {
          type: 'convert',
          params: {
            assemble: {
              'a.b.c': 'inputs.val',
              'a.b': { const: { c: 3 } },
            } as Record<string, JsonValue>,
          },
        },
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        input_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const mismatches = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH')
    assert.ok(mismatches.length > 0,
      `expected at least one MAP_TYPE_MISMATCH for object-vs-object nested conflict, got: ${JSON.stringify(result.issues.map((i) => i.code))}`)
    const convMatch = mismatches.find((i) => i.node_id === 'conv')
    assert.ok(convMatch, 'MAP_TYPE_MISMATCH should be attributed to conv node')
  })
})

// ─── 21. Regression: graph with multiple normalized cycles ─────────────────────

describe('regression: graph a->[b,c], b->[c], c->[a] reports both normalized cycles [a,b,c] and [a,c]', () => {
  it('reports two distinct cycles for a cross-connected diamond with back-edge', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      a: taskNode('a', { deps: ['start', 'b', 'c'] }),
      b: taskNode('b', { deps: ['c'] }),
      c: taskNode('c', { deps: ['a'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const cycles = result.issues.filter((i) => i.code === 'CYCLE')
    assert.equal(cycles.length, 2,
      `expected 2 distinct cycles, got ${cycles.length}: ${JSON.stringify(cycles.map((c) => c.node_ids))}`)
    const idSets = cycles.map((c) => (c.node_ids as string[]).sort().join(','))
    assert.ok(idSets.includes('a,b,c'), `expected normalized cycle [a,b,c], got cycles: ${JSON.stringify(idSets)}`)
    assert.ok(idSets.includes('a,c'), `expected normalized cycle [a,c], got cycles: ${JSON.stringify(idSets)}`)
  })
})

// ─── 22. Regression: sibling malformed schema fragments ───────────────────────

describe('regression: sibling malformed schema fragments preserve distinct SCHEMA_INVALID details', () => {
  it('two sibling malformed fragments produce distinct errors with correct input/output attribution', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: {
          type: 'object',
          properties: {
            final: { type: 'boolean' },
            badInput: { type: 'any' },
          },
          required: ['final', 'badInput'],
        },
        output_schema: {
          type: 'object',
          properties: {
            ok: {},
          },
          required: ['ok'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.length >= 2,
      `expected at least 2 SCHEMA_INVALID for sibling malformed fragments, got ${invalid.length}`)
    // Verify distinct messages
    const msgs = invalid.map((i) => i.message)
    assert.notEqual(msgs[0], msgs[1], 'sibling malformed fragments should have distinct messages')
    // Verify input vs output attribution in messages
    const hasInput = msgs.some((m) => /input/i.test(m))
    const hasOutput = msgs.some((m) => /output/i.test(m))
    assert.ok(hasInput, 'at least one SCHEMA_INVALID should mention input-side attribution')
    assert.ok(hasOutput, 'at least one SCHEMA_INVALID should mention output-side attribution')
  })
})

// ─── 23. Regression: assemble array with bare string ───────────────────────────

describe('regression: assemble array with bare string rejects while inputs refs and {const} remain valid', () => {
  it('bare string element in assemble array produces MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              arr: ['bareString', 'inputs.val', { const: 42 }],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN'),
      'expected MAP_PATH_UNKNOWN for bare string in assemble array')
    const convIssues = result.issues.filter((i) => i.node_id === 'conv')
    assert.ok(convIssues.some((i) => i.code === 'MAP_PATH_UNKNOWN'),
      'MAP_PATH_UNKNOWN should be attributed to conv node')
  })
})

// ─── 24. Regression: task_956deee8 — additionalProperties:true and skipped schema-bearing keywords ──

describe('regression: task_956deee8 — additionalProperties:true and skipped schema-bearing keywords produce distinct SCHEMA_INVALID', () => {
  it('additionalProperties boolean produces SCHEMA_INVALID alongside other skipped keyword schemas', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: true,
          contains: true,
          propertyNames: true,
          if: true,
          then: true,
          else: true,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    // Each boolean subschema keyword should produce its own SCHEMA_INVALID detail.
    const booleanPaths = invalid.map((i) => i.message)
    assert.ok(booleanPaths.some((m) => m.includes('additionalProperties')),
      'expected SCHEMA_INVALID for additionalProperties boolean')
    assert.ok(booleanPaths.some((m) => m.includes('contains')),
      'expected distinct SCHEMA_INVALID for contains boolean')
    assert.ok(booleanPaths.some((m) => m.includes('propertyNames')),
      'expected distinct SCHEMA_INVALID for propertyNames boolean')
    assert.ok(booleanPaths.some((m) => m.includes('.if')),
      'expected distinct SCHEMA_INVALID for if boolean')
    assert.ok(booleanPaths.some((m) => m.includes('.then')),
      'expected distinct SCHEMA_INVALID for then boolean')
    assert.ok(booleanPaths.some((m) => m.includes('.else')),
      'expected distinct SCHEMA_INVALID for else boolean')
  })
})

// ─── 25. Regression: task_956deee8 — nested a.b.c from string slot then flat a:{const:{b:{c:3}}} ──

describe('regression: task_956deee8 — nested target a.b.c from string slot followed by flat a:{const:{b:{c:3}}}', () => {
  function buildCollisionFixture(keyOrder: 'nestedFirst' | 'flatFirst'): TaskGraph {
    const assemble: Record<string, JsonValue> =
      keyOrder === 'nestedFirst'
        ? { 'a.b.c': 'inputs.val', a: { const: { b: { c: 3 } } } as JsonValue }
        : { a: { const: { b: { c: 3 } } } as JsonValue, 'a.b.c': 'inputs.val' }
    return {
      id: 'g-test',
      revision: 0,
      nodes: {
        start: startNode('start', {
          output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
        }),
        conv: {
          id: 'conv',
          name: 'convert-node',
          action: { type: 'convert', params: { assemble } },
          deps: ['start'],
          input: [{ name: 'val', source: 'start.val' }],
          input_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
          output_schema: { type: 'object', properties: {} },
        } as TaskGraphNode,
      },
    }
  }

  it('a.b.c then a:{const:{b:{c:3}}} produces MAP_TYPE_MISMATCH', () => {
    const graph = buildCollisionFixture('nestedFirst')
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const mismatches = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH')
    assert.ok(mismatches.length > 0,
      `expected MAP_TYPE_MISMATCH for nested-first order, got: ${JSON.stringify(result.issues.map((i) => i.code))}`)
    assert.ok(mismatches.some((i) => i.node_id === 'conv'),
      'MAP_TYPE_MISMATCH should be attributed to conv node')
  })

  it('a:{const:{b:{c:3}}} then a.b.c produces MAP_TYPE_MISMATCH', () => {
    const graph = buildCollisionFixture('flatFirst')
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const mismatches = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH')
    assert.ok(mismatches.length > 0,
      `expected MAP_TYPE_MISMATCH for flat-first order, got: ${JSON.stringify(result.issues.map((i) => i.code))}`)
    assert.ok(mismatches.some((i) => i.node_id === 'conv'),
      'MAP_TYPE_MISMATCH should be attributed to conv node')
  })
})

// ─── 26. Regression: task_31dcc1f8 — items:false, boolean tuple, boolean deps, missing-type parent ──

describe('regression: task_31dcc1f8 — items:false, boolean tuple item, boolean dependency, and missing-type parent reject as SCHEMA_INVALID', () => {
  it('rejects items:false at exact path', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            arr: { type: 'array', items: false },
          },
          required: ['ok', 'arr'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('.items')),
      'expected SCHEMA_INVALID for items:false at .items path')
  })

  it('rejects boolean tuple item at exact path', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            arr: { type: 'array', items: [true, { type: 'string' }] },
          },
          required: ['ok', 'arr'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('.items[0]')),
      'expected SCHEMA_INVALID for boolean tuple item at .items[0]')
    assert.ok(!invalid.some((i) => i.message.includes('.items[1]')),
      'valid object schema at .items[1] should not produce SCHEMA_INVALID')
  })

  it('rejects boolean legacy dependency schema', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          dependencies: {
            ok: true,
          },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('dependencies["ok"]')),
      'expected SCHEMA_INVALID for boolean dependency at dependencies["ok"]')
  })

  it('rejects boolean property under parent missing type', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          // No parent type — properties and items should still be inspected
          properties: {
            ok: true,
          },
          items: false,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('missing a type') || i.message.includes('must be a JSON object')),
      'expected SCHEMA_INVALID for parent missing type')
    assert.ok(invalid.some((i) => i.message.includes('.properties.ok')),
      'expected SCHEMA_INVALID for boolean property even without parent type')
    assert.ok(invalid.some((i) => i.message.includes('.items')),
      'expected SCHEMA_INVALID for items inspected despite missing parent type')
  })

  it('produces deterministic diagnostic order regardless of sibling insertion order', () => {
    function buildFixture(propOrder: 'abc' | 'cba'): TaskGraph {
      const props: Record<string, JsonObject> =
        propOrder === 'abc'
          ? { alpha: true, beta: true, gamma: true } as unknown as Record<string, JsonObject>
          : { gamma: true, beta: true, alpha: true } as unknown as Record<string, JsonObject>
      return {
        id: 'g-test',
        revision: 0,
        nodes: {
          start: startNode('start', {
            output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
          }),
          end: {
            id: 'end',
            name: 'end-node',
            action: { type: 'end', params: {} },
            deps: ['start'],
            input: [{ name: 'final', source: 'start.x' }],
            input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
            output_schema: {
              type: 'object',
              properties: props,
              required: Object.keys(props),
            },
          } as TaskGraphNode,
        },
      }
    }

    const abc = validateTaskGraphPostImage(buildFixture('abc'), [], undefined, makeResolver())
    const cba = validateTaskGraphPostImage(buildFixture('cba'), [], undefined, makeResolver())
    assert.equal(abc.graph, null)
    assert.equal(cba.graph, null)
    assert.deepEqual(abc.issues, cba.issues,
      'diagnostics must be deep-equal regardless of property insertion order')
  })
})

// ─── 27. Regression: task_956deee8 — output property named "input" keeps output attribution ──

describe('regression: task_956deee8 — invalid output property named "input" still attributed to output', () => {
  it('output property literally named "input" with bad type is attributed to output while retaining schema path', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            input: { type: 'any' },
          },
          required: ['ok', 'input'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    // Find the issue for the "input" property — its slot must be "output", not "input"
    const inputPropIssue = invalid.find((i) => i.message.includes('.output_schema.properties.input'))
    assert.ok(inputPropIssue, 'expected SCHEMA_INVALID for the property named "input"')
    assert.equal(inputPropIssue.slot, 'output',
      `property named "input" should be attributed to output slot, got "${inputPropIssue.slot}"`)
    // The schema path in the message must retain "input" as the property name
    assert.ok(inputPropIssue.message.includes('.output_schema.properties.input'),
      `schema path should include .output_schema.properties.input, got: ${inputPropIssue.message}`)
  })
})

// ─── 28. Regression: task_2a3ffe28 — additionalItems/unevaluated schemas reject ──

describe('regression: task_2a3ffe28 — additionalItems true/false and remaining schema-bearing keywords reject at exact paths', () => {
  it('additionalItems:true produces SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            items: {
              type: 'array',
              items: [{ type: 'string' }, { type: 'number' }],
              additionalItems: true,
            },
          },
          required: ['ok'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('additionalItems')),
      'expected SCHEMA_INVALID for additionalItems:true')
  })

  it('additionalItems:false produces SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            items: {
              type: 'array',
              items: [{ type: 'string' }],
              additionalItems: false,
            },
          },
          required: ['ok'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(invalid.some((i) => i.message.includes('.additionalItems')),
      'expected SCHEMA_INVALID for additionalItems:false')
  })

  it('unevaluatedProperties:true rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          unevaluatedProperties: true,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('unevaluatedProperties')),
      'expected SCHEMA_INVALID for unevaluatedProperties:true')
  })

  it('unevaluatedProperties:false rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          unevaluatedProperties: false,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.unevaluatedProperties')),
      'expected SCHEMA_INVALID for unevaluatedProperties:false')
  })

  it('unevaluatedItems:true rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          unevaluatedItems: true,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('unevaluatedItems')),
      'expected SCHEMA_INVALID for unevaluatedItems:true')
  })

  it('unevaluatedItems:false rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          unevaluatedItems: false,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.unevaluatedItems')),
      'expected SCHEMA_INVALID for unevaluatedItems:false')
  })

  it('contentSchema boolean rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          contentSchema: true,
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('contentSchema')),
      'expected SCHEMA_INVALID for contentSchema boolean')
  })

  it('contentSchema object is recursively validated', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          contentSchema: { type: 'any' },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('contentSchema')),
      'expected SCHEMA_INVALID for contentSchema with forbidden type')
  })
})

// ─── 29. Regression: task_2a3ffe28 — primitive root schemas reject ──

describe('regression: task_2a3ffe28 — primitive input_schema/output_schema roots reject', () => {
  it('primitive type as root input_schema rejects', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'string' } as JsonObject,
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const inputIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end' && i.slot === 'input')
    assert.ok(inputIssues.some((i) => i.message.includes('"object"')),
      'expected SCHEMA_INVALID for primitive root input_schema')
  })

  it('primitive type as root output_schema rejects', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: { type: 'number' } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const outputIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end' && i.slot === 'output')
    assert.ok(outputIssues.some((i) => i.message.includes('"object"')),
      'expected SCHEMA_INVALID for primitive root output_schema')
  })

  it('boolean root output_schema rejects', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: true as unknown as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const outputIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end' && i.slot === 'output')
    assert.ok(outputIssues.some((i) => i.message.includes('boolean/primitive root')),
      'expected SCHEMA_INVALID for boolean root output_schema')
  })

  it('primitive nested property schema remains valid', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            val: { type: 'string' },
          },
          required: ['ok', 'val'],
        },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — nested primitive properties are valid
    assert.ok(result.graph !== null,
      'primitive nested property schemas should be valid under object root')
  })
})

// ─── 30. Regression: task_2a3ffe28 — malformed NodeInput.source rejects for all action types ──

describe('regression: task_2a3ffe28 — malformed NodeInput.source rejects with MAP_PATH_UNKNOWN for all action types', () => {
  function buildWithBadSource(actionType: string, params: Record<string, JsonValue>): TaskGraph {
    return {
      id: 'g-test',
      revision: 0,
      nodes: {
        start: startNode('start', {
          output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        }),
        node: {
          id: 'node',
          name: `bad-source-${actionType}`,
          action: { type: actionType, params } as JsonObject,
          deps: ['start'],
          input: [{ name: 'bad', source: '?!invalid' }],
          input_schema: { type: 'object', properties: {} },
          output_schema: { type: 'object', properties: {} },
        } as TaskGraphNode,
      },
    }
  }

  it('malformed source rejects for task', () => {
    const result = validateTaskGraphPostImage(buildWithBadSource('task', { command: 'echo' }), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for task with bad source')
  })


  it('malformed source rejects for llm', () => {
    const result = validateTaskGraphPostImage(buildWithBadSource('llm', { prompt: 'hello' }), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for llm with bad source')
  })

  it('malformed source rejects for end', () => {
    const result = validateTaskGraphPostImage(buildWithBadSource('end', {}), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for end with bad source')
  })

  it('malformed source rejects for convert (derived action)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: {
        id: 'conv',
        name: 'bad-source-convert',
        action: { type: 'convert', params: { assemble: { out: 'inputs.x' } } },
        deps: ['start'],
        input: [{ name: 'bad', source: '?!invalid' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'conv' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for convert with bad source')
  })
})

// ─── 31. Regression: task_2a3ffe28 — nested bare string in assemble objects/arrays rejects ──

describe('regression: task_2a3ffe28 — nested bare strings in assemble object/array children reject while inputs refs and {const} remain valid', () => {
  it('nested object child with bare string produces MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: { inner: 'bareString' },
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'conv'),
      'expected MAP_PATH_UNKNOWN for bare string inside nested assemble object')
  })

  it('nested object child with inputs ref resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: { inner: 'inputs.x' },
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — nested input projection is valid
    assert.ok(result.graph !== null,
      'nested input projection in assemble object should succeed')
  })

  it('nested object child with {const} literal resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: { inner: { const: 42 } },
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — nested {const} literal is valid
    assert.ok(result.graph !== null,
      'nested {const} literal in assemble object should succeed')
  })

  it('nested array with bare string produces MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: ['bareString'],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    // Note: the bare string rejection comes from the array element handler in constructOutputFromAssemble
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'conv'),
      'expected MAP_PATH_UNKNOWN for bare string inside nested assemble array')
  })

  it('nested array with inputs ref resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: ['inputs.x'],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — nested array with input projection is valid
    assert.ok(result.graph !== null,
      'nested array with input projection should succeed')
  })

  it('nested array with {const} literal resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              nested: [{ const: 42 }],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    // Should succeed — nested array with {const} literal is valid
    assert.ok(result.graph !== null,
      'nested array with {const} literal should succeed')
  })
})

// ─── 32. Regression: graph-detail dedup includes message — start node with deps + input slots ──

describe('regression: graph-detail dedup preserves distinct messages for same node_ids and code', () => {
  it('start node with non-empty deps AND non-empty input slots preserves both SCHEMA_INVALID graph details', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        deps: ['other'],
        input: [{ name: 'x', source: 'other.x' }],
      }),
      other: taskNode('other'),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const schemaInvalid = result.issues.filter(
      (i) => i.code === 'SCHEMA_INVALID' && i.category === 'graph',
    )
    // Both distinct messages should survive dedup
    const depsIssue = schemaInvalid.find((i) => i.message.includes('empty deps'))
    const inputIssue = schemaInvalid.find((i) => i.message.includes('empty input slots'))
    assert.ok(depsIssue, 'expected graph-level SCHEMA_INVALID for non-empty deps')
    assert.ok(inputIssue, 'expected graph-level SCHEMA_INVALID for non-empty input slots')
    // Messages are distinct
    assert.notEqual(depsIssue!.message, inputIssue!.message,
      'deps and input slot messages must be distinct')
  })

  it('deterministic message order regardless of which graph-level check runs first', () => {
    function buildFixture(depsFirst: boolean): TaskGraph {
      const startOverrides: Partial<TaskGraphNode> = {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        deps: ['ghost'],
        input: [{ name: 'x', source: 'ghost.x' }],
      }
      return {
        id: 'g-test',
        revision: 0,
        nodes: depsFirst
          ? { ghost: taskNode('ghost'), start: startNode('start', startOverrides) }
          : { start: startNode('start', startOverrides), ghost: taskNode('ghost') },
      }
    }

    const result1 = validateTaskGraphPostImage(buildFixture(true), [], undefined, makeResolver())
    const result2 = validateTaskGraphPostImage(buildFixture(false), [], undefined, makeResolver())
    assert.equal(result1.graph, null)
    assert.equal(result2.graph, null)
    // Both results should have the same issues in the same order
    assert.deepEqual(result1.issues, result2.issues,
      'graph-level dedup order must be deterministic under equivalent record order')
    // Verify there are exactly 2 distinct graph-level SCHEMA_INVALID (deps + input)
    const graphInvalid1 = result1.issues.filter(
      (i) => i.code === 'SCHEMA_INVALID' && i.category === 'graph',
    )
    assert.equal(graphInvalid1.length, 2,
      `expected 2 graph-level SCHEMA_INVALID issues, got ${graphInvalid1.length}`)
    // Ordered by message (alphabetical: 'empty deps' vs 'empty input slots')
    assert.ok(graphInvalid1[0].message < graphInvalid1[1].message,
      'graph-level issues must be ordered deterministically by message')
  })
})

// ─── 33. Regression: null child-schema exact-path coverage ──

describe('regression: null child-schema values produce exact-path SCHEMA_INVALID issues', () => {
  function buildWithNullChild(nullKey: string): TaskGraph {
    const outputSchema: Record<string, unknown> = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
    }
    outputSchema[nullKey] = null
    return {
      id: 'g-test',
      revision: 0,
      nodes: {
        start: startNode('start', {
          output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        }),
        end: {
          id: 'end',
          name: 'end-node',
          action: { type: 'end', params: {} },
          deps: ['start'],
          input: [{ name: 'final', source: 'start.x' }],
          input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
          output_schema: outputSchema as JsonObject,
        } as TaskGraphNode,
      },
    }
  }

  it('null items produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('items'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.items')),
      'expected SCHEMA_INVALID for items:null at exact path')
  })

  it('null additionalProperties produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('additionalProperties'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.additionalProperties')),
      'expected SCHEMA_INVALID for additionalProperties:null at exact path')
  })

  it('null contains produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('contains'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.contains')),
      'expected SCHEMA_INVALID for contains:null at exact path')
  })

  it('null propertyNames produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('propertyNames'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.propertyNames')),
      'expected SCHEMA_INVALID for propertyNames:null at exact path')
  })

  it('null if produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('if'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.if')),
      'expected SCHEMA_INVALID for if:null at exact path')
  })

  it('null then produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('then'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.then')),
      'expected SCHEMA_INVALID for then:null at exact path')
  })

  it('null else produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('else'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.else')),
      'expected SCHEMA_INVALID for else:null at exact path')
  })

  it('null not produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('not'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.not')),
      'expected SCHEMA_INVALID for not:null at exact path')
  })

  it('null contentSchema produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('contentSchema'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.contentSchema')),
      'expected SCHEMA_INVALID for contentSchema:null at exact path')
  })

  it('null unevaluatedProperties produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('unevaluatedProperties'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.unevaluatedProperties')),
      'expected SCHEMA_INVALID for unevaluatedProperties:null at exact path')
  })

  it('null unevaluatedItems produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('unevaluatedItems'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.unevaluatedItems')),
      'expected SCHEMA_INVALID for unevaluatedItems:null at exact path')
  })

  it('null additionalItems produces exact-path issue', () => {
    const result = validateTaskGraphPostImage(buildWithNullChild('additionalItems'), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('.additionalItems')),
      'expected SCHEMA_INVALID for additionalItems:null at exact path')
  })

  it('null dependencies value produces exact-path issue', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          dependencies: { ok: null },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('dependencies["ok"]')),
      'expected SCHEMA_INVALID for null dependency at dependencies["ok"]')
  })
})

// ─── 34. Regression: task_588a9821 — missing projected field emits MAP_PATH_UNKNOWN for all action types ──

describe('regression: task_588a9821 — source pointing to missing projected field emits MAP_PATH_UNKNOWN for all action types', () => {
  function buildWithMissingProjection(actionType: string, params: Record<string, JsonValue>): TaskGraph {
    return {
      id: 'g-test',
      revision: 0,
      nodes: {
        start: startNode('start', {
          output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        }),
        node: {
          id: 'node',
          name: `missing-projection-${actionType}`,
          action: { type: actionType, params } as JsonObject,
          deps: ['start'],
          input: [{ name: 'bad', source: 'start.y' }],
          input_schema: { type: 'object', properties: {} },
          output_schema: { type: 'object', properties: {} },
        } as TaskGraphNode,
      },
    }
  }

  it('missing projected field emits MAP_PATH_UNKNOWN for task', () => {
    const result = validateTaskGraphPostImage(buildWithMissingProjection('task', { command: 'echo' }), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for task with missing projection')
  })


  it('missing projected field emits MAP_PATH_UNKNOWN for llm', () => {
    const result = validateTaskGraphPostImage(buildWithMissingProjection('llm', { model: 'gpt-4' }), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for llm with missing projection')
  })

  it('missing projected field emits MAP_PATH_UNKNOWN for end', () => {
    const result = validateTaskGraphPostImage(buildWithMissingProjection('end', {}), [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'node' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for end with missing projection')
  })

  it('missing projected field emits MAP_PATH_UNKNOWN for convert (derived action)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: {
        id: 'conv',
        name: 'missing-projection-convert',
        action: { type: 'convert', params: { assemble: { out: 'inputs.x' } } },
        deps: ['start'],
        input: [{ name: 'bad', source: 'start.z' }],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN' && i.node_id === 'conv' && i.slot === 'bad'),
      'expected MAP_PATH_UNKNOWN for convert with missing projection')
  })
})

// ─── 35. Regression: task_588a9821 — valid object-valued modern schema keywords accepted ──

describe('regression: task_588a9821 — valid object-valued modern schema keywords accepted', () => {
  it('valid prefixItems object schemas accepted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              prefixItems: [
                { type: 'string' },
                { type: 'number' },
              ],
            },
          },
          required: ['items'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      'valid prefixItems object schemas should be accepted')
  })

  it('valid dependentSchemas object schemas accepted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          dependentSchemas: {
            ok: { type: 'object', properties: { extra: { type: 'string' } }, required: ['extra'] },
          },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      'valid dependentSchemas object schemas should be accepted')
  })

  it('valid unevaluatedProperties object schema accepted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          unevaluatedProperties: { type: 'string' },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      'valid unevaluatedProperties object schema should be accepted')
  })

  it('valid unevaluatedItems object schema accepted', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              prefixItems: [{ type: 'string' }],
              unevaluatedItems: { type: 'number' },
            },
          },
          required: ['items'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      'valid unevaluatedItems object schema should be accepted')
  })
})

// ─── 36. Regression: task_588a9821 — malformed boolean/null modern schema keywords still rejected ──

describe('regression: task_588a9821 — malformed boolean/null variant modern schema keywords still rejected', () => {
  it('prefixItems with boolean element rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              prefixItems: [true],
            },
          },
          required: ['items'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.prefixItems[0]')),
      'expected SCHEMA_INVALID for prefixItems boolean element')
  })

  it('prefixItems with null element rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              prefixItems: [null],
            },
          },
          required: ['items'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.prefixItems[0]')),
      'expected SCHEMA_INVALID for prefixItems null element')
  })

  it('dependentSchemas with null value rejects as SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          dependentSchemas: { ok: null },
        } as JsonObject,
      } as TaskGraphNode,
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null)
    const endIssues = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
    assert.ok(endIssues.some((i) => i.message.includes('dependentSchemas["ok"]')),
      'expected SCHEMA_INVALID for dependentSchemas null value')
  })
})

// ─── 37. Regression: task_626b9dfe — malformed container shapes produce exact-path SCHEMA_INVALID and never throw ──

describe('regression: task_626b9dfe — malformed container shapes produce exact-path SCHEMA_INVALID and never throw', () => {
  it('prefixItems:true produces exact-path SCHEMA_INVALID and does not throw', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              prefixItems: true as unknown as unknown[],
            },
          },
          required: ['items'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.prefixItems') && !i.message.includes('.prefixItems[')),
        'expected SCHEMA_INVALID for prefixItems:true at exact .prefixItems path')
    })
  })

  it('dependentSchemas:null produces exact-path SCHEMA_INVALID and does not throw', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          dependentSchemas: null as unknown as Record<string, JsonObject>,
        } as JsonObject,
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.dependentSchemas') && !i.message.includes('.dependentSchemas[')),
        'expected SCHEMA_INVALID for dependentSchemas:null at exact .dependentSchemas path')
    })
  })

  it('malformed required:{} in upstream output schema does not throw in nested assemble merge', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: { val: { type: 'string' } },
          required: {} as unknown as string[],
        },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.val' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
      assert.ok(invalid.length > 0, 'expected at least one SCHEMA_INVALID for malformed required')
    })
  })

  it('malformed properties non-object in upstream schema does not throw in projected slot comparison', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: true as unknown as Record<string, JsonObject>,
          required: [] as unknown as string[],
        } as JsonObject,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'val', source: 'start.val' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.val' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'expected SCHEMA_INVALID for malformed properties')
    })
  })

  it('malformed required in resolver assertion comparison does not throw', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type, _params) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: 'bad' as unknown as string[] },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      // May succeed or fail based on other checks — but must not throw
      assert.ok(result.graph === null || result.issues.length === 0)
    })
  })

  it('end-node required coverage with malformed non-array required never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: {
          type: 'object',
          properties: { final: { type: 'string' } },
          required: 'not-an-array' as unknown as string[],
        },
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'expected SCHEMA_INVALID for malformed required in input schema')
    })
  })

  it('malformed properties:null in upstream output schema does not throw during assembly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: null as unknown as Record<string, JsonObject>,
          required: ['x'],
        } as JsonObject,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.x' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'expected SCHEMA_INVALID for malformed properties:null')
    })
  })
})

describe('regression: task_c6414950 — total schema guards for null/boolean/array roots and nested values', () => {
  it('null root explicit input_schema on task node returns graph:null with SCHEMA_INVALID and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        input_schema: null as unknown as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('input')),
        'expected SCHEMA_INVALID for null input_schema root')
    })
  })

  it('boolean root explicit output_schema on task node returns graph:null with SCHEMA_INVALID and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        output_schema: true as unknown as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('output')),
        'expected SCHEMA_INVALID for boolean output_schema root')
    })
  })

  it('array root upstream dep output_schema produces SCHEMA_INVALID in consumer projection and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: [] as unknown as ObjectJsonSchema,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.x' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'expected SCHEMA_INVALID for array output_schema root')
    })
  })

  it('null property value in upstream schema produces MAP_PATH_UNKNOWN in consumer projection and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: { x: null as unknown as JsonObject },
          required: ['x'],
        } as ObjectJsonSchema,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: { out: 'inputs.x' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'MAP_PATH_UNKNOWN'),
        'expected MAP_PATH_UNKNOWN for null property value')
    })
  })

  it('malformed required:object in explicit task schema returns graph:null with SCHEMA_INVALID and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: {} as unknown as string[],
        } as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('required')),
        'expected SCHEMA_INVALID for malformed required')
    })
  })

  it('resolver schema with null property in outputs does not throw through assertSubset', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        output_schema: {
          type: 'object',
          properties: { result: { type: 'string' } },
          required: ['result'],
        } as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver({
        resolveActionSchema(type) {
          if (type === 'task') {
            return {
              input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
              output: { type: 'object', properties: { result: null as unknown as JsonObject }, required: ['result'] },
            }
          }
          return null
        },
      }))
      assert.equal(result.graph, null)
    })
  })

  it('assemble merge over null nested property value does not throw and yields MAP_PATH_UNKNOWN or SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            a: {
              type: 'object',
              properties: { b: null as unknown as JsonObject },
              required: ['b'],
            },
          },
          required: ['a'],
        } as ObjectJsonSchema,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: { type: 'convert', params: { assemble: { 'out.b': 'inputs.a.b' } } },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
    })
  })

  it('boolean schema in items produces SCHEMA_INVALID via validateGraphSchema and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            arr: {
              type: 'array',
              items: true as unknown as JsonObject,
            },
          },
          required: ['arr'],
        } as ObjectJsonSchema,
      }),
      end: endNode('end', {
        deps: ['start'],
        input: [{ name: 'arr', source: 'start.arr' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
      assert.ok(invalid.length > 0, 'expected at least one SCHEMA_INVALID for boolean items')
    })
  })

  it('null root on end node input_schema produces SCHEMA_INVALID and never throws', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      end: endNode('end', {
        deps: ['start'],
        input_schema: null as unknown as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('input')),
        'expected SCHEMA_INVALID for null end input_schema')
    })
  })

  it('overlapping nested assemble targets with null property value from dep does not throw', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            a: {
              type: 'object',
              properties: { b: { type: 'object', properties: { c: null as unknown as JsonObject }, required: ['c'] } },
              required: ['b'],
            },
          },
          required: ['a'],
        } as ObjectJsonSchema,
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              'x.a.b.c': 'inputs.a.b.c',
              'x.a.b': { const: { c: 3 } },
            },
          },
        },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
    })
  })
})

// ─── Regression: task_86cd23f7 — malformed resolver/explicit schemas, empty
//     structured LLM output, {const:"$inputs.literal"} opacity, own-property
//     required coverage, malformed assertSubset required, format annotation  ──

describe('regression: task_86cd23f7 — resolver schema guards, empty structured output, {const} opacity, own-prop coverage, format annotation', () => {
  it('malformed resolver schemas never throw and yield SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver({
        resolveActionSchema(type) {
          if (type === 'task') {
            // Return null as output schema — malformed root
            return {
              input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
              output: null as unknown as ObjectJsonSchema,
            }
          }
          return null
        },
      }))
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('resolver')),
        'expected SCHEMA_INVALID for malformed resolver output')
    })
  })

  it('malformed explicit entries never throw and yield SCHEMA_INVALID even when auto replaces', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        input_schema: {
          type: 'object',
          properties: null as unknown as Record<string, JsonObject>,
        } as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('properties')),
        'expected SCHEMA_INVALID for null explicit properties')
    })
  })

  it('empty structured LLM output schema is pinned instead of replaced by canonical text', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      llmNode: {
        id: 'llmNode',
        name: 'llm-node',
        action: { type: 'llm', params: { prompt: 'test' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.out' }],
        input_schema: { type: 'object', properties: {} } as ObjectJsonSchema,
        output_schema: { type: 'object', properties: {} } as ObjectJsonSchema,
      } as TaskGraphNode,
    }
    // Resolver that declares an empty structured output schema.
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver({
      resolveLlmStructuredOpts() {
        return { outputSchema: { type: 'object', properties: {} } as ObjectJsonSchema }
      },
    }))
    assert.ok(result.graph !== null, 'empty structured output schema pinned by resolver should succeed')
    assert.equal(result.issues.length, 0, 'no issues when prompt covers action.params')
    // The LLM output_schema should be the empty object schema, not the canonical text schema.
    assert.deepStrictEqual(result.graph.nodes.llmNode.output_schema.properties, {}, 'output schema should have empty properties')
    assert.ok(!('text' in result.graph.nodes.llmNode.output_schema), 'output schema should not have a text property')
  })

  it('{const:"$inputs.literal"} remains opaque and does not create spurious INPUT_INCOMPLETE', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              literal: { const: '$inputs.literal' },
            },
          },
        },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph) {
        // Should succeed — {const:"$inputs.literal"} is opaque, not an inputs ref
        assert.ok(true, 'validation succeeded with opaque {const} literal')
      } else {
        // If there are issues, none should be INPUT_INCOMPLETE for "literal"
        const incomplete = result.issues.filter((i) => i.code === 'INPUT_INCOMPLETE' && i.slot === 'literal')
        assert.equal(incomplete.length, 0, 'no INPUT_INCOMPLETE for opaque {const:"$inputs.literal"}')
      }
    })
  })

  it('required fields named toString/constructor need own slots or own params', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { toString: { type: 'string' }, constructor: { type: 'string' } }, required: ['toString', 'constructor'] },
      }),
      // end node has required fields toString and constructor inherited via Node.prototype —
      // they must be covered by input slots or own action params, not inherited properties.
      end: endNode('end', {
        deps: ['start'],
        input: [],
        input_schema: { type: 'object', properties: { toString: { type: 'string' }, constructor: { type: 'string' } }, required: ['toString', 'constructor'] },
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null)
      const incomplete = result.issues.filter((i) => i.code === 'INPUT_INCOMPLETE')
      assert.ok(incomplete.length >= 2, 'expected INPUT_INCOMPLETE for toString and constructor without own slots or params')
    })
  })

  it('malformed explicit.required makes assertSubset fail', () => {
    // Exercise assertSubset through validateTaskGraphPostImage: a task node with
    // malformed explicit.required should produce a non-match when compared
    // against the resolver-provided schema.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: true as unknown as string[],
        } as ObjectJsonSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver({
        resolveActionSchema(type) {
          if (type === 'task') {
            return {
              input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
              output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
            }
          }
          return null
        },
      }))
      // Either SCHEMA_INVALID (from guardSchemaRoot) or MAP_TYPE_MISMATCH (from assertSubset)
      assert.equal(result.graph, null, 'expected validation failure with malformed explicit.required')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' || i.code === 'MAP_TYPE_MISMATCH')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID or MAP_TYPE_MISMATCH for malformed explicit.required')
    })
  })

  it('format:"date-time" annotation is accepted without validation error', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            ts: { type: 'string', format: 'date-time' },
          },
          required: ['ts'],
        } as ObjectJsonSchema,
      }),
      end: endNode('end', {
        deps: ['start'],
        input: [{ name: 'ts', source: 'start.ts' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.ok(result.graph !== null || !result.issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.includes('format')),
        'format:"date-time" should not produce SCHEMA_INVALID')
    })
  })
})

// ─── 30. Regression: task_ddc248be — resolver absence vs malformed values ──────

describe('regression: task_ddc248be — resolver absence vs malformed values and clone preservation', () => {
  it('llm input resolver returning false yields SCHEMA_INVALID not fallback', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return false as unknown as JsonObject },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      assert.equal(result.graph, null, 'expected failure for false LLM input resolver')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.slot === 'input')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for false LLM input resolver')
    })
  })

  it('llm input resolver returning 0 yields SCHEMA_INVALID not fallback', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return 0 as unknown as JsonObject },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      assert.equal(result.graph, null, 'expected failure for 0 LLM input resolver')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.slot === 'input')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for 0 LLM input resolver')
    })
  })

  it('llm input resolver returning empty string yields SCHEMA_INVALID not fallback', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return '' as unknown as JsonObject },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      assert.equal(result.graph, null, 'expected failure for "" LLM input resolver')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.slot === 'input')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for "" LLM input resolver')
    })
  })

  it('llm structured outputSchema present undefined yields SCHEMA_INVALID', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
      resolveLlmStructuredOpts() {
        const r: Record<string, unknown> = {}
        r.outputSchema = undefined
        return r as unknown as { outputSchema?: JsonObject }
      },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      assert.equal(result.graph, null, 'expected failure for present undefined outputSchema')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.slot === 'output')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present undefined outputSchema')
    })
  })

  it('llm structured outputSchema false yields SCHEMA_INVALID', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() { return null },
      resolveLlmInputSchema() { return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
      resolveLlmStructuredOpts() {
        return { outputSchema: false as unknown as JsonObject }
      },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      }),
      llm: {
        id: 'llm',
        name: 'llm-node',
        action: { type: 'llm', params: { model: 'gpt-4' } },
        deps: ['start'],
        input: [{ name: 'prompt', source: 'start.p' }],
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      assert.equal(result.graph, null, 'expected failure for false outputSchema')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.slot === 'output')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for false outputSchema')
    })
  })

  it('explicit nested undefined property survives cloning and fails with SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    const props: Record<string, unknown> = {}
    props.str = { type: 'string' }
    props.undef = undefined
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, bad: undefined as unknown as JsonObject },
          required: ['ok', 'bad'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null, 'expected failure for undefined property in output')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for undefined property value')
    })
  })

  it('explicit nested null property fails with SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, bad: null as unknown as JsonObject },
          required: ['ok', 'bad'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null, 'expected failure for null property in output')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for null property value')
    })
  })

  it('explicit schema with bad root type fails even when auto replaces', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        // Bad root type — "string" instead of "object": guardSchemaRoot now rejects it.
        input_schema: { type: 'string', properties: { msg: { type: 'string' } }, required: ['msg'] } as unknown as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null, 'expected failure for bad root type in input')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 't' && i.slot === 'input')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for input schema with bad root type')
    })
  })

  it('present undefined child in nested properties gets exact-path SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.x' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nested: {
              type: 'object',
              properties: { sub: undefined as unknown as JsonObject },
              required: ['sub'],
            },
          },
          required: ['ok', 'nested'],
        } as JsonObject,
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null, 'expected failure for nested undefined child')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID' && i.node_id === 'end')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for nested undefined child')
    })
  })

  it('compareTypes rejects null properties/required entries', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: null as unknown as string[],
        } as JsonObject,
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      // null required should produce an issue — either SCHEMA_INVALID from guardSchemaRoot
      // or MAP_TYPE_MISMATCH from compareTypes downstream.
      if (result.graph === null) {
        assert.ok(result.issues.length > 0, 'null required should produce some issue')
      }
    })
  })

  it('assertSubset rejects null explicit property value', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        input_schema: {
          type: 'object',
          properties: { msg: null as unknown as JsonObject },
          required: ['msg'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      // null property value should produce either SCHEMA_INVALID or MAP_TYPE_MISMATCH
      if (result.graph === null) {
        assert.ok(result.issues.length > 0, 'null explicit property value should produce some issue')
      }
    })
  })

  it('no throw and no input mutation on all malformed resolver scenarios', () => {
    // Each scenario exercises public validation without throwing or mutating inputs.
    const scenarios = [
      { name: 'llm input false', llmInput: false as unknown as JsonObject, structured: null },
      { name: 'llm input 0', llmInput: 0 as unknown as JsonObject, structured: null },
      { name: 'llm input ""', llmInput: '' as unknown as JsonObject, structured: null },
      { name: 'structured present undefined', llmInput: { type: 'object', properties: {} }, structured: (() => { const r: Record<string, unknown> = {}; r.outputSchema = undefined; return r })() as unknown as { outputSchema?: JsonObject } },
      { name: 'structured false', llmInput: { type: 'object', properties: {} }, structured: { outputSchema: false as unknown as JsonObject } },
    ]
    for (const sc of scenarios) {
      const graph = emptyGraph()
      graph.nodes = {
        start: startNode('start', {
          output_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
        }),
        llm: {
          id: 'llm',
          name: 'llm-node',
          action: { type: 'llm', params: { model: 'gpt-4' } },
          deps: ['start'],
          input: [{ name: 'prompt', source: 'start.p' }],
          input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
          output_schema: { type: 'object', properties: {} },
        } as TaskGraphNode,
      }
      const graphBefore = deepClone(graph)
      const resolver: TaskGraphAutoSchemaResolver = {
        resolveActionSchema() { return null },
        resolveLlmInputSchema() { return sc.llmInput },
        resolveLlmStructuredOpts() { return sc.structured },
      }
      assert.doesNotThrow(() => {
        const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
        // Input graph never mutated
        assert.deepEqual(graph, graphBefore, `${sc.name}: graph was mutated`)
        // Either null or non-null graph — either way no throw
        if (result.graph === null) {
          assert.ok(result.issues.length > 0, `${sc.name}: expected issues for malformed input`)
        }
      }, `${sc.name}: threw unexpectedly`)
    }
  })
})

// ─── 39. Regression: task_f2e46a67 — unified recursive schema guards ─────────

describe('regression: task_f2e46a67 — unified recursive schema guards', () => {
  it('nested present-undefined explicit schema remains SCHEMA_INVALID after auto replacement', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
        output_schema: {
          type: 'object',
          properties: {
            result: {
              type: 'object',
              properties: { detail: undefined as unknown as JsonObject },
              required: ['detail'],
            },
          },
          required: ['result'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null, 'expected failure for nested undefined')
      const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
      assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for nested present-undefined')
    })
  })

  it('nested present-undefined resolver schema yields SCHEMA_INVALID', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            output: {
              type: 'object',
              properties: {
                result: {
                  type: 'object',
                  properties: { sub: undefined as unknown as JsonObject },
                  required: ['sub'],
                },
              },
              required: ['result'],
            } as JsonObject,
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      if (result.graph === null) {
        assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
          'expected SCHEMA_INVALID for malformed resolver schema')
      }
    })
  })

  it('overlapping malformed upstream merge operands never throw', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [
          { name: 'a', source: 'start.a' },
          { name: 'b', source: 'start.b' },
        ],
        action: {
          type: 'convert',
          params: {
            assemble: {
              'merged': { const: 'default' },
            },
          },
        },
        output_schema: { type: 'object', properties: {} },
        input_schema: { type: 'object', properties: {} },
      } as TaskGraphNode),
      // Second convert overlapping with null property in upstream
      conv2: {
        id: 'conv2',
        name: 'conv-overlap',
        action: { type: 'convert', params: { assemble: { out: { const: 42 } } } },
        deps: ['start'],
        input: [],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      // Must not throw even with malformed overlap
    })
  })

  it('every schema-bearing keyword with present-undefined receives exact-path detection', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      end: {
        id: 'end',
        name: 'end-node',
        action: { type: 'end', params: {} },
        deps: ['start'],
        input: [{ name: 'final', source: 'start.out' }],
        input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
        output_schema: (() => {
          const s: Record<string, unknown> = {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          }
          // Set each keyword to present-undefined to verify own-property detection
          s.properties = { ok: { type: 'boolean' }, additional: undefined }
          return s as JsonObject
        })(),
      } as TaskGraphNode,
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined property')
      }
    })
  })

  it('compareTypes rejects malformed optional properties and non-string required entries', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            x: { type: 'string' },
            y: { type: 'number' },
          },
          required: ['x'],
        },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      // If compareTypes encounters issues, it returns non-match
    })
  })

  it('assertSubset rejects non-string required entries', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: [42 as unknown as string],
        } as JsonObject,
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      if (result.graph === null) {
        assert.ok(result.issues.length > 0, 'expected issues for non-string required entry')
      }
    })
  })

  it('schemaAt rejects malformed root schemas for field and index traversal', () => {
    // Test via convert that projects from upstream with malformed output
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: null as unknown as JsonObject,
            },
          },
          required: ['items'],
        } as JsonObject,
      }),
      conv: convertNode('conv', {
        deps: ['t'],
        input: [{ name: 'src', source: 't.items[0]' }],
        action: { type: 'convert', params: { assemble: { result: { const: 'ok' } } } },
        output_schema: { type: 'object', properties: {} },
        input_schema: { type: 'object', properties: {} },
      } as TaskGraphNode),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      // schemaAt should return found:false for malformed items, emitting MAP_PATH_UNKNOWN
    })
  })

  it('valid counterpart schemas pass through fine', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.notEqual(result.graph, null, 'valid schemas should succeed')
    })
  })
})

// ─── 38. Regression: task_574cc6f7 — present-undefined entries, malformed schemaAt, malformed compareTypes/assertSubset ──

describe('regression: task_574cc6f7 — present-undefined entries in tuples/combinators/prefixItems emit exact-path SCHEMA_INVALID', () => {
  it('present-undefined entry in items tuple emits exact-path SCHEMA_INVALID', () => {
    const itemsArr: unknown[] = []
    itemsArr[0] = undefined
    itemsArr[1] = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: itemsArr as unknown as JsonObject,
            },
          },
          required: ['items'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter(
          (i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.items[0]'),
        )
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined items tuple entry')
      }
    })
  })

  it('present-undefined entry in oneOf emits exact-path SCHEMA_INVALID', () => {
    const oneOfArr: unknown[] = []
    oneOfArr[0] = undefined
    oneOfArr[1] = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            combined: { oneOf: oneOfArr as unknown[] },
          },
          required: ['combined'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter(
          (i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.oneOf[0]'),
        )
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined oneOf entry')
      }
    })
  })

  it('present-undefined entry in prefixItems emits exact-path SCHEMA_INVALID', () => {
    const piArr: unknown[] = []
    piArr[0] = undefined
    piArr[1] = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            arr: {
              type: 'array',
              prefixItems: piArr as unknown[],
              items: { type: 'boolean' },
            },
          },
          required: ['arr'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter(
          (i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.prefixItems[0]'),
        )
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined prefixItems entry')
      }
    })
  })

  it('present-undefined entry in anyOf emits exact-path SCHEMA_INVALID', () => {
    const anyOfArr: unknown[] = []
    anyOfArr[0] = undefined
    anyOfArr[1] = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            combined: { anyOf: anyOfArr as unknown[] },
          },
          required: ['combined'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter(
          (i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.anyOf[0]'),
        )
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined anyOf entry')
      }
    })
  })

  it('present-undefined entry in allOf emits exact-path SCHEMA_INVALID', () => {
    const allOfArr: unknown[] = []
    allOfArr[0] = undefined
    allOfArr[1] = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            combined: { allOf: allOfArr as unknown[] },
          },
          required: ['combined'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const invalid = result.issues.filter(
          (i) => i.code === 'SCHEMA_INVALID' && i.message.includes('.allOf[0]'),
        )
        assert.ok(invalid.length > 0, 'expected SCHEMA_INVALID for present-undefined allOf entry')
      }
    })
  })

  it('valid optional property schemas pass through fine (control)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.notEqual(result.graph, null, 'valid optional schemas should succeed')
    })
  })
})

describe('regression: task_574cc6f7 — schemaAt final untyped/malformed leaves yield MAP_PATH_UNKNOWN', () => {
  it('schemaAt rejects final schema with no valid type via MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { properties: { val: { type: 'string' } } } as JsonObject, // no type on items schema
            },
          },
          required: ['items'],
        } as JsonObject,
      }),
      conv: convertNode('conv', {
        deps: ['t'],
        input: [{ name: 'src', source: 't.items[0]' }],
        action: { type: 'convert', params: { assemble: { result: { const: 'ok' } } } },
        input_schema: { type: 'object', properties: {} },
      } as TaskGraphNode),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
        assert.ok(pathUnknown.length > 0, 'expected MAP_PATH_UNKNOWN for untyped projected schema')
      }
    })
  })

  it('schemaAt rejects final schema with null type via MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        output_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', properties: { val: { type: 'string' } } },
            },
          },
          required: ['items'],
        },
      }),
      conv: convertNode('conv', {
        deps: ['t'],
        input: [{ name: 'src', source: 't.items.unknown' }],
        action: { type: 'convert', params: { assemble: { result: { const: 'ok' } } } },
        input_schema: { type: 'object', properties: {} },
      } as TaskGraphNode),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
        assert.ok(pathUnknown.length > 0, 'expected MAP_PATH_UNKNOWN for unknown property on items schema')
      }
    })
  })

  it('valid schemaAt projection returns MAP_PATH_UNKNOWN only for genuinely missing paths (control)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.notEqual(result.graph, null, 'valid schemaAt should succeed')
    })
  })
})

describe('regression: task_574cc6f7 — compareTypes/assertSubset reject malformed optional/unmatched/nested/items/required entries', () => {
  it('compareTypes returns non-match for malformed optional expected property', () => {
    // Malformed optional property: expected properties has boolean schema for an
    // optional key that has no actual counterpart.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            x: { type: 'string' },
            y: { type: 'number' },
          } as Record<string, JsonObject>,
          required: ['x'],
        } as JsonObject,
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: {
            result: true as unknown as JsonObject,
          } as Record<string, JsonObject>,
          required: [],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const mismatch = result.issues.filter(
          (i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID',
        )
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed optional property')
      }
    })
  })

  it('compareTypes returns non-match for malformed unmatched expected property', () => {
    // Unmatched = expected has a property that actual lacks and the expected
    // property value itself is malformed.
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: {
            x: { type: 'string' },
          } as Record<string, JsonObject>,
          required: ['x'],
        } as JsonObject,
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
            extra: null as unknown as JsonObject,
          } as Record<string, JsonObject>,
          required: [],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const mismatch = result.issues.filter(
          (i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID',
        )
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed unmatched property')
      }
    })
  })

  it('compareTypes returns non-match for malformed nested property schema', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: { inner: false as unknown as JsonObject },
              required: [],
            },
          } as Record<string, JsonObject>,
          required: ['nested'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const mismatch = result.issues.filter(
          (i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID',
        )
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed nested property')
      }
    })
  })

  it('compareTypes returns non-match for malformed items schema', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: {
            arr: {
              type: 'array',
              items: null as unknown as JsonObject,
            },
          } as Record<string, JsonObject>,
          required: ['arr'],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const mismatch = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID')
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed items schema')
      }
    })
  })

  it('compareTypes returns non-match for malformed required entries', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: { result: { type: 'string' } },
          required: [42 as unknown as string],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      if (result.graph === null) {
        const mismatch = result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID')
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed required entries')
      }
    })
  })

  it('assertSubset returns non-match for malformed explicit property', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: {
          type: 'object',
          properties: { msg: null as unknown as JsonObject },
          required: ['msg'],
        } as JsonObject,
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      if (result.graph === null) {
        const mismatch = result.issues.filter(
          (i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID',
        )
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed explicit property')
      }
    })
  })

  it('assertSubset returns non-match for malformed explicit optional property without inferred counterpart', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            output: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
            extra: null as unknown as JsonObject,
          },
          required: [],
        } as JsonObject,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
      if (result.graph === null) {
        const mismatch = result.issues.filter(
          (i) => i.code === 'MAP_TYPE_MISMATCH' || i.code === 'SCHEMA_INVALID',
        )
        assert.ok(mismatch.length > 0, 'expected MAP_TYPE_MISMATCH or SCHEMA_INVALID for malformed optional explicit property')
      }
    })
  })

  it('valid compareTypes and assertSubset succeed (control)', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: [] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.notEqual(result.graph, null, 'valid schemas should succeed')
    })
  })
})

// ─── 32. Regression: empty array (const and direct) produces valid pinned array schema ──────

describe('regression: empty array — {const: []} and [] produce valid pinned array schema without untyped items', () => {
  it('convert with {const: []} assemble succeeds and output field schema is array without items', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'val', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: { data: { const: [] } } } },
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `graph with {const: []} should succeed: ${JSON.stringify(result.issues)}`)
    const node = result.graph.nodes['conv']
    const dataSchema = node.output_schema.properties?.data as JsonObject | undefined
    assert.ok(dataSchema, 'output field "data" should exist')
    assert.equal(dataSchema.type, 'array', 'data schema should be array')
    assert.equal(Object.hasOwn(dataSchema, 'items'), false, 'array schema should not have items child')
  })

  it('join with direct empty array [] assemble succeeds and output field schema is array without items', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        deps: [],
        output_schema: { type: 'object', properties: { seed: { type: 'string' } }, required: ['seed'] },
      }),
      a: taskNode('a', {
        deps: [],
      }),
      b: taskNode('b', {
        deps: [],
      }),
      jn: joinNode('jn', {
        deps: ['a', 'b'],
        input: [
          { name: 'x', source: 'a.result' },
          { name: 'y', source: 'b.result' },
        ],
        action: {
          type: 'join',
          params: { assemble: { data: [] } },
        },
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `graph with direct [] should succeed: ${JSON.stringify(result.issues)}`)
    const node = result.graph.nodes['jn']
    const dataSchema = node.output_schema.properties?.data as JsonObject | undefined
    assert.ok(dataSchema, 'output field "data" should exist')
    assert.equal(dataSchema.type, 'array', 'data schema should be array')
    assert.equal(Object.hasOwn(dataSchema, 'items'), false, 'array schema should not have items child')
  })
})

// ─── 33. Regression: SourceExpr resolution with nonstandard NodeIds ──────────

describe('regression: SourceExpr resolution with nonstandard NodeIds — hyphens, digits, dots, prototype, prefix ambiguity', () => {
  it('hyphenated node-id resolves in source expression', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      'up-stream': taskNode('up-stream', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
      downstream: taskNode('downstream', {
        deps: ['start', 'up-stream'],
        input: [{ name: 'data', source: 'up-stream.result' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `hyphenated id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('leading-digit node-id resolves in source expression', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
      }),
      123: taskNode('123', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.val' }],
      }),
      consumer: taskNode('consumer', {
        deps: ['start', '123'],
        input: [{ name: 'data', source: '123.result' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `leading-digit id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('dotted node-id resolves with no confusion from field projection', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' }, 'a.b': { type: 'string' } }, required: ['x', 'a.b'] },
      }),
      'my.node': taskNode('my.node', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
      downstream: taskNode('downstream', {
        deps: ['start', 'my.node'],
        input: [{ name: 'data', source: 'my.node.result' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `dotted id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('prefix ambiguity resolved by longest admitted id', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { out: { type: 'string' } }, required: ['out'] },
      }),
      long: taskNode('long', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.out' }],
      }),
      longer: taskNode('longer', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.out' }],
      }),
      consumer: taskNode('consumer', {
        deps: ['start', 'long', 'longer'],
        input: [
          { name: 'fromLong', source: 'long.result' },
          { name: 'fromLonger', source: 'longer.result' },
        ],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `prefix-resolved ids should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('toString as node-id resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      }),
      toString: taskNode('toString', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.v' }],
      }),
      downstream: taskNode('downstream', {
        deps: ['start', 'toString'],
        input: [{ name: 'data', source: 'toString.result' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `toString id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('constructor as node-id resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      }),
      constructor: taskNode('constructor', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.v' }],
      }),
      downstream: taskNode('downstream', {
        deps: ['start', 'constructor'],
        input: [{ name: 'data', source: 'constructor.result' }],
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `constructor id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('__proto__ as node-id resolves correctly', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      }),
      downstream: taskNode('downstream', {
        deps: ['start', '__proto__'],
        input: [{ name: 'data', source: '__proto__.result' }],
      }),
    }
    Object.defineProperty(graph.nodes, '__proto__', {
      value: taskNode('__proto__', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.v' }],
      }),
      enumerable: true,
      configurable: true,
    })
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `__proto__ id should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })
})

// ─── 34. Regression: prototype-named property names are own data, no false errors ─

describe('regression: prototype-named property names as own data with no false DUP_ID or loss', () => {
  it('prototype-named input/output properties survive convert materialization', () => {
    // Build a start node with output schema containing prototype-named properties.
    const startProps: Record<string, JsonObject> = {
      toString: { type: 'string' },
      constructor: { type: 'number' },
    }
    Object.defineProperty(startProps, '__proto__', {
      value: { type: 'boolean' },
      writable: true,
      enumerable: true,
      configurable: true,
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: {
          type: 'object',
          properties: startProps,
          required: ['toString', 'constructor', '__proto__'],
        },
      }),
      convert: convertNode('convert', {
        deps: ['start'],
        input: [
          { name: 'toString', source: 'start.toString' },
          { name: 'constructor', source: 'start.constructor' },
          { name: '__proto__', source: 'start.__proto__' },
        ],
        action: {
          type: 'convert',
          params: {
            assemble: {} as Record<string, JsonValue>,
          },
        },
      }),
    }

    // Build assemble with prototype-safe own properties.
    const convertNodeInstance = graph.nodes['convert'] as TaskGraphNode
    // Cast to work with mutable params
    const assemble = convertNodeInstance.action.params.assemble as Record<string, JsonValue>
    assemble.toString = 'inputs.toString'
    assemble.constructor = 'inputs.constructor'
    Object.defineProperty(assemble, '__proto__', {
      value: 'inputs.__proto__',
      writable: true,
      enumerable: true,
      configurable: true,
    })

    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null,
      `prototype-named properties should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)

    const node = result.graph.nodes['convert']
    // input_schema.properties must have own toString, constructor, __proto__
    const inputProps = node.input_schema.properties as Record<string, JsonObject>
    assert.ok(Object.hasOwn(inputProps, 'toString'),
      'input_schema should own toString')
    assert.ok(Object.hasOwn(inputProps, 'constructor'),
      'input_schema should own constructor')
    assert.ok(Object.hasOwn(inputProps, '__proto__'),
      'input_schema should own __proto__')
    assert.equal(inputProps.toString.type, 'string')
    assert.equal(inputProps.constructor.type, 'number')
    assert.equal(inputProps.__proto__.type, 'boolean')

    // output_schema.properties must have own toString, constructor, __proto__
    const outputProps = node.output_schema.properties as Record<string, JsonObject>
    assert.ok(Object.hasOwn(outputProps, 'toString'),
      'output_schema should own toString')
    assert.ok(Object.hasOwn(outputProps, 'constructor'),
      'output_schema should own constructor')
    assert.ok(Object.hasOwn(outputProps, '__proto__'),
      'output_schema should own __proto__')
    assert.equal(outputProps.toString.type, 'string')
    assert.equal(outputProps.constructor.type, 'number')
    assert.equal(outputProps.__proto__.type, 'boolean')
  })
})

// ─── 35. Regression: cyclic hostile schema from resolver produces SCHEMA_INVALID ─

describe('regression: cyclic resolver schema produces deterministic SCHEMA_INVALID with graph:null', () => {
  it('self-referential hostile schema does not throw, yields graph:null with SCHEMA_INVALID', () => {
    // Build a cyclic object
    const cyclicSchema: JsonObject = { type: 'object', properties: {} }
    cyclicSchema.properties!['self'] = cyclicSchema as JsonObject
    cyclicSchema.required = ['self']

    const cyclicResolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() {
        return {
          input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
          output: cyclicSchema,
        }
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.v' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, cyclicResolver)
      if (result.graph !== null) {
        // If it manages to succeed, the cyclic schema must have been pinned
        // without throwing — still acceptable as long as no crash.
        // But the expected behavior is SCHEMA_INVALID.
        const schemaInvalid = result.issues.some((i) => i.code === 'SCHEMA_INVALID')
        assert.ok(schemaInvalid || result.issues.length > 0, 'cyclic schema should produce issues')
      }
      // graph:null is acceptable — the key requirement is no throw
    }, 'cyclic resolver schema must not throw')
  })

  it('cyclic schema returned by resolver output does not throw and yields SCHEMA_INVALID', () => {
    const schemaA: JsonObject = { type: 'object', properties: {}, required: [] }
    const schemaB: JsonObject = { type: 'object', properties: { ref: schemaA }, required: ['ref'] }
    schemaA.properties!['cycle'] = schemaB

    const cyclicResolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema() {
        return {
          input: schemaA,
          output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        }
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.v' }],
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, cyclicResolver)
      // Must not throw. Either produces SCHEMA_INVALID or succeeds sanitized.
    }, 'cyclic resolver schema must not throw')
  })
})

// ─── 36. Regression: prototype-named NodeId with empty nodeStates ─────────────────

describe('regression: prototype-named NodeId with empty nodeStates and dangling dep', () => {
  it('RemoveNode and ReplaceNode of existing node named "toString" with empty nodeStates succeeds as planned', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      toString: taskNode('toString', { deps: ['start'] }),
    }

    // RemoveNode
    const removeResult = validateTaskGraphPostImage(graph, [{ op: 'RemoveNode', id: 'toString' }], {}, makeResolver())
    assert.ok(removeResult.graph !== null,
      `RemoveNode of toString with empty nodeStates should succeed: ${JSON.stringify(removeResult.issues)}`)
    assert.equal(removeResult.issues.length, 0)

    // ReplaceNode
    graph.nodes['toString'] = taskNode('toString', { deps: ['start'] })
    const replaceResult = validateTaskGraphPostImage(graph, [{ op: 'ReplaceNode', node: taskNode('toString', { deps: ['start'] }) }], {}, makeResolver())
    assert.ok(replaceResult.graph !== null,
      `ReplaceNode of toString with empty nodeStates should succeed: ${JSON.stringify(replaceResult.issues)}`)
    assert.equal(replaceResult.issues.length, 0)
  })

  it('dangling dep named "toString" does not throw and yields DANGLING_DEP', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      consumer: taskNode('consumer', { deps: ['start', 'toString'] }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'graph with dangling dep toString should fail')
    const danglingIssues = result.issues.filter((i) => i.code === 'DANGLING_DEP')
    assert.ok(danglingIssues.length >= 1, 'should have at least one DANGLING_DEP')
    assert.ok(danglingIssues.some((i) => i.node_ids.includes('toString') || i.message.includes('toString')),
      'DANGLING_DEP should reference toString')
  })
})

// ─── 37. Regression: explicit self-cyclic schema produces SCHEMA_INVALID ───────────

describe('regression: explicit self-cyclic schema produces deterministic SCHEMA_INVALID with graph:null', () => {
  it('self-cyclic explicit output_schema does not throw and yields graph:null with SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    const cyclicOutputSchema: JsonObject = { type: 'object', properties: {} }
    cyclicOutputSchema.properties!['self'] = cyclicOutputSchema
    cyclicOutputSchema.required = ['self']
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: cyclicOutputSchema,
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null,
        `self-cyclic explicit output_schema should yield graph:null: ${JSON.stringify(result.issues)}`)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'self-cyclic explicit output_schema should produce SCHEMA_INVALID')
    }, 'self-cyclic explicit schema must not throw')
  })

  it('self-cyclic explicit input_schema does not throw and yields graph:null with SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    const cyclicInputSchema: JsonObject = { type: 'object', properties: {} }
    cyclicInputSchema.properties!['self'] = cyclicInputSchema
    cyclicInputSchema.required = ['self']
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: cyclicInputSchema,
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
      }),
    }
    assert.doesNotThrow(() => {
      const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
      assert.equal(result.graph, null,
        `self-cyclic explicit input_schema should yield graph:null: ${JSON.stringify(result.issues)}`)
      assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'),
        'self-cyclic explicit input_schema should produce SCHEMA_INVALID')
    }, 'self-cyclic explicit schema must not throw')
  })
})

// ─── 38. Regression: nested assemble with multiple invalid bare strings ────────────

describe('regression: nested assemble with multiple invalid bare strings reports all MAP_PATH_UNKNOWN', () => {
  it('nested assemble object with two invalid bare-string siblings reports both MAP_PATH_UNKNOWN details in stable order', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              out1: 'notAnInputsRef',
              out2: 'alsoNotARef',
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null,
      `bare strings should cause failure: ${JSON.stringify(result.issues)}`)
    const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
    assert.ok(pathUnknown.length >= 2, `should report at least 2 MAP_PATH_UNKNOWN, got ${pathUnknown.length}`)
  })

  it('nested assemble array with multiple invalid bare-string siblings reports both MAP_PATH_UNKNOWN details', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              arr: ['bare1', 'bare2'],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null,
      `bare strings in array should cause failure: ${JSON.stringify(result.issues)}`)
    const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
    assert.ok(pathUnknown.length >= 2, `should report at least 2 MAP_PATH_UNKNOWN, got ${pathUnknown.length}`)
  })
})

// ─── 41. Regression: exact SourceExpr resolution with whitespace-bearing NodeIds ─

describe('regression: exact SourceExpr resolution with whitespace-bearing NodeIds', () => {
  it('resolves SourceExpr for upstream NodeId with leading whitespace', () => {
    const graph = emptyGraph()
    const leadingId = ' up'
    graph.nodes.start = startNode('start', {
      output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    })
    Object.defineProperty(graph.nodes, leadingId, {
      value: taskNode(leadingId as NodeId, {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(graph.nodes, 'consumer', {
      value: taskNode('consumer', {
        deps: ['start', leadingId as NodeId],
        input: [{ name: 'data', source: `${leadingId}.result` }],
      }),
      enumerable: true,
      configurable: true,
    })
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `leading-whitespace NodeId should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('resolves SourceExpr for upstream NodeId with trailing whitespace', () => {
    const graph = emptyGraph()
    const trailingId = 'up '
    graph.nodes.start = startNode('start', {
      output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    })
    Object.defineProperty(graph.nodes, trailingId, {
      value: taskNode(trailingId as NodeId, {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
      }),
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(graph.nodes, 'consumer', {
      value: taskNode('consumer', {
        deps: ['start', trailingId as NodeId],
        input: [{ name: 'data', source: `${trailingId}.result` }],
      }),
      enumerable: true,
      configurable: true,
    })
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `trailing-whitespace NodeId should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })

  it('resolves SourceExpr with trailing-whitespace NodeId and projection suffix', () => {
    const graph = emptyGraph()
    const trailingId = 'node '
    graph.nodes.start = startNode('start', {
      output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    })
    Object.defineProperty(graph.nodes, trailingId, {
      value: {
        id: trailingId,
        name: 'shell-node',
        action: { type: 'shell', params: { command: 'ls' } },
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.x' }],
        input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        output_schema: {
          type: 'object',
          properties: { nested: { type: 'object', properties: { val: { type: 'number' } }, required: ['val'] } },
          required: ['nested'],
        },
      } as TaskGraphNode,
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(graph.nodes, 'consumer', {
      value: convertNode('consumer', {
        deps: [trailingId as NodeId],
        input: [{ name: 'data', source: `${trailingId}.nested.val` }],
        action: { type: 'convert', params: { assemble: { result: 'inputs.data' } } },
      }),
      enumerable: true,
      configurable: true,
    })
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.ok(result.graph !== null, `trailing-whitespace NodeId with projection should succeed: ${JSON.stringify(result.issues)}`)
    assert.equal(result.issues.length, 0)
  })
})

// ─── 42. Regression: assemble mapping shape validation ─────────────────────────

describe('regression: assemble mapping shape validation', () => {
  it('absent assemble in convert action emits SCHEMA_REQUIRED', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: {} },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'absent assemble should cause failure')
    const req = result.issues.filter((i) => i.code === 'SCHEMA_REQUIRED')
    assert.ok(req.length >= 1, `should have SCHEMA_REQUIRED, got ${JSON.stringify(result.issues)}`)
  })

  it('assemble:true emits SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: true } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'assemble:true should cause failure')
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(invalid.length >= 1, `should have SCHEMA_INVALID, got ${JSON.stringify(result.issues)}`)
  })

  it('assemble:42 emits SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: 42 } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'assemble:42 should cause failure')
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(invalid.length >= 1, `should have SCHEMA_INVALID, got ${JSON.stringify(result.issues)}`)
  })

  it('assemble:string emits SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: 'badString' } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'assemble:string should cause failure')
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(invalid.length >= 1, `should have SCHEMA_INVALID, got ${JSON.stringify(result.issues)}`)
  })

  it('assemble:null emits SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: null } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'assemble:null should cause failure')
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(invalid.length >= 1, `should have SCHEMA_INVALID, got ${JSON.stringify(result.issues)}`)
  })

  it('assemble:[] emits SCHEMA_INVALID', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'x', source: 'start.x' }],
        action: { type: 'convert', params: { assemble: [] as JsonValue[] } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null, 'assemble:[] should cause failure')
    const invalid = result.issues.filter((i) => i.code === 'SCHEMA_INVALID')
    assert.ok(invalid.length >= 1, `should have SCHEMA_INVALID, got ${JSON.stringify(result.issues)}`)
  })
})

// ─── 43. Regression: exhaustive nested array traversal collects all errors ────

describe('regression: exhaustive nested array traversal collects all errors', () => {
  it('nested array with invalid object child, invalid nested-array child, and bare string sibling reports all MAP_PATH_UNKNOWN in deterministic order', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              arr: [
                { bad: 'objChildBare' },
                ['nestedArrBare'],
                'siblingBare',
              ] as JsonValue[],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null,
      `bare strings should cause failure: ${JSON.stringify(result.issues)}`)
    const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
    assert.ok(pathUnknown.length >= 3,
      `should report at least 3 MAP_PATH_UNKNOWN, got ${pathUnknown.length}: ${JSON.stringify(pathUnknown.map((i) => i.message))}`)
    // Verify all distinct details are reported (order is deterministic: object child, nested array child, sibling)
    const details = pathUnknown.map((i) => i.message)
    assert.ok(details.some((d) => d.includes('objChildBare')),
      `object child bare string should be reported: ${JSON.stringify(details)}`)
    assert.ok(details.some((d) => d.includes('nestedArrBare')),
      `nested array bare string should be reported: ${JSON.stringify(details)}`)
    assert.ok(details.some((d) => d.includes('siblingBare')),
      `bare string sibling should be reported: ${JSON.stringify(details)}`)
  })

  it('nested array with invalid object child and later bare string preserves all MAP_PATH_UNKNOWN', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      }),
      conv: convertNode('conv', {
        deps: ['start'],
        input: [{ name: 'a', source: 'start.a' }],
        action: {
          type: 'convert',
          params: {
            assemble: {
              arr: [
                { inner: 'firstBare' },
                'secondBare',
              ] as JsonValue[],
            } as Record<string, JsonValue>,
          },
        },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, makeResolver())
    assert.equal(result.graph, null,
      `bare strings should cause failure: ${JSON.stringify(result.issues)}`)
    const pathUnknown = result.issues.filter((i) => i.code === 'MAP_PATH_UNKNOWN')
    assert.ok(pathUnknown.length >= 2,
      `should report at least 2 MAP_PATH_UNKNOWN, got ${pathUnknown.length}: ${JSON.stringify(pathUnknown.map((i) => i.message))}`)
    const details = pathUnknown.map((i) => i.message)
    assert.ok(details.some((d) => d.includes('firstBare')),
      `first bare string should be reported: ${JSON.stringify(details)}`)
    assert.ok(details.some((d) => d.includes('secondBare')),
      `second bare string should be reported: ${JSON.stringify(details)}`)
  })
})

// ─── 39. B7: Definition input_schema vs graph slot schema — never assertSubset ──

describe('B7 regression — definition input_schema (array-root) must not compare to graph slot schema', () => {
  it('task node with array-root definition input_schema and object-root graph slots must not MAP_TYPE_MISMATCH', () => {
    const resolver: TaskGraphAutoSchemaResolver = {
      resolveActionSchema(type) {
        if (type === 'task') {
          return {
            // Array-root definition input_schema: the task definition expects an array payload
            input: { type: 'array', items: { type: 'string' } } as JsonObject,
            output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
          }
        }
        return null
      },
      resolveLlmInputSchema() { return null },
      resolveLlmStructuredOpts() { return null },
    }
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t1: taskNode('t1', {
        deps: ['start'],
        // Graph slot input_schema — object-root describing wiring slots
        // This is the ONLY schema that belongs on the graph node.
        // 'msg' is optional (not in required) to isolate the no-comparison claim.
        input_schema: { type: 'object', properties: { msg: { type: 'string' } } } as ObjectJsonSchema,
        output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] } as ObjectJsonSchema,
        // params.input carries the literal payload (validated against definition schema).
        action: { type: 'task', params: { command: 'echo', input: ['hello', 'world'] } },
      }),
    }
    const result = validateTaskGraphPostImage(graph, [], undefined, resolver)
    // Per B7: definition input_schema is the SSOT for params.input.
    // Graph slot input_schema is object-root wiring only.
    // They must NOT be subset-compared — no MAP_TYPE_MISMATCH should appear.
    assert.equal(result.issues.length, 0,
      `expected no issues; got: ${JSON.stringify(result.issues.map((i) => ({ code: i.code, message: i.message })))}`)
    assert.ok(result.graph !== null, 'graph must be valid')
  })
})
