import { query as dbQuery } from '../db/connection.mts'
import {
  PlannedRestartStore,
  summarizePlan,
  type AdmissionMode,
  type PlannedRestartFailure,
  type PlannedRestartPlan,
  type PlannedRestartPlanSummary,
  type PlannedRestartPlanUpdate,
  type PlannedRestartSnapshot,
} from './planned-restart-store.mts'

const DRAIN_POLL_INTERVAL_MS = 200

export const DAEMON_PLANNED_RESTART_CODE = 'daemon_planned_restart'
export const DAEMON_PLANNED_RESTART_MESSAGE =
  'Foreman daemon is planning restart and is not accepting new tasks or workflows.'

export interface DispatchStatus {
  mode: AdmissionMode
  /** Backward-compatible non-accepting flag for both frozen and planned_restart. */
  frozen: boolean
  accepting: boolean
  /** Current planned-restart plan summary, or null when none is active. */
  plannedRestart: PlannedRestartPlanSummary | null
  activeTasks: string[]
  activeTaskCount: number
  activeWorkflows: string[]
  activeWorkflowCount: number
  activeExecutions: string[]
  activeExecutionCount: number
}

export interface DrainResult {
  drained: boolean
  activeTaskCount: number
  activeWorkflowCount: number
  activeExecutionCount: number
  activeTasks: string[]
  activeWorkflows: string[]
  activeExecutions: string[]
}

export class DispatchControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DispatchControlError'
    this.code = code
  }
}

export class DispatchControl {
  private readonly store: PlannedRestartStore

  constructor(store?: PlannedRestartStore) {
    this.store = store ?? new PlannedRestartStore()
  }

  freeze(): void {
    this.store.setAdmissionMode('frozen')
  }

  thaw(): void {
    this.store.setAdmissionMode('accepting')
  }

  assertAccepting(): void {
    const snapshot = this.store.snapshot()
    if (snapshot.mode === 'planned_restart') {
      throw new DispatchControlError(DAEMON_PLANNED_RESTART_CODE, DAEMON_PLANNED_RESTART_MESSAGE)
    }
    if (snapshot.mode === 'frozen') {
      throw new DispatchControlError(
        'dispatch_frozen',
        'Dispatch is frozen. No new external tasks or workflows are accepted.',
      )
    }
  }

  status(): DispatchStatus {
    const snapshot: PlannedRestartSnapshot = this.store.snapshot()
    const activeTaskIds = this.readActiveTaskIds()
    const activeWorkflowIds = this.readActiveWorkflowIds()
    const activeExecutionIds = this.readActiveExecutionIds()

    const frozen = snapshot.mode === 'frozen'

    return {
      mode: snapshot.mode,
      frozen,
      accepting: snapshot.mode === 'accepting',
      plannedRestart: snapshot.plan ? summarizePlan(snapshot.plan) : null,
      activeTasks: activeTaskIds,
      activeTaskCount: activeTaskIds.length,
      activeWorkflows: activeWorkflowIds,
      activeWorkflowCount: activeWorkflowIds.length,
      activeExecutions: activeExecutionIds,
      activeExecutionCount: activeExecutionIds.length,
    }
  }

  beginPlannedRestart(plan: PlannedRestartPlan): void {
    this.store.beginPlan(plan)
  }

  updatePlannedRestart(operationId: string, update: PlannedRestartPlanUpdate): void {
    this.store.updatePlan(operationId, update)
  }

  abortPlannedRestart(operationId: string): void {
    this.store.abortPlan(operationId)
  }

  failPlannedRestart(operationId: string, failure: PlannedRestartFailure): void {
    this.store.failPlan(operationId, failure)
  }

  completePlannedRestart(operationId: string): void {
    this.store.completePlan(operationId)
  }

  async drain(timeoutMs: number): Promise<DrainResult> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const activeTaskIds = this.readActiveTaskIds()
      const activeWorkflowIds = this.readActiveWorkflowIds()
      const activeExecutionIds = this.readActiveExecutionIds()

      if (
        activeTaskIds.length === 0
        && activeWorkflowIds.length === 0
        && activeExecutionIds.length === 0
      ) {
        return {
          drained: true,
          activeTaskCount: 0,
          activeWorkflowCount: 0,
          activeExecutionCount: 0,
          activeTasks: [],
          activeWorkflows: [],
          activeExecutions: [],
        }
      }

      await sleep(DRAIN_POLL_INTERVAL_MS)
    }

    const activeTaskIds = this.readActiveTaskIds()
    const activeWorkflowIds = this.readActiveWorkflowIds()
    const activeExecutionIds = this.readActiveExecutionIds()

    return {
      drained: false,
      activeTaskCount: activeTaskIds.length,
      activeWorkflowCount: activeWorkflowIds.length,
      activeExecutionCount: activeExecutionIds.length,
      activeTasks: activeTaskIds,
      activeWorkflows: activeWorkflowIds,
      activeExecutions: activeExecutionIds,
    }
  }

  private readActiveTaskIds(): string[] {
    const rows = dbQuery<{ id: string }>(
      `SELECT id FROM tasks WHERE status IN ('queued', 'running')
       ORDER BY created_at ASC, id ASC`,
    )
    return rows.map((row) => row.id)
  }

  private readActiveWorkflowIds(): string[] {
    const rows = dbQuery<{ id: string }>(
      `SELECT id FROM workflows WHERE status IN ('running')
       ORDER BY created_at ASC, id ASC`,
    )
    return rows.map((row) => row.id)
  }

  private readActiveExecutionIds(): string[] {
    const rows = dbQuery<{ id: string }>(
      `SELECT id FROM executions WHERE status IN ('queued', 'starting', 'running')
       ORDER BY created_at ASC, id ASC`,
    )
    return rows.map((row) => row.id)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
