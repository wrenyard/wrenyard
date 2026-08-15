import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createRestartPreparationProvider,
  PlannedRestartCoordinatorError,
  resolvePlannedRestartPreparation,
  runPlannedRestartCoordinator,
  waitForPlanTerminal,
  type PlannedRestartCoordinatorDispatch,
  type PlannedRestartCoordinatorDeps,
  type PlannedRestartCoordinatorOptions,
  type PlannedRestartPreparationProvider,
} from '../../lib/client/cli/planned-restart-coordinator.mts'
import {
  createForemanUpdatePreparationProvider,
} from '../../lib/client/cli/foreman-update-preparation.mts'
import type {
  SuiteUpdatePreparer,
} from '../../lib/client/cli/suite-update-preparation.mts'
import {
  ForemanUpdateGit,
  ForemanUpdateGitError,
  type ForemanUpdateCheckoutSnapshot,
  type ForemanUpdateGitExecutor,
} from '../../lib/core/project/foreman-update.mts'
import type {
  ForemanStatus,
} from '../../lib/client/cli/shared.mts'
import type {
  PlannedRestartFailure,
  PlannedRestartKind,
  PlannedRestartPhase,
  PlannedRestartPlan,
  PlannedRestartPlanSummary,
} from '../../lib/daemon/planned-restart-store.mts'
import type { DaemonLifecycleResult } from '../../lib/client/cli/daemon-supervisor.mts'

const OPERATION_ID = 'op_restart_1'

function healthyStatus(
  operationId: string,
  phase: 'verifying' = 'verifying',
): ForemanStatus {
  return {
    ok: true,
    config: { ok: true, path: '/cfg' },
    daemon: { running: true, process: 'foreman-daemon' },
    ipc: { ok: true },
    http: { ok: true },
    mcp: { ok: true },
    db: { ok: true },
    mode: 'planned_restart',
    operation_id: operationId,
    phase,
  } as ForemanStatus
}

function downStatus(): ForemanStatus {
  return {
    ok: false,
    config: { ok: true, path: '/cfg' },
    daemon: { running: false, process: 'foreman-daemon' },
    ipc: { ok: false },
    http: { ok: false },
    mcp: { ok: false },
    db: { ok: false },
  } as ForemanStatus
}

function partialStatus(
  operationId: string,
  overrides: Partial<ForemanStatus>,
): ForemanStatus {
  return { ...healthyStatus(operationId), ...overrides } as ForemanStatus
}

interface FakeDispatch {
  dispatch: TestDispatch
  events: string[]
  statusLog: { tasks: number; wf: number; exec: number }[]
  phaseUpdates: string[]
  get completeCalls(): number
  get abortCalls(): number
  failCalls: PlannedRestartFailure[]
  get rawPlan(): PlannedRestartPlan
}

/** Coordinator dispatch plus the raw-plan read the update provider needs. */
type TestDispatch = PlannedRestartCoordinatorDispatch & {
  readRawPlan: (operationId: string) => PlannedRestartPlan | null
}

function makeFakeDispatch(opts: {
  operationId: string
  kind: PlannedRestartKind
  initialPhase: PlannedRestartPhase
  recoveryRequired?: boolean
  checkoutPath?: string | null
  oldHead?: string | null
  newHead?: string | null
  priorMode?: 'accepting' | 'frozen'
  getActive: () => { tasks: number; wf: number; exec: number }
}): FakeDispatch {
  let mode: 'planned_restart' | 'accepting' | 'frozen' = 'planned_restart'
  const fullPlan: PlannedRestartPlan = {
    operation_id: opts.operationId,
    kind: opts.kind,
    phase: opts.initialPhase,
    recovery_required: opts.recoveryRequired ?? false,
    created_at: '2026-07-14T00:00:00.000Z',
    ...(opts.checkoutPath !== undefined ? { checkout_path: opts.checkoutPath } : {}),
    ...(opts.oldHead !== undefined ? { old_head: opts.oldHead } : {}),
    ...(opts.newHead !== undefined ? { new_head: opts.newHead } : {}),
  }
  const events: string[] = []
  const statusLog: { tasks: number; wf: number; exec: number }[] = []
  const phaseUpdates: string[] = []
  const failCalls: PlannedRestartFailure[] = []
  let completeCalls = 0
  let abortCalls = 0
  const priorMode = opts.priorMode ?? 'accepting'

  const dispatch: TestDispatch = {
    status() {
      const a = opts.getActive()
      statusLog.push({ tasks: a.tasks, wf: a.wf, exec: a.exec })
      const plan: PlannedRestartPlanSummary | null =
        mode === 'planned_restart'
          ? {
              operationId: fullPlan.operation_id,
              kind: fullPlan.kind,
              phase: fullPlan.phase,
              recoveryRequired: fullPlan.recovery_required,
              createdAt: fullPlan.created_at,
            }
          : null
      return {
        mode,
        frozen: mode === 'frozen',
        accepting: mode === 'accepting',
        plannedRestart: plan,
        activeTasks: Array.from({ length: a.tasks }, (_, i) => `t${i}`),
        activeTaskCount: a.tasks,
        activeWorkflows: Array.from({ length: a.wf }, (_, i) => `w${i}`),
        activeWorkflowCount: a.wf,
        activeExecutions: Array.from({ length: a.exec }, (_, i) => `e${i}`),
        activeExecutionCount: a.exec,
      }
    },
    updatePlannedRestart(_op, update) {
      if (update.phase !== undefined) {
        phaseUpdates.push(update.phase)
        events.push(`phase:${update.phase}`)
      }
      const patch = update as Record<string, unknown>
      for (const key of [
        'phase', 'recovery_required', 'error_code', 'error_message', 'failed_at',
        'old_head', 'new_head', 'coordinator_pid', 'config_path', 'checkout_path',
      ]) {
        if (patch[key] !== undefined) (fullPlan as unknown as Record<string, unknown>)[key] = patch[key]
      }
    },
    completePlannedRestart() {
      completeCalls++
      events.push('complete')
      mode = 'accepting'
    },
    abortPlannedRestart() {
      abortCalls++
      events.push('abort')
      mode = priorMode
    },
    failPlannedRestart(_op, failure) {
      failCalls.push(failure)
      events.push('fail')
      fullPlan.phase = 'failed'
      fullPlan.recovery_required = true
      if (failure.coordinator_pid !== undefined) fullPlan.coordinator_pid = failure.coordinator_pid
      if (failure.config_path !== undefined) fullPlan.config_path = failure.config_path
      if (failure.old_head !== undefined) fullPlan.old_head = failure.old_head
      if (failure.new_head !== undefined) fullPlan.new_head = failure.new_head
      if (failure.checkout_path !== undefined) fullPlan.checkout_path = failure.checkout_path
    },
    readRawPlan(_op) {
      return mode === 'planned_restart' ? { ...fullPlan } : null
    },
  }

  return {
    dispatch,
    events,
    statusLog,
    phaseUpdates,
    get completeCalls() {
      return completeCalls
    },
    get abortCalls() {
      return abortCalls
    },
    failCalls,
    get rawPlan() {
      return { ...fullPlan }
    },
  }
}

