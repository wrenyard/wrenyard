import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DispatchControl, DAEMON_PLANNED_RESTART_CODE, DAEMON_PLANNED_RESTART_MESSAGE } from '../../lib/daemon/dispatch-control.mts'
import {
  PLANNED_RESTART_STATE_FILE_NAME,
  PlannedRestartStore,
  PlannedRestartStoreError,
  type PlannedRestartPlan,
} from '../../lib/daemon/planned-restart-store.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-planned-restart-'))
  tempDirs.push(dir)
  return dir
}

function makePlan(overrides: Partial<PlannedRestartPlan> = {}): PlannedRestartPlan {
  return {
    operation_id: 'op_1',
    kind: 'update',
    phase: 'draining',
    recovery_required: false,
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  initTestDb()
})

afterEach(() => {
  closeTestDb()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PlannedRestartStore', () => {
  it('treats a missing file as accepting with no plan', () => {
    const store = new PlannedRestartStore(makeTempDir())
    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'accepting')
    assert.equal(snapshot.plan, null)
  })

  it('persists durable frozen mode across stores', () => {
    const root = makeTempDir()
    const a = new PlannedRestartStore(root)
    a.setAdmissionMode('frozen')
    const b = new PlannedRestartStore(root)
    assert.equal(b.snapshot().mode, 'frozen')
  })

  it('atomically begins a plan with required fields', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'planned_restart')
    assert.ok(snapshot.plan)
    assert.equal(snapshot.plan!.operation_id, 'op_1')
    assert.equal(snapshot.plan!.kind, 'update')
    assert.equal(snapshot.plan!.phase, 'draining')
    assert.equal(snapshot.plan!.recovery_required, false)
    assert.equal(snapshot.plan!.created_at, '2026-07-14T00:00:00.000Z')
  })

  it('hydrates via a second store and DispatchControl instance', () => {
    const root = makeTempDir()
    const first = new PlannedRestartStore(root)
    first.beginPlan(makePlan())

    const secondStore = new PlannedRestartStore(root)
    const secondControl = new DispatchControl(secondStore)

    const status = secondControl.status()
    assert.equal(status.mode, 'planned_restart')
    assert.equal(status.accepting, false)
    assert.equal(status.frozen, false)
    assert.ok(status.plannedRestart)
    assert.equal(status.plannedRestart!.operationId, 'op_1')
    assert.equal(status.plannedRestart!.kind, 'update')
    assert.equal(status.plannedRestart!.phase, 'draining')
    assert.equal(status.plannedRestart!.recoveryRequired, false)
    assert.equal(status.plannedRestart!.createdAt, '2026-07-14T00:00:00.000Z')
  })

  it('rejects invalid enum values on load', () => {
    const root = makeTempDir()
    writeFileSync(
      join(root, PLANNED_RESTART_STATE_FILE_NAME),
      JSON.stringify({ version: 1, mode: 'bogus' }),
      'utf8',
    )
    assert.throws(() => new PlannedRestartStore(root), PlannedRestartStoreError)
  })

  it('rejects malformed JSON on load', () => {
    const root = makeTempDir()
    writeFileSync(join(root, PLANNED_RESTART_STATE_FILE_NAME), '{not json', 'utf8')
    assert.throws(() => new PlannedRestartStore(root), PlannedRestartStoreError)
  })

  it('rejects a mismatched operation_id on plan updates', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    assert.throws(() => store.updatePlan('other_op', { phase: 'draining' }), PlannedRestartStoreError)
    assert.throws(() => store.abortPlan('other_op'), PlannedRestartStoreError)
    assert.throws(
      () => store.failPlan('other_op', {
        error_code: 'E', error_message: 'm', failed_at: '2026-07-14T00:00:00.000Z',
      }),
      PlannedRestartStoreError,
    )
    assert.throws(() => store.completePlan('other_op'), PlannedRestartStoreError)
  })

  it('rejects a second active plan', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    assert.throws(
      () => store.beginPlan(makePlan({ operation_id: 'op_2' })),
      (error: unknown) => error instanceof PlannedRestartStoreError && error.code === 'plan_already_active',
    )
  })

  it('produces the exact planned-restart admission error code and message', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    const control = new DispatchControl(store)
    let caught: unknown
    try {
      control.assertAccepting()
    } catch (error) {
      caught = error
    }
    assert.ok(caught)
    assert.equal((caught as { code: string }).code, DAEMON_PLANNED_RESTART_CODE)
    assert.equal((caught as { message: string }).message, DAEMON_PLANNED_RESTART_MESSAGE)
  })

  it('failPlan retains planned_restart with all recovery metadata and recovery_required true', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    store.failPlan('op_1', {
      error_code: 'update_failed',
      error_message: 'git checkout failed',
      failed_at: '2026-07-14T00:05:00.000Z',
      old_head: 'aaa',
      new_head: 'bbb',
      coordinator_pid: 12345,
      config_path: '/etc/foreman/config.json',
      checkout_path: '/srv/foreman',
    })

    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'planned_restart')
    const plan = snapshot.plan!
    assert.equal(plan.phase, 'failed')
    assert.equal(plan.recovery_required, true)
    assert.equal(plan.error_code, 'update_failed')
    assert.equal(plan.error_message, 'git checkout failed')
    assert.equal(plan.failed_at, '2026-07-14T00:05:00.000Z')
    assert.equal(plan.old_head, 'aaa')
    assert.equal(plan.new_head, 'bbb')
    assert.equal(plan.coordinator_pid, 12345)
    assert.equal(plan.config_path, '/etc/foreman/config.json')
    assert.equal(plan.checkout_path, '/srv/foreman')
  })

  it('abortPlan retains a failed terminal plan under the restored accepting mode', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan({ new_head: 'bbb' }))
    store.abortPlan('op_1')

    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'accepting')
    const plan = snapshot.plan!
    assert.ok(plan)
    assert.equal(plan.operation_id, 'op_1')
    assert.equal(plan.phase, 'failed')
    assert.equal(plan.recovery_required, false)
    assert.equal(plan.new_head, 'bbb')
  })

  it('completePlan retains a completed terminal plan under the restored accepting mode', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan({ old_head: 'aaa', new_head: 'bbb' }))
    store.completePlan('op_1')

    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'accepting')
    const plan = snapshot.plan!
    assert.ok(plan)
    assert.equal(plan.operation_id, 'op_1')
    assert.equal(plan.phase, 'completed')
    assert.equal(plan.recovery_required, false)
    assert.equal(plan.old_head, 'aaa')
    assert.equal(plan.new_head, 'bbb')
  })

  it('abortPlan retains a failed terminal plan under the restored frozen mode', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.setAdmissionMode('frozen')
    store.beginPlan(makePlan({ new_head: 'bbb' }))
    store.abortPlan('op_1')

    const status = new DispatchControl(store).status()
    assert.equal(status.mode, 'frozen')
    assert.equal(status.frozen, true)
    assert.equal(status.accepting, false)
    const plan = store.snapshot().plan!
    assert.ok(plan)
    assert.equal(plan.operation_id, 'op_1')
    assert.equal(plan.phase, 'failed')
    assert.equal(plan.recovery_required, false)
    assert.equal(plan.new_head, 'bbb')
  })

  it('completePlan retains a completed terminal plan under the restored frozen mode', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.setAdmissionMode('frozen')
    store.beginPlan(makePlan({ old_head: 'aaa', new_head: 'bbb' }))
    store.completePlan('op_1')

    const status = new DispatchControl(store).status()
    assert.equal(status.mode, 'frozen')
    assert.equal(status.frozen, true)
    assert.equal(status.accepting, false)
    const plan = store.snapshot().plan!
    assert.ok(plan)
    assert.equal(plan.operation_id, 'op_1')
    assert.equal(plan.phase, 'completed')
    assert.equal(plan.recovery_required, false)
    assert.equal(plan.old_head, 'aaa')
    assert.equal(plan.new_head, 'bbb')
  })

  it('beginPlan replaces a retained terminal non-recovery plan with a new operation', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan({ operation_id: 'op_1' }))
    store.abortPlan('op_1')
    assert.equal(store.snapshot().plan!.operation_id, 'op_1')

    store.beginPlan(makePlan({ operation_id: 'op_2' }))
    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'planned_restart')
    assert.equal(snapshot.plan!.operation_id, 'op_2')
    assert.equal(snapshot.plan!.phase, 'draining')
    assert.equal(snapshot.plan!.recovery_required, false)
  })

  it('generic accepting<->frozen transitions preserve the retained terminal plan', () => {
    const root = makeTempDir()
    const store = new PlannedRestartStore(root)
    store.beginPlan(makePlan({ new_head: 'bbb' }))
    store.abortPlan('op_1')

    store.setAdmissionMode('frozen')
    assert.equal(store.snapshot().mode, 'frozen')
    const frozenPlan = store.snapshot().plan!
    assert.ok(frozenPlan)
    assert.equal(frozenPlan.phase, 'failed')
    assert.equal(frozenPlan.new_head, 'bbb')

    store.setAdmissionMode('accepting')
    assert.equal(store.snapshot().mode, 'accepting')
    assert.equal(store.snapshot().plan!.phase, 'failed')

    // A fresh store still validates and exposes the retained outcome.
    const reloaded = new PlannedRestartStore(root)
    assert.equal(reloaded.snapshot().mode, 'accepting')
    assert.equal(reloaded.snapshot().plan!.phase, 'failed')
  })

  it('loading accepting/frozen state with a nonterminal plan throws state_inconsistent', () => {
    const root = makeTempDir()
    writeFileSync(
      join(root, PLANNED_RESTART_STATE_FILE_NAME),
      JSON.stringify({
        version: 1,
        mode: 'accepting',
        plan: {
          operation_id: 'op_1',
          kind: 'update',
          phase: 'draining',
          recovery_required: false,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      }),
      'utf8',
    )
    assert.throws(
      () => new PlannedRestartStore(root),
      (error: unknown) => error instanceof PlannedRestartStoreError && error.code === 'state_inconsistent',
    )
  })

  it('loading accepting/frozen state with a recovery_required plan throws state_inconsistent', () => {
    const root = makeTempDir()
    writeFileSync(
      join(root, PLANNED_RESTART_STATE_FILE_NAME),
      JSON.stringify({
        version: 1,
        mode: 'frozen',
        plan: {
          operation_id: 'op_1',
          kind: 'update',
          phase: 'failed',
          recovery_required: true,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      }),
      'utf8',
    )
    assert.throws(
      () => new PlannedRestartStore(root),
      (error: unknown) => error instanceof PlannedRestartStoreError && error.code === 'state_inconsistent',
    )
  })

  it('freeze and thaw cannot overwrite an active planned_restart', () => {
    const store = new PlannedRestartStore(makeTempDir())
    store.beginPlan(makePlan())
    const control = new DispatchControl(store)

    assert.throws(() => control.freeze())
    assert.throws(() => control.thaw())

    // mode remains planned_restart and the plan is intact.
    assert.equal(store.snapshot().mode, 'planned_restart')
    assert.ok(store.snapshot().plan)
  })
})

