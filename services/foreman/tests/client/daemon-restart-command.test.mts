import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

import {
  handleDaemonRestart,
  type DaemonRestartCommandDeps,
} from '../../lib/client/cli/commands/daemon.mts'
import type {
  LaunchPlannedRestartOptions,
} from '../../lib/client/cli/planned-restart-launcher.mts'
import type {
  PlannedRestartKind,
  PlannedRestartPhase,
  PlannedRestartPlanSummary,
  PlannedRestartStore,
} from '../../lib/daemon/planned-restart-store.mts'
import type { DispatchControl, DispatchStatus } from '../../lib/daemon/dispatch-control.mts'
import type { ForemanStatus } from '../../lib/client/cli/shared.mts'

// A real, loadable config so handleDaemonRestart can pass the `service.enabled`
// guard without contacting any daemon.
const configDir = mkdtempSync(join(tmpdir(), 'foreman-restart-cmd-'))
const configPath = join(configDir, 'config.json')
writeFileSync(configPath, JSON.stringify({
  clients: {},
  service: { enabled: true, bind: '127.0.0.1:8731' },
  workspace: {},
  pet: { enabled: false },
  message: { enabled: false },
  messageDelivery: { enabled: false },
}, null, 2))

function healthyStatus(operationId: string): ForemanStatus {
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
    phase: 'verifying',
  } as ForemanStatus
}

interface RestartPlanState {
  plannedRestart: PlannedRestartPlanSummary | null
  /** coordinator pid reported by the store; undefined means no durable plan. */
  coordinatorPid?: number
  /** Admission mode; defaults to planned_restart when a plan is active, accepting otherwise. */
  mode?: 'accepting' | 'frozen' | 'planned_restart'
}

function planSummary(
  operationId: string,
  kind: PlannedRestartKind,
  phase: PlannedRestartPhase,
  recoveryRequired = false,
): PlannedRestartPlanSummary {
  return { operationId, kind, phase, recoveryRequired, createdAt: new Date().toISOString() }
}

interface Harness {
  deps: DaemonRestartCommandDeps
  launchCalls: LaunchPlannedRestartOptions[]
  beginCalls: unknown[][]
  waitCalls: string[]
}

function buildHarness(state: RestartPlanState, commandEnv?: NodeJS.ProcessEnv): Harness {
  const launchCalls: LaunchPlannedRestartOptions[] = []
  const beginCalls: unknown[][] = []
  const waitCalls: string[] = []

  const mode = state.mode ?? (state.plannedRestart ? 'planned_restart' : 'accepting')
  const dispatchControl = {
    status: (): DispatchStatus => ({
      mode,
      frozen: mode === 'frozen',
      accepting: mode === 'accepting',
      plannedRestart: state.plannedRestart,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    }),
    beginPlannedRestart: (...args: unknown[]) => {
      beginCalls.push(args)
    },
    updatePlannedRestart: (_op: string, _patch: Record<string, unknown>) => {},
    completePlannedRestart: () => {},
    abortPlannedRestart: () => {},
    failPlannedRestart: () => {},
  }

  const plannedRestartStore = {
    snapshot: () => ({
      mode,
      plan: state.coordinatorPid === undefined ? null : ({ coordinator_pid: state.coordinatorPid } as unknown),
    }),
  }

  const deps: DaemonRestartCommandDeps = {
    plannedRestartStore: plannedRestartStore as unknown as PlannedRestartStore,
    dispatchControl: dispatchControl as unknown as DispatchControl,
    launchCoordinator: async (_d, options) => {
      launchCalls.push(options)
      return { child: {} as ChildProcess, pid: 4242 }
    },
    waitForPlanTerminal: async (_dc, operationId) => {
      waitCalls.push(operationId)
      return planSummary(operationId, 'restart', 'completed')
    },
    collectForemanStatus: async () => healthyStatus('op_captured'),
    acquireLock: async () => ({ release: () => {} }),
    commandEnv,
  }

  return { deps, launchCalls, beginCalls, waitCalls }
}

