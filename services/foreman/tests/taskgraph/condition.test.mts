import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateCondition,
  evaluatePredicate,
  validateConditionParams,
  type TaskGraph,
  type TaskGraphNode,
} from '../../lib/core/taskgraph/index.mts'

describe('TaskGraph condition AST', () => {
  it('evaluates ordered cases with strict JSON predicates and default', () => {
    const params = {
      cases: [
        {
          when: {
            all: [
              { path: '$.approval.status', op: 'eq' as const, value: 'approved' },
              { path: '$.risk.score', op: 'lt' as const, value: 50 },
            ],
          },
          branch: 'fulfill',
        },
        {
          when: {
            any: [
              { path: '$.tags', op: 'contains' as const, value: 'manual' },
              { not: { path: '$.owner', op: 'exists' as const } },
            ],
          },
          branch: 'manual',
        },
      ],
      default: 'reject',
    }

    assert.deepEqual(evaluateCondition(params, {
      approval: { status: 'approved' },
      risk: { score: 12 },
      tags: [],
    }), { branch: 'fulfill', caseIndex: 0 })
    assert.deepEqual(evaluateCondition(params, {
      approval: { status: 'rejected' },
      risk: { score: 12 },
      tags: ['manual'],
    }), { branch: 'manual', caseIndex: 1 })
    assert.deepEqual(evaluateCondition(params, {
      approval: { status: 'rejected' },
      risk: { score: 80 },
      tags: [],
      owner: 'user',
    }), { branch: 'reject', caseIndex: null })
  })

  it('distinguishes missing from explicit null and supports in', () => {
    assert.equal(evaluatePredicate({ path: '$.value', op: 'missing' }, {}), true)
    assert.equal(evaluatePredicate({ path: '$.value', op: 'missing' }, { value: null }), false)
    assert.equal(evaluatePredicate({ path: '$.value', op: 'eq', value: null }, { value: null }), true)
    assert.equal(evaluatePredicate({ path: '$.value', op: 'in', value: ['a', 'b'] }, { value: 'b' }), true)
    assert.equal(evaluatePredicate({ path: '$.value', op: 'eq', value: 1 }, { value: '1' }), false)
  })

  it('rejects unknown AST keys, unrestricted paths, and non-downstream branches', () => {
    const graph = conditionValidationGraph()
    const issues = validateConditionParams(graph, 'choose', {
      cases: [{
        when: { path: '$..recursive', op: 'wat', value: 1 },
        branch: 'not-downstream',
        extra: true,
      }],
      default: 'missing',
      extra: true,
    })
    assert.ok(issues.some((issue) => issue.path === 'extra'))
    assert.ok(issues.some((issue) => issue.path === 'cases[0].when.path'))
    assert.ok(issues.some((issue) => issue.path === 'cases[0].when.op'))
    assert.ok(issues.some((issue) => issue.path === 'cases[0].extra'))
    assert.ok(issues.some((issue) => issue.message.includes('must declare "choose" as a dependency')))
    assert.ok(issues.some((issue) => issue.message.includes('does not exist')))
  })
})

function conditionValidationGraph(): TaskGraph {
  const node = (id: string, deps: string[]): TaskGraphNode => ({
    id,
    name: id,
    action: { type: id === 'choose' ? 'condition' : 'end', params: {} },
    deps,
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  })
  return {
    id: 'tg',
    revision: 1,
    nodes: {
      choose: node('choose', []),
      downstream: node('downstream', ['choose']),
      'not-downstream': node('not-downstream', []),
    },
  }
}
