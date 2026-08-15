import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import { suiteDir, loadServiceConfigForCli, type ForemanStatus } from '../shared.mts'
import { initDb } from '../../../db/connection.mts'
import { collectForemanStatus } from './status.mts'
import {
  type CoordinatorSpawn,
  type PlannedRestartLauncherDeps,
} from '../planned-restart-launcher.mts'
import { PlannedRestartStore } from '../../../daemon/planned-restart-store.mts'
import { DispatchControl } from '../../../daemon/dispatch-control.mts'
import {
  ForemanUpdateGit,
  type ForemanUpdateCheckoutSnapshot,
  type ForemanUpdatePullResult,
} from '../../../core/project/foreman-update.mts'
import type { PlannedRestartPhase, PlannedRestartPlanSummary } from '../../../daemon/planned-restart-store.mts'
import {
  runPlannedRestartCommand,
  type LaunchCoordinatorFn,
} from '../planned-restart-command.mts'

export interface ForemanUpdateScheduledResult {
  operation_id: string
  scheduled: true
  status_endpoint: string
}

export interface ForemanUpdateCompletedResult {
  operation_id: string
  phase: PlannedRestartPhase
  pull_result: Partial<ForemanUpdatePullResult>
  restart_result: 'completed' | 'failed' | null
  health_result: ForemanStatus | null
}

export type ForemanUpdateResult = ForemanUpdateScheduledResult | ForemanUpdateCompletedResult

export interface ForemanUpdateCommandDeps {
  plannedRestartStore?: PlannedRestartStore
  dispatchControl?: DispatchControl
  /** ForemanUpdateGit rooted at the resolved suiteDir (the checkout to update). */
  foremanUpdateGit?: ForemanUpdateGit
  launchCoordinator?: LaunchCoordinatorFn
  spawnProcess?: CoordinatorSpawn
  generateOperationId?: () => string
  isCoordinatorAlive?: (pid: number) => boolean
  waitForPlanTerminal?: typeof import('../planned-restart-coordinator.mts').waitForPlanTerminal
  collectForemanStatus?: typeof collectForemanStatus
  sleep?: (ms: number) => Promise<void>
  acquireLock?: () => Promise<{ release: () => void }>
  commandEnv?: NodeJS.ProcessEnv
}

function generateOperationId(): string {
  return `op_update_${randomBytes(12).toString('hex')}`
}

/**
 * Safe planned update of the Wrenyard suite checkout. From task context it schedules
 * (plan-first) and returns immediately; a human without --no-wait waits for
 * the same operation to reach a terminal state and reports the pull, restart,
 * and health results. It never performs the pull, stop/start, health polling,
 * caller exclusion, or plan completion itself — the detached coordinator owns
 * the lifecycle. An active restart plan is rejected; a terminal
 * recovery-required plan is surfaced, never retried implicitly.
 */