async function runWithCapture(args: string[], deps: DaemonRestartCommandDeps) {
  const logs: string[] = []
  const original = console.log
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  }
  let code = 0
  try {
    code = await handleDaemonRestart(args, deps)
  } finally {
    console.log = original
  }
  return { output: logs.join('\n'), code }
}

function assertNoCallerId(calls: LaunchPlannedRestartOptions[]): void {
  for (const call of calls) {
    assert.equal(
      'callerId' in call,
      false,
      'the planned restart must not pass a caller id to the coordinator',
    )
  }
}

// The command never performs an inline stop/start; the detached coordinator owns
// the restart lifecycle. The deps contract exposes no restartDaemonProcess hook.
function assertNoDirectRestart(deps: DaemonRestartCommandDeps): void {
  assert.equal(
    'restartDaemonProcess' in deps,
    false,
    'handleDaemonRestart must not expose a direct restartDaemonProcess escape hatch',
  )
}

const TASK_ENV = { FOREMAN_TASK_RUN_ID: 'run_unit_1' } as NodeJS.ProcessEnv
const HUMAN_ENV = {} as NodeJS.ProcessEnv

describe('handleDaemonRestart (task context auto no-wait)', () => {
  it('schedules a fresh planned restart and returns scheduled JSON without waiting', async () => {
    const harness = buildHarness({ plannedRestart: null }, TASK_ENV)
    assertNoDirectRestart(harness.deps)

    const { output, code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1, 'expected a fresh launch')
    assert.equal(harness.beginCalls.length, 1, 'fresh path must beginPlan before spawning')
    assert.equal(harness.waitCalls.length, 0, 'task context must not wait for the terminal state')
    assertNoCallerId(harness.launchCalls)

    const parsed = JSON.parse(output) as {
      operation_id?: string
      scheduled?: boolean
      joining?: boolean
    }
    assert.equal(parsed.scheduled, true)
    assert.equal(parsed.joining, false)
    assert.ok(typeof parsed.operation_id === 'string' && parsed.operation_id.length > 0)
  })
})

describe('handleDaemonRestart (human explicit --no-wait)', () => {
  it('schedules then returns without invoking the terminal wait', async () => {
    const harness = buildHarness({ plannedRestart: null }, HUMAN_ENV)

    const { output, code } = await runWithCapture(
      ['--config', configPath, '--no-wait'],
      harness.deps,
    )

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1)
    assert.equal(harness.waitCalls.length, 0, '--no-wait must skip the terminal wait')
    assert.match(output, /scheduled/u)
    assertNoCallerId(harness.launchCalls)
  })
})

describe('handleDaemonRestart (human waits by default)', () => {
  it('waits for the exact scheduled operation and reports operation_id/phase/restart_result/health_result', async () => {
    const harness = buildHarness({ plannedRestart: null }, HUMAN_ENV)
    const { output, code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1)
    assert.equal(harness.waitCalls.length, 1, 'human default must wait for the terminal state')
    assert.equal(harness.waitCalls[0], harness.launchCalls[0].operationId)
    assert.match(output, new RegExp(harness.launchCalls[0].operationId))
    assert.match(output, /completed/u)
  })

  it('human --json emits the machine-readable terminal fields', async () => {
    const harness = buildHarness({ plannedRestart: null }, HUMAN_ENV)

    const { output } = await runWithCapture(
      ['--config', configPath, '--json'],
      harness.deps,
    )

    const parsed = JSON.parse(output) as {
      operation_id?: string
      scheduled?: boolean
      phase?: string
      restart_result?: string
      health_result?: unknown
    }
    assert.equal(parsed.scheduled, false)
    assert.equal(parsed.operation_id, harness.launchCalls[0].operationId)
    assert.equal(parsed.phase, 'completed')
    assert.equal(parsed.restart_result, 'completed')
    assert.ok(parsed.health_result !== undefined, 'health_result must be reported')
  })
})