describe('PlannedRestartStore (legacy phase normalization)', () => {
  it('normalizes legacy preparing to draining on load before validation', () => {
    const root = makeTempDir()
    writeFileSync(
      join(root, PLANNED_RESTART_STATE_FILE_NAME),
      JSON.stringify({
        version: 1,
        mode: 'planned_restart',
        plan: {
          operation_id: 'op_1',
          kind: 'update',
          phase: 'preparing',
          recovery_required: false,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      }),
      'utf8',
    )
    const store = new PlannedRestartStore(root)
    const plan = store.snapshot().plan!
    assert.equal(plan.phase, 'draining')
  })

  it('normalizes legacy starting to stopping on load before validation', () => {
    const root = makeTempDir()
    writeFileSync(
      join(root, PLANNED_RESTART_STATE_FILE_NAME),
      JSON.stringify({
        version: 1,
        mode: 'planned_restart',
        plan: {
          operation_id: 'op_1',
          kind: 'update',
          phase: 'starting',
          recovery_required: false,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      }),
      'utf8',
    )
    const store = new PlannedRestartStore(root)
    const plan = store.snapshot().plan!
    assert.equal(plan.phase, 'stopping')
  })

  it('normalization is idempotent and does not corrupt new-format files', () => {
    // A new-format file (draining) survives a load + re-load cycle unchanged.
    const root = makeTempDir()
    const original = new PlannedRestartStore(root)
    original.beginPlan(makePlan({ phase: 'draining' }))
    const reloaded = new PlannedRestartStore(root)
    assert.equal(reloaded.snapshot().plan!.phase, 'draining')
    // Re-loading again must not mutate the file.
    const reloaded2 = new PlannedRestartStore(root)
    assert.equal(reloaded2.snapshot().plan!.phase, 'draining')
  })

  it('rejects an unsupported new phase on beginPlan (only 6 phases are writable)', () => {
    const store = new PlannedRestartStore(makeTempDir())
    assert.throws(
      () => store.beginPlan(makePlan({ phase: 'preparing' as never })),
      (error: unknown) => error instanceof PlannedRestartStoreError && error.code === 'plan_field_invalid',
    )
    assert.throws(
      () => store.beginPlan(makePlan({ phase: 'starting' as never })),
      (error: unknown) => error instanceof PlannedRestartStoreError && error.code === 'plan_field_invalid',
    )
  })
})