function isZero(sample: { tasks: number; wf: number; exec: number }): boolean {
  return sample.tasks === 0 && sample.wf === 0 && sample.exec === 0
}

function firstStableDrainIndex(
  log: { tasks: number; wf: number; exec: number }[],
): number {
  for (let i = 0; i < log.length - 1; i++) {
    if (isZero(log[i]) && isZero(log[i + 1])) return i
  }
  return -1
}

function baseOptions(overrides: Partial<PlannedRestartCoordinatorOptions> = {}): PlannedRestartCoordinatorOptions {
  return {
    operationId: OPERATION_ID,
    config: {} as PlannedRestartCoordinatorOptions['config'],
    resolvedConfigPath: '/cfg',
    ...overrides,
  }
}

function baseDeps(
  dispatch: PlannedRestartCoordinatorDispatch,
  extra: Partial<PlannedRestartCoordinatorDeps> = {},
): PlannedRestartCoordinatorDeps {
  // Wire readRawPlan to the fake dispatch's readRawPlan so the engine's
  // mid-run ownership check and handleStopping recheck see the same plan
  // state the dispatch reports.
  const td = dispatch as TestDispatch
  return {
    dispatchControl: dispatch,
    collectForemanStatus: async () => healthyStatus(OPERATION_ID),
    restartDaemonProcess: async () =>
      ({ ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } }) as DaemonLifecycleResult,
    readRawPlan: td.readRawPlan ?? (() => null),
    sleep: async () => {},
    ...extra,
  }
}

describe('resolvePlannedRestartPreparation', () => {
  it('accepts the built-in restart no-op provider', () => {
    const providers = resolvePlannedRestartPreparation(createRestartPreparationProvider(), 'restart')
    assert.equal(providers.length, 1)
    assert.equal(providers[0].kind, 'restart')
  })

  it('rejects update by default with a stable code and no side effects', () => {
    assert.throws(
      () => resolvePlannedRestartPreparation(createRestartPreparationProvider(), 'update'),
      (error: unknown) =>
        error instanceof PlannedRestartCoordinatorError
        && error.code === 'planned_restart_preparation_unsupported',
    )
  })

  it('accepts an injected exact-kind update provider', () => {
    const updateProvider: PlannedRestartPreparationProvider = {
      kind: 'update',
      prepare: async () => {},
    }
    const providers = resolvePlannedRestartPreparation(
      createRestartPreparationProvider().concat(updateProvider),
      'update',
    )
    assert.equal(providers.length, 1)
    assert.equal(providers[0], updateProvider)
  })
})

describe('runPlannedRestartCoordinator (restart, happy path)', () => {
  it('drains naturally, runs no-op prep, restarts, and completes on full health', async () => {
    let active = { tasks: 5, wf: 0, exec: 0 }
    let drainStep = 0
    const sleep = async () => {
      drainStep++
      if (drainStep === 1) active = { tasks: 0, wf: 3, exec: 0 }
      else if (drainStep === 2) active = { tasks: 0, wf: 0, exec: 7 }
      else active = { tasks: 0, wf: 0, exec: 0 }
    }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
      restartCalled = true
      fake.events.push('restart')
      if (hooks?.onStopped) await hooks.onStopped()
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    // Daemon is down until restart runs, then reports healthy verifying.
    const collectForemanStatus = async () => (restartCalled ? healthyStatus(OPERATION_ID) : downStatus())

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { sleep, restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(fake.completeCalls, 1)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
    assert.equal(restartCalled, true)

    // Ordering: draining -> updating (no-op prep) -> stopping -> restart
    // -> verifying -> complete. The starting phase is gone; onStopped no
    // longer writes a phase.
    const order = fake.events
    assert.ok(order.indexOf('phase:draining') < order.indexOf('phase:updating'))
    assert.ok(order.indexOf('phase:updating') < order.indexOf('phase:stopping'))
    assert.ok(order.indexOf('phase:stopping') < order.indexOf('restart'))
    assert.ok(order.indexOf('restart') < order.indexOf('phase:verifying'))
    assert.ok(order.indexOf('phase:verifying') < order.indexOf('complete'))
    // Restart now goes through the updating slot (no-op provider).
    assert.ok(order.includes('phase:updating'))
    // The legacy starting phase is never written.
    assert.ok(!order.includes('phase:starting'))

    // Stable drain: two consecutive all-zero samples were observed before restart.
    const stable = firstStableDrainIndex(fake.statusLog)
    assert.ok(stable >= 0, 'expected two consecutive all-zero drain samples')
    const lastNonZero = fake.statusLog.reduce(
      (acc, s, i) => (isZero(s) ? acc : i),
      -1,
    )
    assert.ok(lastNonZero < fake.statusLog.length - 1, 'restart must wait for stable drain')
  })

  it('does not begin restart until both tasks, workflows, and executions are zero', async () => {
    const samples = [
      { tasks: 2, wf: 0, exec: 0 },
      { tasks: 0, wf: 4, exec: 0 },
      { tasks: 0, wf: 0, exec: 9 },
      { tasks: 0, wf: 0, exec: 0 },
      { tasks: 0, wf: 0, exec: 0 },
    ]
    let cursor = 0
    const getActive = () => samples[Math.min(cursor, samples.length - 1)]
    const sleep = async () => {
      cursor++
    }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive,
    })
    let restartCalled = false
    const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
      restartCalled = true
      if (hooks?.onStopped) await hooks.onStopped()
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => (restartCalled ? healthyStatus(OPERATION_ID) : downStatus())

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { sleep, restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, true)
    // Every independent nonzero count was observed in the drain log.
    assert.ok(fake.statusLog.some((s) => s.tasks > 0))
    assert.ok(fake.statusLog.some((s) => s.wf > 0))
    assert.ok(fake.statusLog.some((s) => s.exec > 0))
    const stable = firstStableDrainIndex(fake.statusLog)
    assert.ok(stable >= 0)
  })
})

