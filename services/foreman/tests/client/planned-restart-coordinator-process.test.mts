import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decideCoordinatorStartup,
} from '../../lib/client/cli/planned-restart-coordinator-process.mts'
import type { PlannedRestartPlan } from '../../lib/daemon/planned-restart-store.mts'

function activePlan(overrides: Partial<PlannedRestartPlan> = {}): PlannedRestartPlan {
  return {
    operation_id: 'op_1',
    kind: 'restart',
    phase: 'draining',
    recovery_required: false,
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('decideCoordinatorStartup (single-mode validation)', () => {
  it('returns run with the validated plan for a matching nonterminal plan', () => {
    const plan = activePlan({ operation_id: 'op_1', kind: 'restart', phase: 'draining' })
    const decision = decideCoordinatorStartup(
      plan,
      { operationId: 'op_1', kind: 'restart' },
    )
    assert.equal(decision.kind, 'run')
    assert.equal(decision.plan, plan)
  })

  it('returns noop for an absent plan (parent died before beginPlan)', () => {
    const decision = decideCoordinatorStartup(null, { operationId: 'op_1', kind: 'restart' })
    assert.equal(decision.kind, 'noop')
    assert.match(decision.reason, /absent/u)
  })

  it('returns noop for a completed plan (parent finished after completion)', () => {
    const decision = decideCoordinatorStartup(
      activePlan({ phase: 'completed' }),
      { operationId: 'op_1', kind: 'restart' },
    )
    assert.equal(decision.kind, 'noop')
    assert.match(decision.reason, /completed/u)
  })

  it('returns noop for a failed plan (parent finished after failure)', () => {
    const decision = decideCoordinatorStartup(
      activePlan({ phase: 'failed' }),
      { operationId: 'op_1', kind: 'restart' },
    )
    assert.equal(decision.kind, 'noop')
    assert.match(decision.reason, /failed/u)
  })

  it('throws on operation id mismatch (corrupt/conflicting state)', () => {
    assert.throws(
      () => decideCoordinatorStartup(
        activePlan({ operation_id: 'op_other' }),
        { operationId: 'op_1', kind: 'restart' },
      ),
      /active plan 'op_other' does not match/u,
    )
  })

  it('throws on kind mismatch (corrupt/conflicting state)', () => {
    assert.throws(
      () => decideCoordinatorStartup(
        activePlan({ kind: 'update' }),
        { operationId: 'op_1', kind: 'restart' },
      ),
      /kind mismatch/u,
    )
  })

  it('returns run for every nonterminal phase when ids and kind match', () => {
    for (const phase of ['draining', 'updating', 'stopping', 'verifying'] as const) {
      const decision = decideCoordinatorStartup(
        activePlan({ phase }),
        { operationId: 'op_1', kind: 'restart' },
      )
      assert.equal(decision.kind, 'run', `expected run for phase ${phase}`)
    }
  })

  it('returns run regardless of coordinator_pid (ownership is checked via self-stamp, not here)', () => {
    // decideCoordinatorStartup does NOT check coordinator_pid — the caller
    // self-stamps its pid and re-reads to verify ownership. A plan with a
    // different pid still returns 'run' here; the loser exits 0 at the
    // process-level re-read or the engine's mid-run ownership check.
    const decision = decideCoordinatorStartup(
      activePlan({ coordinator_pid: 99999 }),
      { operationId: 'op_1', kind: 'restart' },
    )
    assert.equal(decision.kind, 'run')
  })

  it('returns run when the plan has no coordinator pid (not yet stamped)', () => {
    const decision = decideCoordinatorStartup(
      activePlan({ coordinator_pid: null }),
      { operationId: 'op_1', kind: 'restart' },
    )
    assert.equal(decision.kind, 'run')
  })
})
