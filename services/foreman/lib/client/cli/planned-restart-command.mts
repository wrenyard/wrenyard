import { sleep } from './shared.mts'
import { collectForemanStatus } from './commands/status.mts'
import { waitForPlanTerminal } from './planned-restart-coordinator.mts'
import {
  type CoordinatorSpawn,
  type LaunchPlannedRestartOptions,
  type PlannedRestartLauncherDeps,
  type PlannedRestartLauncherDispatch,
  isCoordinatorAlive,
  launchPlannedRestartCoordinator,
} from './planned-restart-launcher.mts'
import { acquirePlannedRestartLockAsync } from './planned-restart-lock.mts'
import type { ForemanStatus } from './shared.mts'
import type {
  PlannedRestartKind,
  PlannedRestartPlan,
  PlannedRestartPlanSummary,
  PlannedRestartStore,
} from '../../daemon/planned-restart-store.mts'
import type { ForemanUpdateCheckoutSnapshot } from '../../core/project/foreman-update.mts'

/**
 * Function the command uses to spawn the detached coordinator. The real
 * {@link launchPlannedRestartCoordinator} satisfies this; tests inject a fake
 * that records the options and returns a pid without spawning.
 */
export type LaunchCoordinatorFn = (
  deps: PlannedRestartLauncherDeps,
  options: LaunchPlannedRestartOptions,
) => Promise<{ pid: number }>

/**
 * Kind-specific hooks injected into the shared planned-restart command. The
 * helper owns the decision table, the beginPlan/spawn/pid/abort orchestration,
 * and the terminal wait; the hooks own everything kind-specific (preflight,
 * result shape, human output, exit-code mapping, opposite-kind rejection).
 */
export interface PlannedRestartCommandHooks<TResult> {
  /**
   * Fresh-only preflight. Update runs a git preflight and returns a validated
   * checkout snapshot; restart returns undefined (no preflight).
   */
  preflight?: () => Promise<ForemanUpdateCheckoutSnapshot | undefined>
  /** Build the scheduled (pre-terminal) result for this kind. */
  buildScheduledResult: (ctx: { operationId: string; joining: boolean }) => TResult
  /**
   * Build the terminal result. `terminal` is the waited-for summary, the
   * already-terminal active summary, or null if the wait observed a dead
   * coordinator / vanished plan. The hook closes over the store, status
   * collector, and resolved config path to read pull/health data as needed.
   */
  buildTerminalResult: (ctx: {
    operationId: string
    terminal: PlannedRestartPlanSummary | null
  }) => Promise<TResult>
  /** Build the human-readable (non-JSON) form for either result shape. */
  printHuman: (result: TResult) => void
  /** Exit code: 0 for scheduled/completed, 1 for failure. */
  exitCode: (result: TResult) => number
  /** Error message thrown when the active plan is the opposite kind. */
  oppositeKindRejection: string
}

export interface PlannedRestartCommandConfig<TResult> {
  kind: PlannedRestartKind
  resolvedConfigPath: string
  host?: string
  port?: string
  isTaskContext: boolean
  noWait: boolean
  asJson: boolean
  store: PlannedRestartStore
  dispatchControl: PlannedRestartLauncherDispatch
  launchCoordinator?: LaunchCoordinatorFn
  spawnProcess?: CoordinatorSpawn
  isCoordinatorAlive?: (pid: number) => boolean
  waitForPlanTerminal?: typeof waitForPlanTerminal
  sleep?: (ms: number) => Promise<void>
  /**
   * Acquire the CLI-side advisory lock that serializes the decide+launch
   * section. Defaults to {@link acquirePlannedRestartLockAsync}. Inject a fake
   * for tests that need deterministic lock behavior.
   */
  acquireLock?: () => Promise<{ release: () => void }>
  generateOperationId: () => string
  hooks: PlannedRestartCommandHooks<TResult>
}

/**
 * Shared planned-restart command orchestration. Implements the decision table
 * (fresh / join / resume / terminal / reject), the plan-first fresh
 * orchestration (beginPlan with null pid → spawn → stamp coordinator_pid →
 * abort on failure), the resume orchestration (spawn → stamp coordinator_pid),
 * and the optional human terminal wait with coordinator-liveness observation.
 *
 * Kind differences (preflight, result shape, human output, exit codes) are
 * injected via {@link PlannedRestartCommandHooks}. CLI args, JSON shapes,
 * human wording, and exit codes are preserved exactly — the hooks reproduce
 * the per-kind contracts the caller already owned.
 */
