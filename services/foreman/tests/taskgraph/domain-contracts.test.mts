// @ts-nocheck
/**
 * domain-contracts.test.mts — Fog-horn test for core taskgraph domain schemas.
 *
 * Compiles every exported domain schema with AJV (allErrors:true, strict:false)
 * and validates JSON-roundtripped legal payloads.  Asserts enum cardinality
 * and rejects structural drift (stale field names, unknown codes, wrong types).
 *
 * Deliberately avoids semantic DAG / source-path / schema-validity cases —
 * those belong in execution-level tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv, { type ValidateFunction } from 'ajv'

import {
  ACTION_TYPES,
  GRAPH_STATES,
  NODE_RUN_STATES,
  ON_NODE_FAILURE_POLICIES,
  FAILURE_CAUSE_KINDS,
  ACTION_TYPE_SCHEMA,
  GRAPH_STATE_SCHEMA,
  NODE_RUN_STATE_SCHEMA,
  ON_NODE_FAILURE_POLICY_SCHEMA,
  TASKGRAPH_FAILURE_CAUSE_SCHEMA,
  GRAPH_ID_SCHEMA,
  NODE_ID_SCHEMA,
  OBJECT_JSON_SCHEMA_SCHEMA,
  TASK_GRAPH_ACTION_SCHEMA,
  NODE_INPUT_SCHEMA,
  TASK_GRAPH_NODE_SCHEMA,
  PATCH_OPERATION_SCHEMA,
  TASK_GRAPH_PATCH_SCHEMA,
} from '../../lib/core/taskgraph/index.mts'

import {
  PATCH_ERROR_CODES,
  PROTOCOL_ERROR_CODES,
  IGNORED_REASONS,
  TASKGRAPH_EVENT_TYPES,
  SOURCE_KINDS,
  PATCH_ERROR_SCHEMA,
  PROTOCOL_ERROR_SCHEMA,
  EXECUTION_ERROR_SCHEMA,
  SIGNAL_SCHEMA,
  EVENT_SOURCE_SCHEMA,
  EVENT_REFS_SCHEMA,
  TASKGRAPH_EVENT_SCHEMA,
} from '../../lib/core/taskgraph/index.mts'

const ajv = new Ajv({ allErrors: true, strict: false })

const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Helpers ───────────────────────────────────────────────────────────────────

function compile(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema) as ValidateFunction
}

function assertValid(validate: ValidateFunction, data: unknown): void {
  const ok = validate(data)
  if (!ok) {
    throw new assert.AssertionError({
      message: `expected valid, got errors: ${JSON.stringify(validate.errors)}`,
      actual: validate.errors,
      expected: null,
    })
  }
}

function assertInvalid(validate: ValidateFunction, data: unknown): void {
  const ok = validate(data)
  if (ok) {
    throw new assert.AssertionError({
      message: 'expected invalid but passed',
      actual: data,
    })
  }
}

// ─── Canonical fixtures ────────────────────────────────────────────────────────

function action(type: string, params: Record<string, unknown> = {}) {
  return { type, params }
}

function nodeInput(name: string, source: string, optional?: boolean) {
  return optional !== undefined ? { name, source, optional } : { name, source }
}

function canonicalNode(id: string) {
  return {
    id,
    name: `node-${id}`,
    action: action('task', { command: 'echo' }),
    deps: [],
    input: [nodeInput('x', '$.steps.a')],
    input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  }
}

function canonicalGraph(): Record<string, unknown> {
  const n1 = canonicalNode('n1')
  const n2 = { ...canonicalNode('n2'), deps: ['n1'], input: [nodeInput('prev', '$.nodes.n1.output')] }
  return { id: 'g-1', revision: 0, nodes: { n1, n2 } }
}

// ─── Enum cardinality tests ────────────────────────────────────────────────────

describe('enum cardinality — domain types', () => {
  it('ACTION_TYPES contains exactly 9 entries', () => {
    assert.deepEqual([...ACTION_TYPES].sort(), [
      'checkpoint', 'condition', 'convert', 'end', 'join',
      'llm', 'shell', 'start', 'task',
    ])
  })

  it('GRAPH_STATES contains exactly 5 entries', () => {
    assert.deepEqual([...GRAPH_STATES].sort(), [
      'cancelled', 'created', 'done', 'paused', 'running',
    ])
  })

  it('NODE_RUN_STATES contains exactly 7 entries', () => {
    assert.deepEqual([...NODE_RUN_STATES].sort(), [
      'cancelled', 'done', 'failed', 'interrupted', 'planned', 'running', 'waiting',
    ])
  })

  it('PATCH_ERROR_CODES contains exactly 12 entries', () => {
    assert.equal(PATCH_ERROR_CODES.length, 12)
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

  it('PROTOCOL_ERROR_CODES contains exactly 3 entries', () => {
    assert.equal(PROTOCOL_ERROR_CODES.length, 3)
    assert.deepEqual([...PROTOCOL_ERROR_CODES].sort(), [
      'NODE_NOT_FOUND',
      'NOT_IMPLEMENTED',
      'TASKGRAPH_NOT_FOUND',
    ])
  })

  it('IGNORED_REASONS contains exactly 6 entries', () => {
    assert.equal(IGNORED_REASONS.length, 6)
    assert.deepEqual([...IGNORED_REASONS].sort(), [
      'CHECKPOINT_NOT_WAITING',
      'CHECKPOINT_OUTPUT_SCHEMA_MISMATCH',
      'GRAPH_ALREADY_CANCELLED',
      'GRAPH_ALREADY_STARTED',
      'GRAPH_NOT_PAUSED',
      'START_INPUT_SCHEMA_MISMATCH',
    ])
  })

  it('TASKGRAPH_EVENT_TYPES contains exactly 16 entries', () => {
    assert.equal(TASKGRAPH_EVENT_TYPES.length, 16)
    assert.deepEqual([...TASKGRAPH_EVENT_TYPES].sort(), [
      'taskgraph.cancelled',
      'taskgraph.checkpoint.entered',
      'taskgraph.checkpoint.resumed',
      'taskgraph.created',
      'taskgraph.done',
      'taskgraph.node.cancelled',
      'taskgraph.node.completed',
      'taskgraph.node.failed',
      'taskgraph.node.interrupted',
      'taskgraph.node.started',
      'taskgraph.patch.applied',
      'taskgraph.paused',
      'taskgraph.resumed',
      'taskgraph.signal.ignored',
      'taskgraph.signal.received',
      'taskgraph.started',
    ])
  })

  it('ON_NODE_FAILURE_POLICIES contains exactly 2 entries', () => {
    assert.deepEqual([...ON_NODE_FAILURE_POLICIES].sort(), ['cancel', 'pause'])
  })

  it('FAILURE_CAUSE_KINDS contains exactly 2 entries', () => {
    assert.deepEqual([...FAILURE_CAUSE_KINDS].sort(), ['node_failed', 'recovery_failed'])
  })
})

// ─── Run failure policy and structured termination metadata ───────────────────

describe('on-node-failure policy — closed domain value', () => {
  const validate = compile(ON_NODE_FAILURE_POLICY_SCHEMA)

  it('accepts the pause policy', () => {
    assertValid(validate, 'pause')
  })

  it('accepts the cancel policy', () => {
    assertValid(validate, 'cancel')
  })

  it('rejects unknown policy values', () => {
    assertInvalid(validate, 'failed')
    assertInvalid(validate, 'cancel_force')
    assertInvalid(validate, 'suspended')
  })
})

describe('TaskGraphFailureCause — structured termination metadata', () => {
  const validate = compile(TASKGRAPH_FAILURE_CAUSE_SCHEMA)

  it('accepts a fully populated node_failed cause', () => {
    assertValid(validate, roundtrip({
      kind: 'node_failed',
      node_id: 'n1',
      task_run_id: 'run-1',
      error: { code: 'TASK_RUN_FAILED', message: 'boom', details: { line: 42 } },
      event_id: 'tge_abc',
    }))
  })

  it('accepts a recovery_failed cause without optional fields', () => {
    assertValid(validate, roundtrip({
      kind: 'recovery_failed',
      node_id: 'n2',
      error: { code: 'TASK_RUN_REATTACH_FAILED', message: 'cannot reattach' },
    }))
  })

  it('rejects a cause missing the immutable error snapshot', () => {
    assertInvalid(validate, roundtrip({ kind: 'node_failed', node_id: 'n1' }))
  })

  it('rejects a cause with an unknown kind', () => {
    assertInvalid(validate, roundtrip({
      kind: 'graph_failed',
      node_id: 'n1',
      error: { code: 'X', message: 'y' },
    }))
  })

  it('rejects a cause with an unknown extra field', () => {
    assertInvalid(validate, roundtrip({
      kind: 'node_failed',
      node_id: 'n1',
      error: { code: 'X', message: 'y' },
      severity: 'critical',
    }))
  })
})

// ─── Schema validation: stored TaskGraph ───────────────────────────────────────

describe('stored TaskGraph', () => {
  const validate = compile(TASK_GRAPH_PATCH_SCHEMA) // semantically uses graph shape
  // Use base patch schema for graph-level shape checks

  it('accepts a complete legal TaskGraph wrapped in a patch', () => {
    const patch = roundtrip({
      base_revision: 0,
      actor: 'test',
      reason: 'initial',
      created_at: '2026-01-01T00:00:00Z',
      ops: [{ op: 'AddNode', node: canonicalNode('n1') }],
    })
    assertValid(compile(TASK_GRAPH_PATCH_SCHEMA), patch)
  })
})

// ─── Schema validation: canonical node with all seven fields ───────────────────

describe('TaskGraphNode (all seven fields)', () => {
  const validate = compile(TASK_GRAPH_NODE_SCHEMA)

  it('accepts a node with all required fields', () => {
    assertValid(validate, roundtrip(canonicalNode('n1')))
  })

  it('rejects a node with stale "output" instead of output_schema', () => {
    const bad = roundtrip({ ...canonicalNode('n1'), output: { type: 'string' } })
    delete bad.output_schema
    assertInvalid(validate, bad)
  })

  it('rejects a node with missing id', () => {
    const bad = roundtrip(canonicalNode('n1'))
    delete bad.id
    assertInvalid(validate, bad)
  })

  it('rejects a node with non-object input_schema', () => {
    const bad = roundtrip({ ...canonicalNode('n1'), input_schema: { type: 'array' } })
    assertInvalid(validate, bad)
  })
})

// ─── Schema validation: object-top-level JSON schema ──────────────────────────

describe('OBJECT_JSON_SCHEMA_SCHEMA — top-level stored schemas must be object', () => {
  const validate = compile(OBJECT_JSON_SCHEMA_SCHEMA)

  it('accepts { type: "object" } with properties', () => {
    assertValid(validate, roundtrip({ type: 'object', properties: { x: { type: 'string' } } }))
  })

  it('rejects { type: "array" }', () => {
    assertInvalid(validate, roundtrip({ type: 'array' }))
  })

  it('rejects { type: "string" }', () => {
    assertInvalid(validate, roundtrip({ type: 'string' }))
  })

  it('rejects missing type field', () => {
    assertInvalid(validate, roundtrip({ properties: {} }))
  })
})

// ─── Schema validation: all three patch operations ─────────────────────────────

describe('PatchOperation — all three variants', () => {
  it('AddNode accepts node', () => {
    const validate = compile(PATCH_OPERATION_SCHEMA)
    assertValid(validate, roundtrip({ op: 'AddNode', node: canonicalNode('n1') }))
  })

  it('RemoveNode accepts id', () => {
    const validate = compile(PATCH_OPERATION_SCHEMA)
    assertValid(validate, roundtrip({ op: 'RemoveNode', id: 'n1' }))
  })

  it('ReplaceNode accepts node', () => {
    const validate = compile(PATCH_OPERATION_SCHEMA)
    assertValid(validate, roundtrip({ op: 'ReplaceNode', node: canonicalNode('n1') }))
  })

  it('rejects unknown operation type', () => {
    const validate = compile(PATCH_OPERATION_SCHEMA)
    assertInvalid(validate, roundtrip({ op: 'AddEdge', from: 'n1', to: 'n2' }))
  })
})

// ─── Schema validation: graph states ───────────────────────────────────────────

describe('GraphStateType enum validation', () => {
  const validate = compile(GRAPH_STATE_SCHEMA)

  for (const state of GRAPH_STATES) {
    it(`accepts state "${state}"`, () => {
      assertValid(validate, state)
    })
  }

  it('rejects unknown graph state', () => {
    assertInvalid(validate, 'suspended')
  })

  it('rejects graph-level failed state per D31', () => {
    assertInvalid(validate, 'failed')
  })
})

// ─── Schema validation: node run states ────────────────────────────────────────

describe('NodeRunStateType enum validation', () => {
  const validate = compile(NODE_RUN_STATE_SCHEMA)

  for (const state of NODE_RUN_STATES) {
    it(`accepts node state "${state}"`, () => {
      assertValid(validate, state)
    })
  }

  it('rejects unknown node state', () => {
    assertInvalid(validate, 'suspended')
  })

  it('accepts node-level failed state per D31 (distinct from graph state)', () => {
    assertValid(validate, 'failed')
  })
})

// ─── Schema validation: Signal (all five variants) ─────────────────────────────

describe('TaskGraphSignal — all five variants', () => {
  const validate = compile(SIGNAL_SCHEMA)

  it('accepts start_graph with input', () => {
    assertValid(validate, roundtrip({ type: 'start_graph', input: { key: 'val' } }))
  })

  it('rejects start_graph without input', () => {
    assertInvalid(validate, roundtrip({ type: 'start_graph' }))
  })

  it('accepts pause_graph with no extra fields', () => {
    assertValid(validate, roundtrip({ type: 'pause_graph' }))
  })

  it('rejects pause_graph with payload fields', () => {
    assertInvalid(validate, roundtrip({ type: 'pause_graph', reason: 'stop' }))
  })

  it('accepts resume_graph with no extra fields', () => {
    assertValid(validate, roundtrip({ type: 'resume_graph' }))
  })

  it('rejects resume_graph with payload fields', () => {
    assertInvalid(validate, roundtrip({ type: 'resume_graph', input: {} }))
  })

  it('accepts cancel_graph with no extra fields', () => {
    assertValid(validate, roundtrip({ type: 'cancel_graph' }))
  })

  it('rejects cancel_graph with payload fields', () => {
    assertInvalid(validate, roundtrip({ type: 'cancel_graph', reason: 'timeout' }))
  })

  it('accepts resume_checkpoint with node_id and output', () => {
    assertValid(validate, roundtrip({ type: 'resume_checkpoint', node_id: 'n1', output: { ok: true } }))
  })

  it('rejects resume_checkpoint without node_id', () => {
    assertInvalid(validate, roundtrip({ type: 'resume_checkpoint', output: {} }))
  })

  it('rejects resume_checkpoint without output', () => {
    assertInvalid(validate, roundtrip({ type: 'resume_checkpoint', node_id: 'n1' }))
  })

  it('rejects unknown signal type', () => {
    assertInvalid(validate, roundtrip({ type: 'restart_graph' }))
  })
})

// ─── Schema validation: Event envelope, source, refs, data ────────────────────

describe('TaskGraphEvent — envelope, source, refs, data', () => {
  const validate = compile(TASKGRAPH_EVENT_SCHEMA)

  const canonicalEvent = () =>
    roundtrip({
      event_id: 'evt-1',
      taskgraph_id: 'g-1',
      seq: 1,
      type: 'taskgraph.created',
      occurred_at: '2026-01-01T00:00:00Z',
      structure_revision: 0,
      source: { kind: 'daemon', id: 'd-1' },
      refs: { node_id: 'n1', task_run_id: 'run-1', patch_id: 'p-1' },
      data: { key: 'val' },
    })

  it('accepts a fully populated canonical event', () => {
    assertValid(validate, canonicalEvent())
  })

  it('accepts an event with minimal source (kind only)', () => {
    const ev = roundtrip(canonicalEvent())
    ev.source = { kind: 'client' }
    delete ev.refs
    assertValid(validate, ev)
  })

  it('rejects event with severity field', () => {
    const ev = roundtrip(canonicalEvent())
    ev.severity = 'critical'
    assertInvalid(validate, ev)
  })

  it('rejects event with receipt_ref field', () => {
    const ev = roundtrip(canonicalEvent())
    ev.receipt_ref = 'ack-1'
    assertInvalid(validate, ev)
  })

  it('rejects event with unknown type', () => {
    const ev = roundtrip(canonicalEvent())
    ev.type = 'taskgraph.unknown'
    assertInvalid(validate, ev)
  })

  it('rejects event with non-object data', () => {
    const ev = roundtrip(canonicalEvent())
    ev.data = 'string data'
    assertInvalid(validate, ev)
  })
})

describe('EventSource schema', () => {
  const validate = compile(EVENT_SOURCE_SCHEMA)

  it('accepts daemon source', () => {
    assertValid(validate, roundtrip({ kind: 'daemon' }))
  })

  it('accepts source with optional id', () => {
    assertValid(validate, roundtrip({ kind: 'runner', id: 'r-1' }))
  })

  it('rejects unknown source kind', () => {
    assertInvalid(validate, roundtrip({ kind: 'external' }))
  })
})

describe('EventRefs schema', () => {
  const validate = compile(EVENT_REFS_SCHEMA)

  it('accepts empty refs object', () => {
    assertValid(validate, roundtrip({}))
  })

  it('accepts fully populated refs', () => {
    assertValid(validate, roundtrip({ node_id: 'n1', task_run_id: 'run-1', patch_id: 'p-1' }))
  })
})

// ─── Schema validation: PatchError ─────────────────────────────────────────────

describe('PatchError schema', () => {
  const validate = compile(PATCH_ERROR_SCHEMA)

  for (const code of PATCH_ERROR_CODES) {
    it(`accepts error with code "${code}"`, () => {
      assertValid(validate, roundtrip({ code, message: `msg for ${code}` }))
    })
  }

  it('accepts error with details', () => {
    assertValid(validate, roundtrip({ code: 'DUP_ID', message: 'dup', details: { existing: 'n2' } }))
  })

  it('rejects error with unknown error code', () => {
    assertInvalid(validate, roundtrip({ code: 'UNKNOWN_ERROR', message: 'msg' }))
  })

  it('rejects error with non-object details', () => {
    assertInvalid(validate, roundtrip({ code: 'DUP_ID', message: 'msg', details: 'string-detail' }))
  })
})

// ─── Schema validation: ExecutionError ─────────────────────────────────────────

describe('ExecutionError schema', () => {
  const validate = compile(EXECUTION_ERROR_SCHEMA)

  it('accepts error with code and message', () => {
    assertValid(validate, roundtrip({ code: 'EXEC_FAILURE', message: 'something broke' }))
  })

  it('accepts error with object details', () => {
    assertValid(validate, roundtrip({ code: 'EXEC_FAILURE', message: 'broke', details: { line: 42 } }))
  })

  it('rejects error with non-object details', () => {
    assertInvalid(validate, roundtrip({ code: 'EXEC_FAILURE', message: 'broke', details: 'string' }))
  })
})

// ─── Schema validation: ProtocolError ──────────────────────────────────────────

describe('ProtocolError schema', () => {
  const validate = compile(PROTOCOL_ERROR_SCHEMA)

  for (const code of PROTOCOL_ERROR_CODES) {
    it(`accepts protocol error with code "${code}"`, () => {
      assertValid(validate, roundtrip({ code, message: `msg for ${code}` }))
    })
  }

  it('accepts with details', () => {
    assertValid(validate, roundtrip({ code: 'NODE_NOT_FOUND', message: 'missing', details: { node: 'n3' } }))
  })

  it('rejects unknown protocol error code', () => {
    assertInvalid(validate, roundtrip({ code: 'INVALID_STATE', message: 'bad' }))
  })
})

// ─── Action type enum validation ──────────────────────────────────────────────

describe('ActionType enum validation', () => {
  const validate = compile(ACTION_TYPE_SCHEMA)

  for (const t of ACTION_TYPES) {
    it(`accepts action type "${t}"`, () => {
      assertValid(validate, t)
    })
  }

  it('rejects unknown action type', () => {
    assertInvalid(validate, 'custom')
  })
})

// ─── NodeId contract — any nonempty string ─────────────────────────────────

describe('NODE_ID_SCHEMA — NodeId admits arbitrary nonempty strings', () => {
  const validate = compile(NODE_ID_SCHEMA)

  const admittedValues = [
    'a',
    'up-stream',
    '123',
    'my.node',
    'toString',
    'constructor',
    '__proto__',
    'a.b.c',
    'dotted.id.with.hyphens-here',
    '$$special',
    '123numeric',
    '_underscore_start',
    '$dollar_start',
  ]
  for (const val of admittedValues) {
    it(`admits NodeId "${val}"`, () => {
      assertValid(validate, val)
    })
  }

  it('rejects empty string', () => {
    assertInvalid(validate, '')
  })
})