describe('runPlannedRestartCoordinator (injected update provider)', () => {
  it('runs only the injected preparation in the updating slot after drain, then stops', async () => {
    const prepared: string[] = []
    const updateProvider: PlannedRestartPreparationProvider = {
      kind: 'update',
      prepare: async (ctx) => {
        prepared.push(ctx.operationId)
      },
    }
    let active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'update',
      initialPhase: 'draining',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
      restartCalled = true
      if (hooks?.onStopped) await hooks.onStopped()
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => (restartCalled ? healthyStatus(OPERATION_ID) : downStatus())

    await runPlannedRestartCoordinator(
      baseOptions({ providers: [updateProvider] }),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.deepEqual(prepared, [OPERATION_ID])
    assert.ok(fake.events.includes('phase:updating'))
    assert.equal(fake.completeCalls, 1)
    assert.equal(restartCalled, true)
    // preparation occupied the updating slot, between draining and stopping.
    const order = fake.events
    assert.ok(order.indexOf('phase:draining') < order.indexOf('phase:updating'))
    assert.ok(order.indexOf('phase:updating') < order.indexOf('phase:stopping'))
  })

  it('pre-stop preparation failure restores prior admission (abort, no restart)', async () => {
    const updateProvider: PlannedRestartPreparationProvider = {
      kind: 'update',
      prepare: async () => {
        throw new Error('prep boom')
      },
    }
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'update',
      initialPhase: 'draining',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }

    await runPlannedRestartCoordinator(
      baseOptions({ providers: [updateProvider] }),
      baseDeps(fake.dispatch, { restartDaemonProcess }),
    )

    assert.equal(restartCalled, false)
    assert.equal(fake.abortCalls, 1)
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })
})

describe('runPlannedRestartCoordinator (default update rejection)', () => {
  it('aborts an update plan with no injected provider', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'update',
      initialPhase: 'draining',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess }),
    )

    assert.equal(restartCalled, false)
    assert.equal(fake.abortCalls, 1)
    assert.equal(fake.failCalls.length, 0)
  })
})

describe('runPlannedRestartCoordinator (failure boundaries)', () => {
  it('stop/start failure retains planned_restart with recovery required and preserved metadata', async () => {
    const recoveryMeta = { old_head: 'a', new_head: 'b', checkout_path: '/co' }
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      recoveryRequired: false,
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      throw new Error('daemon did not come back')
    }
    const collectForemanStatus = async () => downStatus()

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, {
        restartDaemonProcess,
        collectForemanStatus,
        readRawPlan: () => ({ ...recoveryMeta, operation_id: OPERATION_ID, kind: 'restart', phase: 'stopping', recovery_required: false, created_at: 'x' } as never),
      }),
    )

    assert.equal(restartCalled, true)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.failCalls.length, 1)
    const failure = fake.failCalls[0]
    // recovery_required is imposed by the durable store (always true on failPlan),
    // not carried on the failure object; verify it on the resulting plan.
    assert.equal(fake.rawPlan.recovery_required, true)
    assert.equal(failure.error_code, 'planned_restart_coordinator_error')
    assert.match(failure.error_message, /daemon did not come back/)
    assert.equal(failure.coordinator_pid, process.pid)
    assert.equal(failure.config_path, '/cfg')
    assert.equal(failure.old_head, 'a')
    assert.equal(failure.new_head, 'b')
    assert.equal(failure.checkout_path, '/co')
  })

  it('health failure during verifying retains planned_restart with recovery required', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
      restartCalled = true
      if (hooks?.onStopped) await hooks.onStopped()
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    // Never healthy: handoff false, and verifying always partial.
    const collectForemanStatus = async () => partialStatus(OPERATION_ID, { ipc: { ok: false } })

    await runPlannedRestartCoordinator(
      baseOptions({ verificationDeadlineMs: 20, verificationPollIntervalMs: 5 }),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, true)
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.failCalls.length, 1)
    assert.equal(fake.failCalls[0].error_code, 'planned_restart_verification_failed')
    assert.equal(fake.rawPlan.recovery_required, true)
  })

  it('rejects every partial health combination without completing', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const checks: Array<'ipc' | 'http' | 'mcp' | 'db'> = ['ipc', 'http', 'mcp', 'db']
    for (const check of checks) {
      const fake = makeFakeDispatch({
        operationId: OPERATION_ID,
        kind: 'restart',
        initialPhase: 'draining',
        getActive: () => active,
      })
      let restartCalled = false
      const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
        restartCalled = true
        if (hooks?.onStopped) await hooks.onStopped()
        return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
      }
      const collectForemanStatus = async () => {
        if (!restartCalled) return downStatus()
        const base = healthyStatus(OPERATION_ID)
        base[check] = { ok: false }
        return base
      }

      await runPlannedRestartCoordinator(
        baseOptions({ verificationDeadlineMs: 20, verificationPollIntervalMs: 5 }),
        baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
      )
      assert.equal(fake.completeCalls, 0, `expected no completion when ${check} is down`)
      assert.equal(fake.failCalls.length, 1, `expected failure when ${check} is down`)
    }
  })

  it('rejects wrong mode, operation id, and phase projections', async () => {
    const scenarios = [
      { name: 'wrong mode', status: partialStatus(OPERATION_ID, { mode: 'accepting' }) },
      { name: 'wrong operation id', status: partialStatus('other_op', { operation_id: 'other_op' }) },
      { name: 'wrong phase', status: partialStatus(OPERATION_ID, { phase: 'stopping' }) },
    ]
    for (const scenario of scenarios) {
      const active = { tasks: 0, wf: 0, exec: 0 }
      const fake = makeFakeDispatch({
        operationId: OPERATION_ID,
        kind: 'restart',
        initialPhase: 'draining',
        getActive: () => active,
      })
      let restartCalled = false
      const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
        restartCalled = true
        if (hooks?.onStopped) await hooks.onStopped()
        return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
      }
      const collectForemanStatus = async () =>
        restartCalled ? scenario.status : downStatus()

      await runPlannedRestartCoordinator(
        baseOptions({ verificationDeadlineMs: 20, verificationPollIntervalMs: 5 }),
        baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
      )
      assert.equal(fake.completeCalls, 0, `expected no completion for ${scenario.name}`)
      assert.equal(fake.failCalls.length, 1, `expected failure for ${scenario.name}`)
    }
  })
})