describe('handleDaemonRestart (terminal plan exit status)', () => {
  it('replaces a retained completed plan under accepting with a fresh restart', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_done', 'restart', 'completed'), mode: 'accepting' },
      TASK_ENV,
    )

    const { code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1, 'a retained completed plan is historical and a fresh restart replaces it')
    assert.equal(harness.beginCalls.length, 1, 'fresh path begins a new plan')
    assert.equal(harness.waitCalls.length, 0)
    assert.equal(harness.launchCalls[0].kind, 'restart')
  })

  it('replaces a retained failed non-recovery plan under accepting with a fresh restart', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_done', 'restart', 'failed', false), mode: 'accepting' },
      TASK_ENV,
    )

    const { code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1, 'a retained failed non-recovery plan is historical and a fresh restart replaces it')
    assert.equal(harness.beginCalls.length, 1)
    assert.equal(harness.waitCalls.length, 0)
    assert.equal(harness.launchCalls[0].kind, 'restart')
  })

  it('a retained completed update history under accepting does not conflict with a fresh restart', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_update_old', 'update', 'completed'), mode: 'accepting' },
      TASK_ENV,
    )

    const { code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 0)
    assert.equal(harness.launchCalls.length, 1, 'a retained opposite-kind completed history does not block a fresh restart')
    assert.equal(harness.beginCalls.length, 1)
    assert.equal(harness.launchCalls[0].kind, 'restart')
  })

  it('surfaces a failed (recovery-required) plan with exit 1 and does not retry', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_failed', 'restart', 'failed', true) },
      TASK_ENV,
    )

    const { output, code } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(code, 1, 'failed terminal plan must exit non-zero')
    assert.equal(harness.launchCalls.length, 0, 'a terminal plan must be surfaced, not retried')
    assert.equal(harness.beginCalls.length, 0, 'a terminal plan must not begin a new plan')
    assert.equal(harness.waitCalls.length, 0)
    const parsed = JSON.parse(output) as { restart_result?: string; phase?: string }
    assert.equal(parsed.phase, 'failed')
    assert.equal(parsed.restart_result, 'failed')
  })
})

describe('handleDaemonRestart (coordinator selection)', () => {
  it('joins a live restart coordinator instead of scheduling or resuming', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_live', 'restart', 'verifying'), coordinatorPid: process.pid },
      TASK_ENV,
    )

    const { output } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(harness.launchCalls.length, 0, 'a live coordinator must be joined, not scheduled')
    assert.equal(harness.beginCalls.length, 0, 'join must not begin a new plan')
    const parsed = JSON.parse(output) as { scheduled?: boolean; joining?: boolean; operation_id?: string }
    assert.equal(parsed.scheduled, true)
    assert.equal(parsed.joining, true)
    assert.equal(parsed.operation_id, 'op_live')
  })

  it('relaunches a dead coordinator in resume mode without beginPlan', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_dead', 'restart', 'draining'), coordinatorPid: 999999 },
      TASK_ENV,
    )

    const { output } = await runWithCapture(['--config', configPath], harness.deps)

    assert.equal(harness.launchCalls.length, 1, 'a dead coordinator must be resumed')
    assert.equal(harness.beginCalls.length, 0, 'resume must not begin a second plan')
    assertNoCallerId(harness.launchCalls)
    const parsed = JSON.parse(output) as { scheduled?: boolean; joining?: boolean; operation_id?: string }
    assert.equal(parsed.scheduled, true)
    assert.equal(parsed.joining, false)
    assert.equal(parsed.operation_id, 'op_dead')
  })
})

describe('handleDaemonRestart (active update plan)', () => {
  it('rejects an active planned update rather than restarting', async () => {
    const harness = buildHarness(
      { plannedRestart: planSummary('op_update', 'update', 'draining') },
      HUMAN_ENV,
    )

    await assert.rejects(
      runWithCapture(['--config', configPath], harness.deps),
      /planned update is currently active/u,
    )
    assert.equal(harness.launchCalls.length, 0)
    assert.equal(harness.beginCalls.length, 0)
  })
})