export async function runPlannedRestartCommand<TResult>(
  config: PlannedRestartCommandConfig<TResult>,
): Promise<number> {
  const launcherDeps: PlannedRestartLauncherDeps = {
    dispatchControl: config.dispatchControl,
    ...(config.spawnProcess ? { spawnProcess: config.spawnProcess } : {}),
  }
  const launch: LaunchCoordinatorFn = config.launchCoordinator ?? (async (deps, options) => {
    const result = launchPlannedRestartCoordinator(options, deps)
    return { pid: result.pid }
  })
  const aliveCheck = config.isCoordinatorAlive ?? isCoordinatorAlive
  const waitForTerminal = config.waitForPlanTerminal ?? waitForPlanTerminal
  const sleepFn = config.sleep ?? sleep
  const acquireLock = config.acquireLock ?? acquirePlannedRestartLockAsync

  const launchOptions: LaunchPlannedRestartOptions = {
    operationId: '', // stamped per-decision below
    kind: config.kind,
    resolvedConfigPath: config.resolvedConfigPath,
    ...(typeof config.host === 'string' ? { host: config.host } : {}),
    ...(typeof config.port === 'string' ? { port: config.port } : {}),
  }

  let operationId: string
  let joining: boolean
  let scheduled: boolean
  let terminal: PlannedRestartPlanSummary | null

  // The advisory lock serializes the entire decide+launch section so two
  // concurrent CLI invocations cannot race on beginPlan or double-spawn.
  // The (potentially long) terminal wait runs outside the lock.
  const lock = await acquireLock()
  try {
    const dispatchStatus = config.dispatchControl.status()
    // Only a plan carried while dispatch is in planned_restart mode is active or
    // blocking. A completed/failed (recovery_required=false) plan retained under
    // accepting/frozen is historical: it must not be joined, resumed, conflicted
    // with, or replayed, so a fresh preflight/schedule replaces it via beginPlan.
    // A failed recovery_required=true plan stays in planned_restart mode and is
    // still surfaced rather than retried.
    const active = dispatchStatus.mode === 'planned_restart' ? dispatchStatus.plannedRestart : null

    if (!active) {
      // Fresh: preflight (kind-specific), beginPlan with null pid, spawn, stamp pid.
      const snapshot = config.hooks.preflight ? await config.hooks.preflight() : undefined
      operationId = config.generateOperationId()
      const plan: PlannedRestartPlan = {
        operation_id: operationId,
        kind: config.kind,
        phase: 'draining',
        recovery_required: false,
        created_at: new Date().toISOString(),
        coordinator_pid: null,
        config_path: config.resolvedConfigPath,
        ...(snapshot ? { checkout_path: snapshot.checkout_path, old_head: snapshot.old_head } : {}),
      }
      config.dispatchControl.beginPlannedRestart(plan)
      try {
        const { pid } = await launch(launcherDeps, { ...launchOptions, operationId })
        config.dispatchControl.updatePlannedRestart(operationId, { coordinator_pid: pid })
      } catch (error) {
        // Pre-stop failure: restore prior admission so a later invocation can
        // retry. The coordinator child (if spawned) will observe the aborted
        // terminal plan and exit 0 on its own.
        config.dispatchControl.abortPlannedRestart(operationId)
        throw error
      }
      joining = false
      scheduled = true
      terminal = null
    } else if (active.kind !== config.kind) {
      throw new Error(config.hooks.oppositeKindRejection)
    } else if (active.phase === 'completed' || active.phase === 'failed') {
      // Terminal plan (including failed recovery) is reported, never retried.
      operationId = active.operationId
      joining = false
      scheduled = false
      terminal = active
    } else if (aliveCheck(config.store.snapshot().plan?.coordinator_pid ?? -1)) {
      // Live coordinator for the same operation: join it without spawning.
      operationId = active.operationId
      joining = true
      scheduled = true
      terminal = null
    } else {
      // Dead or absent coordinator: relaunch in resume mode (no beginPlan) under
      // the existing operation id and metadata.
      operationId = active.operationId
      const { pid } = await launch(launcherDeps, { ...launchOptions, operationId })
      config.dispatchControl.updatePlannedRestart(operationId, { coordinator_pid: pid })
      joining = false
      scheduled = true
      terminal = null
    }
  } finally {
    lock.release()
  }

  // Task context or --no-wait return right after scheduling/joining. Humans
  // wait by default for the same operation to reach a terminal state.
  const shouldWait = !config.isTaskContext && !config.noWait
  if (shouldWait && scheduled) {
    // Liveness observation: if the plan is nonterminal and the stamped
    // coordinator pid is known to be dead, stop waiting and report failure
    // (the next CLI invocation will resume). A null pid means "not yet
    // stamped, keep waiting".
    const isAlive = (): boolean => {
      const plan = config.store.snapshot().plan
      const pid = plan?.coordinator_pid
      if (!pid) return true
      return aliveCheck(pid)
    }
    terminal = await waitForTerminal(config.dispatchControl, operationId, 500, sleepFn, isAlive)
    scheduled = false
  }

  let result: TResult
  if (scheduled) {
    result = config.hooks.buildScheduledResult({ operationId, joining })
  } else {
    result = await config.hooks.buildTerminalResult({ operationId, terminal })
  }

  const printJson = config.isTaskContext || config.asJson
  if (printJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    config.hooks.printHuman(result)
  }

  return config.hooks.exitCode(result)
}

/**
 * Re-exported for command files that still reference the default status
 * collector and sleep. Keeping the re-export here co-locates the shared
 * command surface with its defaults.
 */
export { collectForemanStatus }