describe('runPlannedRestartCoordinator (recovery by durable phase)', () => {
  const nonTerminalPhases: PlannedRestartPhase[] = [
    'draining',
    'updating',
    'stopping',
    'verifying',
  ]

  for (const phase of nonTerminalPhases) {
    it(`recovers from '${phase}' to completion`, async () => {
      const prepared: string[] = []
      const active = { tasks: 0, wf: 0, exec: 0 }
      const fake = makeFakeDispatch({
        operationId: OPERATION_ID,
        kind: 'update',
        initialPhase: phase,
        getActive: () => active,
      })
      let restartCalled = false
      const restartDaemonProcess = async (_opts: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
        restartCalled = true
        if (hooks?.onStopped) await hooks.onStopped()
        return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
      }
      const collectForemanStatus = async () => {
        const current = fake.dispatch.status().plannedRestart
        if (restartCalled || current?.phase === 'verifying') return healthyStatus(OPERATION_ID)
        return downStatus()
      }
      const updateProvider: PlannedRestartPreparationProvider = {
        kind: 'update',
        prepare: async (ctx) => {
          prepared.push(ctx.operationId)
        },
      }

      await runPlannedRestartCoordinator(
        baseOptions({ providers: [updateProvider] }),
        baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
      )

      assert.equal(fake.completeCalls, 1)
      assert.equal(fake.failCalls.length, 0)
      if (phase === 'updating') {
        // updating recovery repeats only the idempotent provider once.
        assert.deepEqual(prepared, [OPERATION_ID])
      }
    })
  }

  it('accepts an already-healthy matching handoff at stopping without restarting', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    // Daemon already healthy and verifying -> handoff.
    const collectForemanStatus = async () => healthyStatus(OPERATION_ID)

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false)
    assert.equal(fake.completeCalls, 1)
    assert.ok(fake.events.includes('phase:verifying'))
  })
})

describe('runPlannedRestartCoordinator (terminal plans)', () => {
  it('performs no side effects on a completed plan', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'completed',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    let statusCalls = 0
    const collectForemanStatus = async () => {
      statusCalls++
      return healthyStatus(OPERATION_ID)
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false)
    assert.equal(statusCalls, 0)
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })

  it('performs no side effects on a failed plan', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'failed',
      getActive: () => active,
    })
    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    let statusCalls = 0
    const collectForemanStatus = async () => {
      statusCalls++
      return healthyStatus(OPERATION_ID)
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false)
    assert.equal(statusCalls, 0)
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })
})

describe('runPlannedRestartCoordinator (stale lifecycle recheck after drain)', () => {
  it('does not run restartDaemonProcess when the plan turns terminal mid-drain', async () => {
    // The plan starts nonterminal (stopping). After waitForStableDrain
    // completes (two consecutive zero samples), the recheck reads the raw plan
    // and sees phase !== 'stopping' — the lifecycle must NOT run.
    let statusCalls = 0
    let currentPhase: PlannedRestartPhase = 'stopping'
    const active = { tasks: 0, wf: 0, exec: 0 }

    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })
    // Wrap both status() and readRawPlan() to flip the phase to terminal after
    // the drain completes. waitForStableDrain calls status() twice (two zero
    // samples); subsequent calls (including readRawPlan in the recheck) see
    // the terminal phase.
    const originalStatus = fake.dispatch.status
    const originalReadRawPlan = fake.dispatch.readRawPlan
    fake.dispatch.status = () => {
      statusCalls++
      if (statusCalls > 1) currentPhase = 'completed'
      const result = originalStatus()
      if (result.plannedRestart) {
        result.plannedRestart.phase = currentPhase
      }
      return result
    }
    fake.dispatch.readRawPlan = (op: string) => {
      const raw = originalReadRawPlan(op)
      if (raw) return { ...raw, phase: currentPhase }
      return raw
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => downStatus()

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false, 'restartDaemonProcess must not run on a terminal plan')
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })

  it('does not run restartDaemonProcess when the plan vanishes mid-drain', async () => {
    let statusCalls = 0
    let planVisible = true
    const active = { tasks: 0, wf: 0, exec: 0 }

    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })
    const originalStatus = fake.dispatch.status
    const originalReadRawPlan = fake.dispatch.readRawPlan
    fake.dispatch.status = () => {
      statusCalls++
      if (statusCalls > 1) planVisible = false
      const result = originalStatus()
      if (!planVisible) {
        return {
          ...result,
          mode: 'accepting' as const,
          accepting: true,
          frozen: false,
          plannedRestart: null,
        }
      }
      return result
    }
    fake.dispatch.readRawPlan = (op: string) => {
      if (!planVisible) return null
      return originalReadRawPlan(op)
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => downStatus()

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false, 'restartDaemonProcess must not run when the plan vanished')
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })

  it('does not run restartDaemonProcess when a replacement coordinator moved phase to verifying', async () => {
    // A replacement coordinator already ran the lifecycle and moved the plan
    // to 'verifying'. The stale coordinator's post-drain recheck sees
    // phase !== 'stopping' and returns without running the lifecycle.
    let statusCalls = 0
    let currentPhase: PlannedRestartPhase = 'stopping'
    const active = { tasks: 0, wf: 0, exec: 0 }

    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })
    const originalStatus = fake.dispatch.status
    const originalReadRawPlan = fake.dispatch.readRawPlan
    fake.dispatch.status = () => {
      statusCalls++
      if (statusCalls > 1) currentPhase = 'verifying'
      const result = originalStatus()
      if (result.plannedRestart) {
        result.plannedRestart.phase = currentPhase
      }
      return result
    }
    fake.dispatch.readRawPlan = (op: string) => {
      const raw = originalReadRawPlan(op)
      if (raw) return { ...raw, phase: currentPhase }
      return raw
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    // Handoff check returns down; after the recheck returns (phase 'verifying'),
    // the engine enters handleVerifying which needs a healthy status to complete
    // quickly without timing out.
    let collectCalls = 0
    const collectForemanStatus = async () => {
      collectCalls++
      if (collectCalls === 1) return downStatus() // handoff check
      return healthyStatus(OPERATION_ID) // handleVerifying
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false, 'restartDaemonProcess must not run when phase is verifying')
  })

  it('proceeds with restartDaemonProcess when phase is stopping and pid matches', async () => {
    // The happy path: after drain, the plan is still 'stopping' and the
    // coordinator_pid is null (or matches this process). The recheck passes
    // and the lifecycle runs.
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => {
      if (restartCalled) return healthyStatus(OPERATION_ID)
      return downStatus()
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, true, 'restartDaemonProcess must run when phase is stopping with matching pid')
    assert.equal(fake.completeCalls, 1)
  })

  it('does not run restartDaemonProcess when coordinator_pid is a foreign pid', async () => {
    // The plan is still 'stopping' but coordinator_pid was overwritten by a
    // replacement coordinator. The recheck sees a foreign pid and returns.
    let statusCalls = 0
    const active = { tasks: 0, wf: 0, exec: 0 }
    const FOREIGN_PID = 99999

    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'stopping',
      getActive: () => active,
    })
    const originalReadRawPlan = fake.dispatch.readRawPlan
    const originalStatus = fake.dispatch.status
    fake.dispatch.status = () => {
      statusCalls++
      return originalStatus()
    }
    fake.dispatch.readRawPlan = (op: string) => {
      const raw = originalReadRawPlan(op)
      if (raw && statusCalls > 1) {
        return { ...raw, coordinator_pid: FOREIGN_PID }
      }
      return raw
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => downStatus()

    await runPlannedRestartCoordinator(
      baseOptions({ coordinatorPid: process.pid }),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, false, 'restartDaemonProcess must not run when coordinator_pid is foreign')
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
  })
})

