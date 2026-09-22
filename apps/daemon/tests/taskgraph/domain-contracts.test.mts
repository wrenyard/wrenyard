// @ts-nocheck
/**
 * domain-contracts.test.mts — Fog-horn test for core taskgraph domain schemas.
 *
 * Compiles every exported domain schema with AJV (allErrors:true, strict:false)
 * and validates JSON-roundtripped legal payloads.  Rejects structural drift
 * (stale field names, unknown codes, wrong types).
 *
 * Deliberately avoids semantic DAG / source-path / schema-validity cases —
 * those belong in execution-level tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv, { type ValidateFunction } from 'ajv'

import {
  ACTION_TYPE_SCHEMA,
  GRAPH_STATE_SCHEMA,
  NODE_RUN_STATE_SCHEMA,
  ON_NODE_FAILURE_POLICY_SCHEMA,
  TASKGRAPH_FAILURE_CAUSE_SCHEMA,
  NODE_ID_SCHEMA,
  OBJECT_JSON_SCHEMA_SCHEMA,
  TASK_GRAPH_NODE_SCHEMA,
  PATCH_OPERATION_SCHEMA,
} from '../../lib/core/taskgraph/index.mts'

import {
  PATCH_ERROR_SCHEMA,
  PROTOCOL_ERROR_SCHEMA,
  EXECUTION_ERROR_SCHEMA,
  SIGNAL_SCHEMA,
  EVENT_SOURCE_SCHEMA,
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

function canonicalNode(id: string) {
  return {
    id,
    name: `node-${id}`,
    action: { type: 'task', params: { command: 'echo' } },
    deps: [],
    input: [{ name: 'x', source: '$.steps.a' }],
    input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  }
}

// ─── Run failure policy and structured termination metadata ───────────────────

describe('on-node-failure policy — closed domain value', () => {
  const validate = compile(ON_NODE_FAILURE_POLICY_SCHEMA)

  it('rejects unknown policy values', () => {
    assertInvalid(validate, 'failed')
    assertInvalid(validate, 'cancel_force')
    assertInvalid(validate, 'suspended')
  })
})

describe('TaskGraphFailureCause — structured termination metadata', () => {
  const validate = compile(TASKGRAPH_FAILURE_CAUSE_SCHEMA)

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

// ─── Schema validation: canonical node with all seven fields ───────────────────

describe('TaskGraphNode (all seven fields)', () => {
  const validate = compile(TASK_GRAPH_NODE_SCHEMA)

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
  it('rejects unknown operation type', () => {
    const validate = compile(PATCH_OPERATION_SCHEMA)
    assertInvalid(validate, roundtrip({ op: 'AddEdge', from: 'n1', to: 'n2' }))
  })
})

// ─── Schema validation: graph states ───────────────────────────────────────────

describe('GraphStateType enum validation', () => {
  const validate = compile(GRAPH_STATE_SCHEMA)

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

  it('rejects unknown source kind', () => {
    assertInvalid(validate, roundtrip({ kind: 'external' }))
  })
})

// ─── Schema validation: PatchError ─────────────────────────────────────────────

describe('PatchError schema', () => {
  const validate = compile(PATCH_ERROR_SCHEMA)

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

  it('rejects error with non-object details', () => {
    assertInvalid(validate, roundtrip({ code: 'EXEC_FAILURE', message: 'broke', details: 'string' }))
  })
})

// ─── Schema validation: ProtocolError ──────────────────────────────────────────

describe('ProtocolError schema', () => {
  const validate = compile(PROTOCOL_ERROR_SCHEMA)

  it('rejects unknown protocol error code', () => {
    assertInvalid(validate, roundtrip({ code: 'INVALID_STATE', message: 'bad' }))
  })
})

// ─── Action type enum validation ──────────────────────────────────────────────

describe('ActionType enum validation', () => {
  const validate = compile(ACTION_TYPE_SCHEMA)

  it('rejects unknown action type', () => {
    assertInvalid(validate, 'custom')
  })
})

// ─── NodeId contract — any nonempty string ─────────────────────────────────

describe('NODE_ID_SCHEMA — NodeId admits arbitrary nonempty strings', () => {
  const validate = compile(NODE_ID_SCHEMA)

  it('rejects empty string', () => {
    assertInvalid(validate, '')
  })
})