export async function handleUpdate(
  args: string[],
  deps: ForemanUpdateCommandDeps = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'no-wait': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log('Usage: wrenyard update [--config path] [--no-wait] [--json]')
    return 0
  }
  requireNoPositionals(positionals, 'wrenyard update [--config path] [--no-wait] [--json]')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon is disabled by config')

  // Initialize the SQLite connection (FOREMAN_DB_PATH or default state) so this
  // standalone CLI process can read dispatch status and schedule a plan.
  initDb(process.env.FOREMAN_DB_PATH)

  const store = deps.plannedRestartStore ?? new PlannedRestartStore()
  const dispatchControl = deps.dispatchControl ?? new DispatchControl(store)
  const commandEnv = deps.commandEnv ?? process.env
  const isTaskContext = Object.prototype.hasOwnProperty.call(commandEnv, 'FOREMAN_TASK_RUN_ID')
  const foremanUpdateGit = deps.foremanUpdateGit ?? new ForemanUpdateGit(suiteDir)
  const collectStatus = deps.collectForemanStatus ?? collectForemanStatus

  return runPlannedRestartCommand<ForemanUpdateResult>({
    kind: 'update',
    resolvedConfigPath,
    isTaskContext,
    noWait: values['no-wait'] === true,
    asJson: values.json === true,
    store,
    dispatchControl,
    ...(deps.launchCoordinator ? { launchCoordinator: deps.launchCoordinator } : {}),
    ...(deps.spawnProcess ? { spawnProcess: deps.spawnProcess } : {}),
    ...(deps.isCoordinatorAlive ? { isCoordinatorAlive: deps.isCoordinatorAlive } : {}),
    ...(deps.waitForPlanTerminal ? { waitForPlanTerminal: deps.waitForPlanTerminal } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.acquireLock ? { acquireLock: deps.acquireLock } : {}),
    generateOperationId: deps.generateOperationId ?? generateOperationId,
    hooks: {
      preflight: async (): Promise<ForemanUpdateCheckoutSnapshot> => foremanUpdateGit.preflight(),
      buildScheduledResult: ({ operationId }) => ({
        operation_id: operationId,
        scheduled: true,
        status_endpoint: 'wrenyard status --json',
      }),
      buildTerminalResult: async ({ operationId, terminal }) =>
        buildUpdateCompletedResult(store, operationId, collectStatus, resolvedConfigPath, terminal),
      printHuman: printUpdateHuman,
      exitCode: (result) =>
        (result as ForemanUpdateScheduledResult).scheduled === true
          ? 0
          : (result as ForemanUpdateCompletedResult).phase === 'completed'
            ? 0
            : 1,
      oppositeKindRejection:
        'A planned restart is currently active; update is not available until it completes or is recovered.',
    },
  })
}

/**
 * Build the exact waiting-human result. pull_result is read only from the
 * durable plan (old_head, optional new_head, optional error_code, optional
 * error_message). restart_result and health_result reuse the FU-002 values
 * (completed/failed) when the daemon lifecycle ran; both are null when the
 * failure occurred before stopping (the plan aborted, so terminal is null).
 */
async function buildUpdateCompletedResult(
  store: PlannedRestartStore,
  operationId: string,
  collectStatus: typeof collectForemanStatus,
  resolvedConfigPath: string,
  terminal: PlannedRestartPlanSummary | null,
): Promise<ForemanUpdateCompletedResult> {
  const plan = store.snapshot().plan
  const pullResult: Partial<ForemanUpdatePullResult> = {}
  if (plan?.old_head) pullResult.old_head = plan.old_head
  if (plan?.new_head) pullResult.new_head = plan.new_head
  if (plan?.error_code) pullResult.error_code = plan.error_code
  if (plan?.error_message) pullResult.error_message = plan.error_message

  let restartResult: 'completed' | 'failed' | null = null
  let healthResult: ForemanStatus | null = null
  const phase = terminal ? terminal.phase : 'failed'
  if (terminal && terminal.phase === 'completed') {
    restartResult = 'completed'
    healthResult = await collectStatus(resolvedConfigPath)
  } else if (terminal && terminal.phase === 'failed') {
    // A retained failed plan only exists for at/after-stop failures.
    restartResult = 'failed'
    healthResult = await collectStatus(resolvedConfigPath)
  }

  return {
    operation_id: operationId,
    phase,
    pull_result: pullResult,
    restart_result: restartResult,
    health_result: healthResult,
  }
}

function printUpdateHuman(result: ForemanUpdateResult): void {
  if ((result as ForemanUpdateScheduledResult).scheduled === true) {
    const scheduled = result as ForemanUpdateScheduledResult
    console.log(`Planned update ${scheduled.operation_id} scheduled. Track with: ${scheduled.status_endpoint}`)
    return
  }
  const completed = result as ForemanUpdateCompletedResult
  console.log(`operation_id: ${completed.operation_id}`)
  console.log(`phase: ${completed.phase}`)
  console.log(`pull_result: ${JSON.stringify(completed.pull_result)}`)
  console.log(`restart_result: ${completed.restart_result}`)
  console.log(`health_result: ${completed.health_result ? JSON.stringify(completed.health_result) : 'null'}`)
}