describe('runPlannedRestartCoordinator (mid-run ownership check)', () => {
  it('exits without driving when coordinator_pid is a foreign pid (loser child)', async () => {
    // Two children self-stamp; the one whose pid was overwritten sees a
    // foreign coordinator_pid at the engine's loop-top ownership check and
    // exits 0 without driving the engine.
    const active = { tasks: 0, wf: 0, exec: 0 }
    const FOREIGN_PID = 88888
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive: () => active,
    })
    // The durable plan has a foreign coordinator_pid (the winner's pid).
    const originalReadRawPlan = fake.dispatch.readRawPlan
    fake.dispatch.readRawPlan = (op: string) => {
      const raw = originalReadRawPlan(op)
      if (raw) return { ...raw, coordinator_pid: FOREIGN_PID }
      return raw
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    let statusCalls = 0
    const collectForemanStatus = async () => {
      statusCalls++
      return healthyStatus(OPERATION_ID)
    }

    await runPlannedRestartCoordinator(
      baseOptions({ coordinatorPid: process.pid }),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    // The loser exits without any side effects.
    assert.equal(restartCalled, false, 'loser must not run the lifecycle')
    assert.equal(fake.completeCalls, 0)
    assert.equal(fake.abortCalls, 0)
    assert.equal(fake.failCalls.length, 0)
    assert.equal(statusCalls, 0, 'loser must not collect status')
  })

  it('proceeds when coordinator_pid is null (not yet stamped during startup)', async () => {
    // Before self-stamp, coordinator_pid is null. The engine treats null as
    // "not yet stamped by anyone; proceed" — this is the startup window.
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive: () => active,
    })
    // readRawPlan returns coordinator_pid: null (not yet stamped).
    const originalReadRawPlan = fake.dispatch.readRawPlan
    fake.dispatch.readRawPlan = (op: string) => {
      const raw = originalReadRawPlan(op)
      if (raw) return { ...raw, coordinator_pid: null }
      return raw
    }

    let restartCalled = false
    const restartDaemonProcess = async () => {
      restartCalled = true
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () =>
      restartCalled ? healthyStatus(OPERATION_ID) : downStatus()

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    assert.equal(restartCalled, true, 'engine must proceed when pid is null')
    assert.equal(fake.completeCalls, 1)
  })
})

describe('runPlannedRestartCoordinator (no caller exclusion)', () => {
  it('passes only operationId/options/hooks to dependencies', async () => {
    const active = { tasks: 0, wf: 0, exec: 0 }
    const fake = makeFakeDispatch({
      operationId: OPERATION_ID,
      kind: 'restart',
      initialPhase: 'draining',
      getActive: () => active,
    })
    const updateArgs: unknown[][] = []
    const restartArgs: unknown[][] = []
    let restartCalled = false
    const restartDaemonProcess = async (...args: unknown[]) => {
      restartArgs.push(args)
      restartCalled = true
      const hooks = args[1] as { onStopped?: () => void | Promise<void> } | undefined
      if (hooks?.onStopped) await hooks.onStopped()
      return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
    }
    const collectForemanStatus = async () => (restartCalled ? healthyStatus(OPERATION_ID) : downStatus())

    const originalUpdate = fake.dispatch.updatePlannedRestart
    fake.dispatch.updatePlannedRestart = (...args: unknown[]) => {
      updateArgs.push(args)
      return originalUpdate(...(args as [string, Record<string, unknown>]))
    }

    await runPlannedRestartCoordinator(
      baseOptions(),
      baseDeps(fake.dispatch, { restartDaemonProcess, collectForemanStatus }),
    )

    for (const args of updateArgs) {
      assert.equal(args.length, 2, 'updatePlannedRestart takes exactly (operationId, patch)')
      assert.equal(args[0], OPERATION_ID)
      assert.ok(typeof args[1] === 'object' && args[1] !== null)
    }
    assert.equal(restartArgs.length, 1)
    assert.equal(restartArgs[0].length, 2, 'restartDaemonProcess takes exactly (options, hooks)')
  })
})

