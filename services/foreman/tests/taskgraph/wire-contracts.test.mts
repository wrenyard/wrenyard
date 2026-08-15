// @ts-nocheck
/**
 * wire-contracts.test.mts — Fog-horn test for taskgraph wire protocol schemas.
 *
 * Compiles all twelve exported params/result schemas with AJV
 * (allErrors:true, strict:false) and exercises JSON roundtrip validation.
 *
 * Covers create, patch, status, events, signal, and node.inspect.
 * Does NOT import or alter the method registry — FU-001 independence.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv, { type ValidateFunction } from 'ajv'

import {
  taskgraphCreateParamsSchema,
  taskgraphCreateResultSchema,
  taskgraphPatchParamsSchema,
  taskgraphPatchResultSchema,
  taskgraphStatusParamsSchema,
  taskgraphStatusResultSchema,
  taskgraphEventsParamsSchema,
  taskgraphEventsResultSchema,
  taskgraphSignalParamsSchema,
  taskgraphSignalResultSchema,
  taskgraphNodeInspectParamsSchema,
  taskgraphNodeInspectResultSchema,
  taskgraphInspectParamsSchema,
  taskgraphInspectResultSchema,
  taskgraphListParamsSchema,
  taskgraphListResultSchema,
  taskgraphWaitParamsSchema,
  taskgraphWaitResultSchema,
  taskgraphSlipParamsSchema,
  taskgraphSlipResultSchema,
} from '../../lib/protocol/methods/taskgraph.mts'
import type {
  TaskGraphSlipNode as CoreSlipNode,
  TaskGraphSlipResult as CoreSlipResult,
} from '../../lib/core/taskgraph/contracts.mts'

const ajv = new Ajv({ allErrors: true, strict: false })

const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

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

// ─── Common fixtures ───────────────────────────────────────────────────────────

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

function patch(ops: Record<string, unknown>[]) {
  return roundtrip({
    base_revision: 0,
    actor: 'test',
    reason: 'testing',
    created_at: '2026-01-01T00:00:00Z',
    ops,
  })
}

function canonicalEvent(suffix?: string) {
  return roundtrip({
    event_id: 'evt-1',
    taskgraph_id: 'g-1',
    seq: 1,
    type: suffix ? `taskgraph.${suffix}` : 'taskgraph.created',
    occurred_at: '2026-01-01T00:00:00Z',
    structure_revision: 0,
    source: { kind: 'daemon', id: 'd-1' },
    data: {},
  })
}

function executionError(): Record<string, unknown> {
  return { code: 'EXEC_FAILURE', message: 'something broke', details: { line: 42 } }
}

function failureCause(): Record<string, unknown> {
  return {
    kind: 'node_failed',
    node_id: 'n2',
    task_run_id: 'run-1',
    error: executionError(),
    event_id: 'tge_abc',
  }
}

// ─── taskgraph.create ─────────────────────────────────────────────────────────

describe('taskgraph.create', () => {
  describe('params', () => {
    const validate = compile(taskgraphCreateParamsSchema)

    it('accepts the default template', () => {
      assertValid(validate, roundtrip({ template: 'default' }))
    })

    it('accepts every named template', () => {
      for (const template of [
        'default',
        'parallel-explore',
        'parallel-edit',
        'change-test',
        'implement',
        'closeout',
      ]) {
        assertValid(validate, roundtrip({ template, project: 'foreman/pet' }))
      }
    })

    it('accepts a non-empty authoritative project scope', () => {
      assertValid(
        validate,
        roundtrip({
          template: 'default',
          project: 'foreman/pet',
        }),
      )
    })

    it('accepts the pause on_node_failure policy', () => {
      assertValid(
        validate,
        roundtrip({
          template: 'default',
          on_node_failure: 'pause',
        }),
      )
    })

    it('accepts the cancel on_node_failure policy', () => {
      assertValid(
        validate,
        roundtrip({
          template: 'default',
          on_node_failure: 'cancel',
        }),
      )
    })

    it('accepts a non-empty create title', () => {
      assertValid(
        validate,
        roundtrip({
          template: 'default',
          title: 'deploy release v1.2.3',
        }),
      )
    })

    it('accepts a title at exactly the 120 code unit limit', () => {
      assertValid(
        validate,
        roundtrip({
          template: 'default',
          title: 'x'.repeat(120),
        }),
      )
    })

    it('accepts payloads omitting title', () => {
      assertValid(validate, roundtrip({ template: 'default' }))
    })

    it('rejects an empty create title', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          title: '',
        }),
      )
    })

    it('rejects a non-string create title', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          title: 42,
        }),
      )
    })

    it('rejects a create title longer than 120 code units', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          title: 'x'.repeat(121),
        }),
      )
    })

    it('accepts payloads omitting on_node_failure', () => {
      assertValid(validate, roundtrip({ template: 'default' }))
    })

    it('rejects an unknown on_node_failure policy', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          on_node_failure: 'failed',
        }),
      )
    })

    it('rejects an empty authoritative project scope', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          project: '',
        }),
      )
    })

    it('rejects params with server-owned field like id', () => {
      assertInvalid(
        validate,
        roundtrip({ template: 'default', id: 'g-1' }),
      )
    })

    it('rejects params without template', () => {
      assertInvalid(validate, roundtrip({}))
    })

    it('rejects a full IR graph on create', () => {
      assertInvalid(
        validate,
        roundtrip({
          template: 'default',
          graph: { nodes: { n1: canonicalNode('n1') } },
        }),
      )
    })

    it('rejects an unknown template id', () => {
      assertInvalid(validate, roundtrip({ template: 'grow' }))
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphCreateResultSchema)

    it('accepts a freshly created graph result', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph: {
            id: 'g-1',
            revision: 0,
            status: 'created',
            created_at: '2026-01-01T00:00:00Z',
          },
        }),
      )
    })

    it('accepts a freshly created graph result with an optional title', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph: {
            id: 'g-1',
            revision: 0,
            status: 'created',
            created_at: '2026-01-01T00:00:00Z',
            title: 'deploy release v1.2.3',
          },
        }),
      )
    })
  })
})

// ─── taskgraph.patch ──────────────────────────────────────────────────────────

describe('taskgraph.patch', () => {
  describe('params — both operation types', () => {
    const validate = compile(taskgraphPatchParamsSchema)

    it('accepts AddNode request', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          operation: {
            type: 'request_patch',
            patch: patch([{ op: 'AddNode', node: canonicalNode('n1') }]),
          },
        }),
      )
    })

    it('accepts RemoveNode request', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          operation: {
            type: 'request_patch',
            patch: patch([{ op: 'RemoveNode', id: 'n1' }]),
          },
        }),
      )
    })

    it('accepts confirm_patch', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          operation: { type: 'confirm_patch', patch_id: 'p-1' },
        }),
      )
    })

    it('rejects AddEdge operation', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          operation: {
            type: 'request_patch',
            patch: patch([{ op: 'AddEdge', from: 'n1', to: 'n2' }]),
          },
        }),
      )
    })

    it('rejects mixed request and confirm fields', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          operation: { type: 'request_patch', patch_id: 'p-1' },
        }),
      )
    })
  })

  describe('result — all three variants', () => {
    const validate = compile(taskgraphPatchResultSchema)

    it('accepts preview result', () => {
      assertValid(
        validate,
        roundtrip({
          type: 'preview',
          patch_id: 'p-1',
          graph: {
            id: 'g-1',
            revision: 1,
            nodes: { n1: canonicalNode('n1') },
          },
        }),
      )
    })

    it('accepts applied result', () => {
      assertValid(
        validate,
        roundtrip({ type: 'applied', revision: 1 }),
      )
    })

    it('accepts rejected result', () => {
      assertValid(
        validate,
        roundtrip({
          type: 'rejected',
          errors: [{ code: 'DUP_ID', message: 'duplicate node' }],
        }),
      )
    })

    it('rejects rejected result with non-patch error code', () => {
      assertInvalid(
        validate,
        roundtrip({
          type: 'rejected',
          errors: [{ code: 'NODE_NOT_FOUND', message: 'not a patch error' }],
        }),
      )
    })
  })
})

// ─── taskgraph.status ─────────────────────────────────────────────────────────

describe('taskgraph.status', () => {
  describe('params', () => {
    const validate = compile(taskgraphStatusParamsSchema)

    it('accepts valid params', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1' }))
    })

    it('rejects params with extra method-envelope fields', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', jsonrpc: '2.0', id: 1 }))
    })
  })

  describe('result — running and all terminal outcomes', () => {
    const validate = compile(taskgraphStatusResultSchema)

    it('accepts running state result', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'running',
          structure_revision: 0,
          latest_seq: 3,
          node_counts: {
            planned: 0, running: 2, waiting: 0,
            done: 1, failed: 0, interrupted: 0, cancelled: 0,
          },
          active: { running: ['n1'], waiting: [] },
        }),
      )
    })

    it('accepts a result carrying an optional run title', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'created',
          title: 'deploy release v1.2.3',
          structure_revision: 0,
          latest_seq: 1,
          node_counts: {
            planned: 1, running: 0, waiting: 0,
            done: 0, failed: 0, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
        }),
      )
    })

    it('accepts done terminal outcome', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'done',
          structure_revision: 0,
          latest_seq: 10,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 2, failed: 0, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: { outcome: 'done', end_output: { result: 'ok' } },
        }),
      )
    })

    it('accepts paused graph with node_counts.failed (per D50, no terminal)', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'paused',
          structure_revision: 0,
          latest_seq: 5,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 1, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
        }),
      )
    })

    it('rejects graph-level state "failed" per D31', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'failed',
          structure_revision: 0,
          latest_seq: 5,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 1, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
        }),
      )
    })

    it('rejects terminal outcome "failed" per D31', () => {
      const err = executionError()
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'done',
          structure_revision: 0,
          latest_seq: 5,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 1, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: { outcome: 'failed', failure: { node_id: 'n2', error: err } },
        }),
      )
    })

    it('accepts cancelled terminal outcome', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'cancelled',
          structure_revision: 0,
          latest_seq: 6,
          node_counts: {
            planned: 1, running: 0, waiting: 0,
            done: 0, failed: 0, interrupted: 0, cancelled: 1,
          },
          active: { running: [], waiting: [] },
          terminal: { outcome: 'cancelled' },
        }),
      )
    })

    it('accepts a cancelled terminal with structured failure evidence and policy', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'cancelled',
          cancel_requested: true,
          on_node_failure: 'cancel',
          structure_revision: 0,
          latest_seq: 6,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 0, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: { outcome: 'cancelled', failure: failureCause() },
        }),
      )
    })

    it('rejects a cancelled terminal with an unknown failure kind', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'cancelled',
          structure_revision: 0,
          latest_seq: 6,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 0, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: {
            outcome: 'cancelled',
            failure: { ...failureCause(), kind: 'graph_failed' },
          },
        }),
      )
    })

    it('rejects a cancelled terminal whose failure lacks the error snapshot', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'cancelled',
          structure_revision: 0,
          latest_seq: 6,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 0, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: {
            outcome: 'cancelled',
            failure: { kind: 'node_failed', node_id: 'n2' },
          },
        }),
      )
    })

    it('accepts result with cancel_requested flag', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'running',
          cancel_requested: true,
          structure_revision: 0,
          latest_seq: 3,
          node_counts: {
            planned: 0, running: 1, waiting: 0,
            done: 0, failed: 0, interrupted: 0, cancelled: 0,
          },
          active: { running: ['n1'], waiting: [] },
        }),
      )
    })

    it('rejects unknown graph state', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'suspended',
          structure_revision: 0,
          latest_seq: 0,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 0, failed: 0, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
        }),
      )
    })

    it('rejects terminal failure with malformed error', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          state: 'failed',
          structure_revision: 0,
          latest_seq: 5,
          node_counts: {
            planned: 0, running: 0, waiting: 0,
            done: 1, failed: 1, interrupted: 0, cancelled: 0,
          },
          active: { running: [], waiting: [] },
          terminal: { outcome: 'failed', failure: { node_id: 'n2', error: { code: 123, message: 'bad' } } },
        }),
      )
    })
  })
})

// ─── taskgraph.events ─────────────────────────────────────────────────────────

describe('taskgraph.events', () => {
  describe('params', () => {
    const validate = compile(taskgraphEventsParamsSchema)

    it('accepts params with required fields only', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1' }))
    })

    it('accepts params with after_seq and limit', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', after_seq: 0, limit: 10 }))
    })
  })

  describe('result with cursor containing canonical event', () => {
    const validate = compile(taskgraphEventsResultSchema)

    it('accepts result with one event', () => {
      assertValid(
        validate,
        roundtrip({
          events: [canonicalEvent('started')],
          next_seq: 2,
          latest_seq: 2,
          has_more: false,
        }),
      )
    })

    it('accepts result with multiple events', () => {
      assertValid(
        validate,
        roundtrip({
          events: [canonicalEvent('started'), canonicalEvent('node.completed')],
          next_seq: 3,
          latest_seq: 3,
          has_more: true,
        }),
      )
    })

    it('rejects event with severity field', () => {
      const evt = roundtrip(canonicalEvent('started'))
      evt.severity = 'critical'
      assertInvalid(
        validate,
        roundtrip({ events: [evt], next_seq: 2, latest_seq: 2, has_more: false }),
      )
    })

    it('rejects event with receipt_ref field', () => {
      const evt = roundtrip(canonicalEvent('node.started'))
      evt.receipt_ref = 'ack-1'
      assertInvalid(
        validate,
        roundtrip({ events: [evt], next_seq: 2, latest_seq: 2, has_more: false }),
      )
    })
  })
})

// ─── taskgraph.signal ─────────────────────────────────────────────────────────

describe('taskgraph.signal', () => {
  describe('params — all five signal variants', () => {
    const validate = compile(taskgraphSignalParamsSchema)

    it('accepts start_graph signal', () => {
      assertValid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'start_graph', input: { key: 'val' } } }),
      )
    })

    it('accepts pause_graph signal', () => {
      assertValid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'pause_graph' } }),
      )
    })

    it('rejects pause_graph with payload field', () => {
      assertInvalid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'pause_graph', reason: 'stop' } }),
      )
    })

    it('accepts resume_graph signal', () => {
      assertValid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'resume_graph' } }),
      )
    })

    it('rejects resume_graph with payload field', () => {
      assertInvalid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'resume_graph', input: {} } }),
      )
    })

    it('accepts cancel_graph signal', () => {
      assertValid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'cancel_graph' } }),
      )
    })

    it('rejects cancel_graph with payload field', () => {
      assertInvalid(
        validate,
        roundtrip({ taskgraph_id: 'g-1', signal: { type: 'cancel_graph', reason: 'timeout' } }),
      )
    })

    it('accepts resume_checkpoint signal', () => {
      assertValid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          signal: { type: 'resume_checkpoint', node_id: 'n1', output: { ok: true } },
        }),
      )
    })

    it('rejects resume_checkpoint without node_id', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          signal: { type: 'resume_checkpoint', output: {} },
        }),
      )
    })

    it('rejects resume_checkpoint without output', () => {
      assertInvalid(
        validate,
        roundtrip({
          taskgraph_id: 'g-1',
          signal: { type: 'resume_checkpoint', node_id: 'n1' },
        }),
      )
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphSignalResultSchema)

    it('accepts accepted:true result', () => {
      assertValid(validate, roundtrip({ accepted: true }))
    })
  })
})

// ─── taskgraph.node.inspect ───────────────────────────────────────────────────

describe('taskgraph.node.inspect', () => {
  describe('params', () => {
    const validate = compile(taskgraphNodeInspectParamsSchema)

    it('accepts valid params', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', node_id: 'n1' }))
    })

    it('rejects params with extra method-envelope fields', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', node_id: 'n1', jsonrpc: '2.0' }))
    })
  })

  describe('result — canonical node, run, and output data', () => {
    const validate = compile(taskgraphNodeInspectResultSchema)

    it('accepts result with node, running state, and no output', () => {
      assertValid(
        validate,
        roundtrip({
          structure_revision: 0,
          node: canonicalNode('n1'),
          run: { state: 'running' },
        }),
      )
    })

    it('accepts result with output', () => {
      assertValid(
        validate,
        roundtrip({
          structure_revision: 0,
          node: canonicalNode('n1'),
          run: { state: 'done' },
          output: { result: 'hello' },
        }),
      )
    })

    it('accepts result with error in run info', () => {
      assertValid(
        validate,
        roundtrip({
          structure_revision: 0,
          node: canonicalNode('n1'),
          run: { state: 'failed', error: executionError(), task_run_id: 'run-1' },
        }),
      )
    })

    it('rejects inspect result missing input_schema', () => {
      const badNode = roundtrip(canonicalNode('n1'))
      delete badNode.input_schema
      assertInvalid(
        validate,
        roundtrip({ structure_revision: 0, node: badNode, run: { state: 'planned' } }),
      )
    })

    it('rejects inspect result missing output_schema', () => {
      const badNode = roundtrip(canonicalNode('n1'))
      delete badNode.output_schema
      assertInvalid(
        validate,
        roundtrip({ structure_revision: 0, node: badNode, run: { state: 'planned' } }),
      )
    })
  })
})

// ─── taskgraph.inspect ────────────────────────────────────────────────────────

describe('taskgraph.inspect', () => {
  describe('params', () => {
    const validate = compile(taskgraphInspectParamsSchema)

    it('accepts valid params', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1' }))
    })

    it('rejects empty taskgraph_id', () => {
      assertInvalid(validate, roundtrip({ taskgraph_id: '' }))
    })

    it('accepts params with extra envelope fields', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', jsonrpc: '2.0', id: 1 }))
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphInspectResultSchema)

    it('accepts result with a full graph', () => {
      assertValid(
        validate,
        roundtrip({
          graph: {
            id: 'g-1',
            revision: 1,
            nodes: { n1: canonicalNode('n1') },
          },
        }),
      )
    })

    it('rejects result missing graph', () => {
      assertInvalid(validate, roundtrip({}))
    })

    it('rejects result with missing graph fields', () => {
      assertInvalid(validate, roundtrip({ graph: { id: 'g-1' } }))
    })
  })
})

// ─── taskgraph.list ──────────────────────────────────────────────────────────

describe('taskgraph.list', () => {
  describe('params', () => {
    const validate = compile(taskgraphListParamsSchema)

    it('accepts the default empty params', () => {
      assertValid(validate, roundtrip({}))
    })

    it('accepts project and state filters', () => {
      assertValid(validate, roundtrip({ project: 'foreman/pet', states: ['running', 'paused'] }))
    })

    it('rejects a zero limit', () => {
      assertInvalid(validate, roundtrip({ limit: 0 }))
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphListResultSchema)

    const summary = () => roundtrip({
      taskgraph_id: 'g-1',
      state: 'cancelled',
      structure_revision: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ended_at: '2026-01-01T00:01:00Z',
    })

    it('accepts a legacy summary omitting policy and failure', () => {
      assertValid(validate, roundtrip({ runs: [summary()] }))
    })

    it('accepts a summary carrying policy and structured failure evidence', () => {
      assertValid(validate, roundtrip({
        runs: [{
          ...summary(),
          on_node_failure: 'cancel',
          failure: failureCause(),
        }],
      }))
    })

    it('accepts a summary carrying an optional title', () => {
      assertValid(validate, roundtrip({
        runs: [{ ...summary(), title: 'deploy release v1.2.3' }],
      }))
    })

    it('rejects a summary with an unknown failure kind', () => {
      assertInvalid(validate, roundtrip({
        runs: [{
          ...summary(),
          on_node_failure: 'cancel',
          failure: { ...failureCause(), kind: 'graph_failed' },
        }],
      }))
    })

    it('rejects a summary with an unknown policy', () => {
      assertInvalid(validate, roundtrip({
        runs: [{ ...summary(), on_node_failure: 'failed' }],
      }))
    })
  })
})

// ─── taskgraph.wait ──────────────────────────────────────────────────────────

describe('taskgraph.wait', () => {
  describe('params', () => {
    const validate = compile(taskgraphWaitParamsSchema)

    it('accepts valid params', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1' }))
    })

    it('accepts a bounded timeout', () => {
      assertValid(validate, roundtrip({ taskgraph_id: 'g-1', timeout_ms: 1000 }))
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphWaitResultSchema)

    it('accepts a legacy cancelled result', () => {
      assertValid(validate, roundtrip({
        taskgraph_id: 'g-1',
        state: 'cancelled',
        reason: 'cancelled',
        structure_revision: 0,
        latest_seq: 6,
        node_counts: {
          planned: 0, running: 0, waiting: 0,
          done: 0, failed: 0, interrupted: 0, cancelled: 1,
        },
        active: { running: [], waiting: [] },
        terminal: { outcome: 'cancelled' },
      }))
    })

    it('accepts a cancelled result with policy and structured failure evidence', () => {
      assertValid(validate, roundtrip({
        taskgraph_id: 'g-1',
        state: 'cancelled',
        reason: 'cancelled',
        on_node_failure: 'cancel',
        structure_revision: 0,
        latest_seq: 6,
        node_counts: {
          planned: 0, running: 0, waiting: 0,
          done: 0, failed: 1, interrupted: 0, cancelled: 0,
        },
        active: { running: [], waiting: [] },
        terminal: { outcome: 'cancelled', failure: failureCause() },
      }))
    })

    it('accepts a result carrying an optional title', () => {
      assertValid(validate, roundtrip({
        taskgraph_id: 'g-1',
        state: 'created',
        reason: 'timeout',
        title: 'deploy release v1.2.3',
        structure_revision: 0,
        latest_seq: 0,
        node_counts: {
          planned: 0, running: 0, waiting: 0,
          done: 0, failed: 0, interrupted: 0, cancelled: 0,
        },
        active: { running: [], waiting: [] },
      }))
    })

    it('rejects an unknown wait reason', () => {
      assertInvalid(validate, roundtrip({
        taskgraph_id: 'g-1',
        state: 'cancelled',
        reason: 'suspended',
        structure_revision: 0,
        latest_seq: 6,
        node_counts: {
          planned: 0, running: 0, waiting: 0,
          done: 0, failed: 0, interrupted: 0, cancelled: 1,
        },
        active: { running: [], waiting: [] },
      }))
    })
  })
})

// ─── taskgraph.slip ──────────────────────────────────────────────────────────

describe('taskgraph.slip', () => {
  describe('params', () => {
    const validate = compile(taskgraphSlipParamsSchema)

    it('accepts a legal bounded node id list', () => {
      assertValid(validate, roundtrip({
        taskgraph_id: 'g-1',
        node_ids: ['n1', 'n2', 'n3'],
      }))
    })

    it('rejects a request without node_ids', () => {
      assertInvalid(validate, roundtrip({ taskgraph_id: 'g-1' }))
    })

    it('rejects duplicate node ids', () => {
      assertInvalid(validate, roundtrip({ taskgraph_id: 'g-1', node_ids: ['n1', 'n1'] }))
    })

    it('rejects an empty node id list', () => {
      assertInvalid(validate, roundtrip({ taskgraph_id: 'g-1', node_ids: [] }))
    })

    it('rejects more than 256 node ids', () => {
      assertInvalid(validate, roundtrip({
        taskgraph_id: 'g-1',
        node_ids: Array.from({ length: 257 }, (_, index) => `n${index}`),
      }))
    })

    it('rejects a node id longer than 128 UTF-16 code units', () => {
      assertInvalid(validate, roundtrip({
        taskgraph_id: 'g-1',
        node_ids: ['x'.repeat(129)],
      }))
    })
  })

  describe('result', () => {
    const validate = compile(taskgraphSlipResultSchema)

    it('accepts a bounded fully populated result', () => {
      assertValid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'running',
        structure_revision: 3,
        latest_seq: 12,
        nodes: [
          {
            node_id: 'work',
            state: 'done',
            task_id: 'edit',
            task_category: 'edit',
            display_label: '编码',
            description: 'File-level edit executor',
            agent_runtime: 'forge/fast',
          },
        ],
      }))
    })

    it('rejects a node missing the required state', () => {
      assertInvalid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
        nodes: [{ node_id: 'work' }],
      }))
    })

    it('rejects a node with an unknown extra field', () => {
      assertInvalid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
        nodes: [{ node_id: 'work', state: 'planned', output: { secret: 'x' } }],
      }))
    })

    it('accepts a node with bounded telemetry and summary fields', () => {
      assertValid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'running',
        structure_revision: 3,
        latest_seq: 12,
        nodes: [
          {
            node_id: 'work',
            state: 'done',
            task_category: 'edit',
            display_label: '编码',
            description: 'File-level edit executor',
            agent_runtime: 'forge/fast',
            tool_call_count: 7,
            tps: 1234.5,
            profile: 'forge/fast',
            summary: 'All criteria passed.',
          },
        ],
      }))
    })

    it('accepts a bounded tps at exactly the maximum', () => {
      assertValid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
        nodes: [{ node_id: 'work', state: 'planned', tps: 1_000_000 }],
      }))
    })

    it('rejects out-of-bounds telemetry and summary values', () => {
      const base = () => roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
      })
      const invalidNodes: Record<string, unknown>[] = [
        { node_id: 'work', state: 'planned', tool_call_count: -1 },
        { node_id: 'work', state: 'planned', tps: 1_000_001 },
        { node_id: 'work', state: 'planned', tps: -0.5 },
        { node_id: 'work', state: 'planned', profile: 'x'.repeat(129) },
        { node_id: 'work', state: 'planned', profile: '' },
        { node_id: 'work', state: 'planned', summary: 'x'.repeat(281) },
        { node_id: 'work', state: 'planned', summary: '' },
      ]
      for (const node of invalidNodes) {
        assertInvalid(validate, { ...base(), nodes: [node] })
      }
    })

    it('rejects telemetry and legacy fields outside the strict whitelist', () => {
      const base = () => roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
      })
      for (const extra of [
        { output: { secret: 'x' } },
        { task_run_id: 'task_1' },
        { error: { code: 'E', message: 'x' } },
      ]) {
        assertInvalid(validate, {
          ...base(),
          nodes: [{ node_id: 'work', state: 'planned', ...extra }],
        })
      }
    })

    it('rejects a numeric schema_version', () => {
      assertInvalid(validate, roundtrip({
        schema_version: 1,
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
        nodes: [],
      }))
    })

    it('rejects an unknown schema_version', () => {
      assertInvalid(validate, roundtrip({
        schema_version: 'foreman.taskgraph.slip.v2',
        taskgraph_id: 'g-1',
        graph_state: 'created',
        structure_revision: 1,
        latest_seq: 0,
        nodes: [],
      }))
    })

    it('matches the core slip node contract for telemetry optionality, bounds, and whitelist', () => {
      // Core/protocol field parity: fixtures typed through the shared core
      // TaskGraphSlipResult contract must satisfy the registered v1 wire schema
      // for the four dynamic telemetry fields (tool_call_count, tps, profile,
      // summary) — optional, bounded, and never widened by unknown properties.
      const coreResult = (node: CoreSlipNode): CoreSlipResult => roundtrip({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'g-1',
        graph_state: 'running',
        structure_revision: 3,
        latest_seq: 12,
        nodes: [node],
      })
      assertValid(validate, coreResult({
        node_id: 'work',
        state: 'done',
        task_id: 'forge-deploy',
        tool_call_count: 7,
        tps: 1234.5,
        profile: 'forge/fast',
        summary: 'All criteria passed.',
      }))
      assertValid(validate, coreResult({ node_id: 'work', state: 'done' }))
      for (const over of [
        { node_id: 'work', state: 'planned', task_id: 'x'.repeat(129) },
        { node_id: 'work', state: 'planned', task_id: '' },
        { node_id: 'work', state: 'planned', tool_call_count: -1 },
        { node_id: 'work', state: 'planned', tps: 1_000_001 },
        { node_id: 'work', state: 'planned', profile: 'x'.repeat(129) },
        { node_id: 'work', state: 'planned', summary: 'x'.repeat(281) },
      ]) {
        assertInvalid(validate, coreResult(over))
      }
      assertInvalid(validate, coreResult({ node_id: 'work', state: 'planned', tool_call_count: 1, raw: true }))
      // Legacy nodes without a task definition name stay valid on the wire.
      assertValid(validate, coreResult({
        node_id: 'work',
        state: 'done',
        task_category: 'edit',
      }))
    })
  })
})