describe('waitForPlanTerminal (liveness observation)', () => {
  it('returns null when a nonterminal plan has a dead coordinator pid', async () => {
    let callCount = 0
    const dispatch: PlannedRestartCoordinatorDispatch = {
      status: () => {
        callCount++
        return {
          mode: 'planned_restart',
          frozen: false,
          accepting: false,
          plannedRestart: {
            operationId: 'op_x',
            kind: 'restart',
            phase: 'draining',
            recoveryRequired: false,
            createdAt: '2026-07-14T00:00:00.000Z',
          },
          activeTasks: [],
          activeTaskCount: 0,
          activeWorkflows: [],
          activeWorkflowCount: 0,
          activeExecutions: [],
          activeExecutionCount: 0,
        }
      },
      updatePlannedRestart: () => {},
      completePlannedRestart: () => {},
      abortPlannedRestart: () => {},
      failPlannedRestart: () => {},
    }
    const result = await waitForPlanTerminal(
      dispatch,
      'op_x',
      5,
      async () => {},
      () => false, // coordinator is dead
    )
    assert.equal(result, null)
    assert.ok(callCount > 0, 'status was polled at least once')
  })

  it('keeps waiting when coordinator pid is not yet stamped (isAlive returns true)', async () => {
    let polls = 0
    let terminal = false
    const dispatch: PlannedRestartCoordinatorDispatch = {
      status: () => {
        polls++
        return {
          mode: 'planned_restart',
          frozen: false,
          accepting: false,
          plannedRestart: terminal
            ? { operationId: 'op_x', kind: 'restart', phase: 'completed', recoveryRequired: false, createdAt: 'x' }
            : { operationId: 'op_x', kind: 'restart', phase: 'draining', recoveryRequired: false, createdAt: 'x' },
          activeTasks: [],
          activeTaskCount: 0,
          activeWorkflows: [],
          activeWorkflowCount: 0,
          activeExecutions: [],
          activeExecutionCount: 0,
        }
      },
      updatePlannedRestart: () => {},
      completePlannedRestart: () => {},
      abortPlannedRestart: () => {},
      failPlannedRestart: () => {},
    }
    const sleep = async () => {
      if (polls === 2) terminal = true
    }
    // isAlive returns true (null pid → keep waiting), so the wait continues
    // until the plan reaches terminal.
    const result = await waitForPlanTerminal(dispatch, 'op_x', 1, sleep, () => true)
    assert.ok(result)
    assert.equal(result!.phase, 'completed')
  })
})

// ── Real update provider (git-backed preparation) ───────────────────────────

const UPDATE_OLD_HEAD = 'a'.repeat(40)
const UPDATE_NEW_HEAD = 'b'.repeat(40)

/** Build a deterministic git executor that records every invocation. */
function updateGitExecutor(opts: {
  checkoutRoot: string
  oldHead: string
  /** Current HEAD seen by `rev-parse HEAD` before any pull (or for recovery). */
  headValue: string
  /** HEAD seen by `rev-parse HEAD` after a successful `git pull` (fresh path). */
  postPullHead?: string
  originMainValue?: string
  pullStdout?: string
  /** Branch returned by `symbolic-ref --quiet --short HEAD`; defaults to `main`. */
  symbolicRefValue?: string
  calls?: string[][]
  fail?: { match: (args: readonly string[]) => boolean; code: string; stderr: string }
}): ForemanUpdateGitExecutor {
  let pulled = false
  return async (args, _execOptions) => {
    if (opts.calls) opts.calls.push([...args])
    if (opts.fail && opts.fail.match(args)) {
      throw new ForemanUpdateGitError(opts.fail.code, opts.fail.stderr)
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: opts.checkoutRoot, stderr: '' }
    if (args[0] === 'symbolic-ref' && args[1] === '--quiet' && args[2] === '--short' && args[3] === 'HEAD') {
      return { stdout: opts.symbolicRefValue ?? 'main', stderr: '' }
    }
    if (args[0] === 'status') return { stdout: '', stderr: '' }
    if (args[0] === 'remote') return { stdout: 'git@example:fore/man.git', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
      return { stdout: pulled ? (opts.postPullHead ?? opts.headValue) : opts.headValue, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && typeof args[2] === 'string' && args[2].startsWith('refs/remotes/')) {
      return { stdout: opts.originMainValue ?? opts.oldHead, stderr: '' }
    }
    if (args[0] === 'pull') {
      pulled = true
      return { stdout: opts.pullStdout ?? `Fast-forward ${opts.oldHead}..${opts.postPullHead ?? opts.headValue}`, stderr: '' }
    }
    // merge-base --is-ancestor (reconciliation) succeeds with empty output.
    if (args[0] === 'merge-base') return { stdout: '', stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function buildUpdateProvider(
  fake: FakeDispatch,
  git: ForemanUpdateGit,
  clock: () => Date = () => new Date('2026-07-14T00:00:05.000Z'),
  prepareSuite: SuiteUpdatePreparer = { prepare: async () => {} },
) {
  return createForemanUpdatePreparationProvider({
    git,
    dispatch: {
      status: fake.dispatch.status,
      readRawPlan: (op) => fake.dispatch.readRawPlan(op),
      updatePlannedRestart: fake.dispatch.updatePlannedRestart,
    },
    clock,
    prepareSuite,
  })
}

interface UpdateScenario {
  fake: FakeDispatch
  git: ForemanUpdateGit
  provider: ReturnType<typeof buildUpdateProvider>
  updateCalls: Record<string, unknown>[]
  gitCalls: string[][]
  collectStatusCalls: number
  restartCalled: boolean
  preparedRoots: string[]
  preparedWithNewHead: string | null | undefined
}

function runUpdateScenario(opts: {
  initialPhase: PlannedRestartPhase
  oldHead: string
  newHead?: string | null
  executor: ForemanUpdateGitExecutor
  gitCalls: string[][]
  checkoutRoot: string
  getActive?: () => { tasks: number; wf: number; exec: number }
  sleep?: () => Promise<void>
  prepareSuite?: SuiteUpdatePreparer
}): Promise<UpdateScenario> {
  const fake = makeFakeDispatch({
    operationId: OPERATION_ID,
    kind: 'update',
    initialPhase: opts.initialPhase,
    checkoutPath: opts.checkoutRoot,
    oldHead: opts.oldHead,
    ...(opts.newHead !== undefined ? { newHead: opts.newHead } : {}),
    getActive: opts.getActive ?? (() => ({ tasks: 0, wf: 0, exec: 0 })),
  })
  const git = new ForemanUpdateGit(opts.checkoutRoot, { executor: opts.executor })
  // Install the recording wrapper before building the provider so the provider
  // captures the wrapper and the failure/update metadata becomes observable.
  const updateCalls: Record<string, unknown>[] = []
  const originalUpdate = fake.dispatch.updatePlannedRestart
  fake.dispatch.updatePlannedRestart = (op, u) => {
    updateCalls.push(u)
    originalUpdate(op, u)
  }
  // Recording suite preparation: never touches the real checkout. It captures
  // the checkout root and the durable new_head visible at preparation time so
  // tests can assert that preparation follows new_head persistence, then
  // delegates to an injected preparer (default no-op).
  const preparedRoots: string[] = []
  let preparedWithNewHead: string | null | undefined
  const prepareSuite: SuiteUpdatePreparer = {
    prepare: async (checkoutPath) => {
      preparedRoots.push(checkoutPath)
      preparedWithNewHead = fake.rawPlan.new_head
      fake.events.push('prepare-suite')
      if (opts.prepareSuite) await opts.prepareSuite.prepare(checkoutPath)
    },
  }
  const provider = buildUpdateProvider(fake, git, undefined, prepareSuite)
  const gitCalls = opts.gitCalls
  let restartCalled = false
  let collectStatusCalls = 0
  const restartDaemonProcess = async (_o: unknown, hooks?: { onStopped?: () => void | Promise<void> }) => {
    restartCalled = true
    fake.events.push('restart')
    if (hooks?.onStopped) await hooks.onStopped()
    return { ipcPath: '/ipc', httpUrl: 'http://x', statePath: '/state', logPaths: { stdout: '/o', stderr: '/e' } } as DaemonLifecycleResult
  }
  const collectForemanStatus = async () => {
    collectStatusCalls++
    return restartCalled ? healthyStatus(OPERATION_ID) : downStatus()
  }
  return runPlannedRestartCoordinator(
    baseOptions({ providers: [provider] }),
    baseDeps(fake.dispatch, {
      sleep: opts.sleep ?? (async () => {}),
      restartDaemonProcess,
      collectForemanStatus,
    }),
  ).then(() => ({
    fake,
    git,
    provider,
    updateCalls,
    gitCalls,
    collectStatusCalls,
    restartCalled,
    preparedRoots,
    preparedWithNewHead,
  }))
}

describe('runPlannedRestartCoordinator (real update provider, happy path)', () => {
  it('drains naturally, pulls once after drain, persists new_head, restarts, completes', async () => {
      const checkoutRoot = mkdtempSync(join(tmpdir(), 'foreman-update-coord-'))
      try {
        const gitCalls: string[][] = []
        const executor = updateGitExecutor({
          checkoutRoot,
          oldHead: UPDATE_OLD_HEAD,
          headValue: UPDATE_OLD_HEAD,
          postPullHead: UPDATE_NEW_HEAD,
          calls: gitCalls,
        })
        // Hold each independent active count nonzero at some point, like restart.
        const samples = [
          { tasks: 2, wf: 0, exec: 0 },
          { tasks: 0, wf: 4, exec: 0 },
          { tasks: 0, wf: 0, exec: 9 },
          { tasks: 0, wf: 0, exec: 0 },
          { tasks: 0, wf: 0, exec: 0 },
        ]
        let cursor = 0
        const getActive = () => samples[Math.min(cursor, samples.length - 1)]
        const sleep = async () => { cursor++ }

        const { fake, updateCalls, restartCalled, preparedRoots, preparedWithNewHead } = await runUpdateScenario({
          initialPhase: 'draining',
          oldHead: UPDATE_OLD_HEAD,
          executor,
          gitCalls,
          checkoutRoot,
          getActive,
          sleep,
        })

      assert.equal(fake.completeCalls, 1)
      assert.equal(fake.abortCalls, 0)
      assert.equal(fake.failCalls.length, 0)
      assert.equal(restartCalled, true)

      // Exact order: draining -> updating -> stopping -> restart -> verifying -> complete.
      const order = fake.events
      assert.ok(order.indexOf('phase:draining') < order.indexOf('phase:updating'))
      assert.ok(order.indexOf('phase:updating') < order.indexOf('phase:stopping'))
      assert.ok(order.indexOf('phase:stopping') < order.indexOf('restart'))
      assert.ok(order.indexOf('restart') < order.indexOf('phase:verifying'))
      assert.ok(order.indexOf('phase:verifying') < order.indexOf('complete'))

      // Stable drain waited for all three independent nonzero counts to clear.
      assert.ok(fake.statusLog.some((s) => s.tasks > 0))
      assert.ok(fake.statusLog.some((s) => s.wf > 0))
      assert.ok(fake.statusLog.some((s) => s.exec > 0))

      // The pull happened exactly once, only after the drain, and new_head was persisted.
      const pullCalls = gitCalls.filter((c) => c[0] === 'pull')
      assert.equal(pullCalls.length, 1)
      const newHeadUpdate = updateCalls.find((u) => (u as { new_head?: unknown }).new_head)
      assert.ok(newHeadUpdate, 'expected a durable new_head update')
      assert.equal((newHeadUpdate as { new_head: string }).new_head, UPDATE_NEW_HEAD)
      assert.equal((newHeadUpdate as { checkout_path?: string }).checkout_path, checkoutRoot)
      assert.equal((newHeadUpdate as { old_head?: string }).old_head, UPDATE_OLD_HEAD)

      // Suite preparation ran exactly once, against the pulled checkout, and
      // only after the new HEAD was durably persisted — before the restart.
      assert.deepEqual(preparedRoots, [checkoutRoot])
      assert.equal(preparedWithNewHead, UPDATE_NEW_HEAD)
      assert.ok(order.indexOf('prepare-suite') > order.indexOf('phase:updating'))
      assert.ok(order.indexOf('prepare-suite') < order.indexOf('phase:stopping'))
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  })
})

describe('runPlannedRestartCoordinator (real update provider, pre-stop failures)', () => {
  const scenarios: Array<{
    name: string
    oldHead: string
    symbolicRefValue?: string
    fail: { match: (args: readonly string[]) => boolean; code: string; stderr: string }
  }> = [
    {
      name: 'HEAD changed recheck',
      oldHead: UPDATE_OLD_HEAD,
      fail: { match: (a) => false, code: 'head_mismatch', stderr: 'head moved' },
    },
    {
      name: 'dirty worktree',
      oldHead: UPDATE_OLD_HEAD,
      fail: { match: (a) => a[0] === 'status', code: 'dirty_checkout', stderr: 'dirty' },
    },
    {
      name: 'branch changed',
      oldHead: UPDATE_OLD_HEAD,
      symbolicRefValue: 'feature',
      fail: { match: (a) => false, code: 'wrong_branch', stderr: 'on feature' },
    },
    {
      name: 'origin disappeared',
      oldHead: UPDATE_OLD_HEAD,
      fail: { match: (a) => a[0] === 'remote', code: 'origin_missing', stderr: 'no origin' },
    },
    {
      name: 'divergent pull',
      oldHead: UPDATE_OLD_HEAD,
      fail: { match: (a) => a[0] === 'pull', code: 'git_failed', stderr: 'non-fast-forward' },
    },
  ]

  for (const scenario of scenarios) {
    it(`aborts without stopping the daemon when ${scenario.name} fails`, async () => {
      const checkoutRoot = mkdtempSync(join(tmpdir(), 'foreman-update-fail-'))
      try {
        // HEAD-changed recheck: git HEAD no longer equals the snapshot old_head.
        const headValue = scenario.name === 'HEAD changed recheck' ? 'd'.repeat(40) : UPDATE_OLD_HEAD
        const gitCalls: string[][] = []
        const executor = updateGitExecutor({
          checkoutRoot,
          oldHead: scenario.oldHead,
          headValue,
          calls: gitCalls,
          ...(scenario.symbolicRefValue !== undefined ? { symbolicRefValue: scenario.symbolicRefValue } : {}),
          fail: scenario.fail,
        })
        const { fake, updateCalls, restartCalled, collectStatusCalls } = await runUpdateScenario({
          initialPhase: 'draining',
          oldHead: scenario.oldHead,
          executor,
          gitCalls,
          checkoutRoot,
        })

        // Pre-stop boundary: abort restores prior admission, no lifecycle, no health.
        assert.equal(fake.abortCalls, 1)
        assert.equal(fake.completeCalls, 0)
        assert.equal(fake.failCalls.length, 0)
        assert.equal(restartCalled, false)
        assert.equal(collectStatusCalls, 0)
        // Prior (accepting) admission is restored; no recovery required.
        assert.equal(fake.dispatch.status().mode, 'accepting')

        // The provider persisted the fixed failure metadata before rethrowing.
        const failureUpdate = updateCalls.find((u) => (u as { error_code?: unknown }).error_code)
        assert.ok(failureUpdate, 'expected a failure metadata update')
        assert.equal((failureUpdate as { error_code: string }).error_code, scenario.fail.code)
        assert.equal((failureUpdate as { checkout_path?: string }).checkout_path, checkoutRoot)
        assert.equal((failureUpdate as { old_head?: string }).old_head, scenario.oldHead)
        assert.equal(typeof (failureUpdate as { failed_at: string }).failed_at, 'string')
      } finally {
        rmSync(checkoutRoot, { recursive: true, force: true })
      }
    })
  }

  it('aborts before restart when suite preparation fails, retaining the persisted new_head', async () => {
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'foreman-update-prepfail-'))
    try {
      const gitCalls: string[][] = []
      const executor = updateGitExecutor({
        checkoutRoot,
        oldHead: UPDATE_OLD_HEAD,
        headValue: UPDATE_OLD_HEAD,
        postPullHead: UPDATE_NEW_HEAD,
        calls: gitCalls,
      })
      const { fake, updateCalls, restartCalled, collectStatusCalls, preparedRoots } = await runUpdateScenario({
        initialPhase: 'draining',
        oldHead: UPDATE_OLD_HEAD,
        executor,
        gitCalls,
        checkoutRoot,
        prepareSuite: { prepare: async () => { throw new Error('suite prep boom') } },
      })

      // Pre-stop boundary: abort restores prior admission; no lifecycle, no health.
      assert.equal(fake.abortCalls, 1)
      assert.equal(fake.completeCalls, 0)
      assert.equal(fake.failCalls.length, 0)
      assert.equal(restartCalled, false)
      assert.equal(collectStatusCalls, 0)
      assert.equal(fake.dispatch.status().mode, 'accepting')
      // Preparation was attempted exactly once against the checkout root.
      assert.deepEqual(preparedRoots, [checkoutRoot])

      // Failure metadata is durable while checkout/old/new head are retained.
      const failureUpdate = updateCalls.find((u) => (u as { error_code?: unknown }).error_code)
      assert.ok(failureUpdate, 'expected a failure metadata update')
      assert.equal((failureUpdate as { error_code: string }).error_code, 'suite_preparation_failed')
      assert.equal((failureUpdate as { checkout_path?: string }).checkout_path, checkoutRoot)
      assert.equal((failureUpdate as { old_head?: string }).old_head, UPDATE_OLD_HEAD)
      assert.equal((failureUpdate as { new_head?: string }).new_head, UPDATE_NEW_HEAD)
      assert.equal(typeof (failureUpdate as { failed_at: string }).failed_at, 'string')
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  })
})

describe('runPlannedRestartCoordinator (real update provider, updating-phase recovery)', () => {
  it('recovers with a persisted new_head without re-pulling, then stops/starts', async () => {
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'foreman-update-recov-'))
    try {
      const gitCalls: string[][] = []
      const executor = updateGitExecutor({
        checkoutRoot,
        oldHead: UPDATE_OLD_HEAD,
        headValue: UPDATE_NEW_HEAD,
        calls: gitCalls,
      })
      const { fake, restartCalled } = await runUpdateScenario({
        initialPhase: 'updating',
        oldHead: UPDATE_OLD_HEAD,
        newHead: UPDATE_NEW_HEAD,
        executor,
        gitCalls,
        checkoutRoot,
      })

      assert.equal(fake.completeCalls, 1)
      assert.equal(fake.abortCalls, 0)
      assert.equal(restartCalled, true)
      // Recovery with a persisted new_head reconciles without running `git pull`.
      assert.equal(gitCalls.filter((c) => c[0] === 'pull').length, 0)
      assert.ok(gitCalls.some((c) => c[0] === 'rev-parse' && c[2] === 'HEAD'))
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  })

  it('aborts when new_head is absent and HEAD moved (normal pull fails on head_mismatch)', async () => {
    // The provider unconditionally runs a normal pull when new_head is absent.
    // If the checkout HEAD already moved (interrupted pull that completed but
    // never persisted new_head), the normal pull's head_mismatch guard fires
    // and the coordinator aborts with prior admission restored.
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'foreman-update-recov-headmoved-'))
    try {
      const gitCalls: string[][] = []
      const executor = updateGitExecutor({
        checkoutRoot,
        oldHead: UPDATE_OLD_HEAD,
        headValue: UPDATE_NEW_HEAD, // HEAD moved past old_head
        calls: gitCalls,
      })
      const { fake, restartCalled } = await runUpdateScenario({
        initialPhase: 'updating',
        oldHead: UPDATE_OLD_HEAD,
        newHead: null, // no persisted new_head -> normal pull path
        executor,
        gitCalls,
        checkoutRoot,
      })

      assert.equal(fake.abortCalls, 1)
      assert.equal(fake.completeCalls, 0)
      assert.equal(restartCalled, false)
      assert.equal(gitCalls.filter((c) => c[0] === 'pull').length, 0)
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  })
})
