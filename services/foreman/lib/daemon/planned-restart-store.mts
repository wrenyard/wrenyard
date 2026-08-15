import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { foremanStateRoot } from '../config/state.mts'

export type AdmissionMode = 'accepting' | 'frozen' | 'planned_restart'
export type PlannedRestartKind = 'update' | 'restart'
/**
 * Written phase vocabulary (6 phases). Legacy files may still carry
 * `preparing` or `starting`; {@link PlannedRestartStore.load} normalizes
 * those to `draining` / `stopping` before validation, so every in-memory
 * plan only ever carries one of these six phases.
 */
export type PlannedRestartPhase =
  | 'draining'
  | 'updating'
  | 'stopping'
  | 'verifying'
  | 'completed'
  | 'failed'

/**
 * Persisted, snake-case plan representation. The persisted document only uses
 * these field names; the camel-case projection lives in PlannedRestartPlanSummary.
 */
export interface PlannedRestartPlan {
  operation_id: string
  kind: PlannedRestartKind
  phase: PlannedRestartPhase
  recovery_required: boolean
  created_at: string
  error_code?: string | null
  error_message?: string | null
  failed_at?: string | null
  old_head?: string | null
  new_head?: string | null
  coordinator_pid?: number | null
  config_path?: string | null
  checkout_path?: string | null
}

export interface PlannedRestartFailure {
  error_code: string
  error_message: string
  failed_at: string
  old_head?: string | null
  new_head?: string | null
  coordinator_pid?: number | null
  config_path?: string | null
  checkout_path?: string | null
}

export interface PlannedRestartPlanSummary {
  operationId: string
  kind: PlannedRestartKind
  phase: PlannedRestartPhase
  recoveryRequired: boolean
  createdAt: string
}

export interface PlannedRestartSnapshot {
  mode: AdmissionMode
  plan: PlannedRestartPlan | null
}

export type PlannedRestartPlanUpdate = Partial<
  Pick<
    PlannedRestartPlan,
    | 'phase'
    | 'recovery_required'
    | 'error_code'
    | 'error_message'
    | 'failed_at'
    | 'old_head'
    | 'new_head'
    | 'coordinator_pid'
    | 'config_path'
    | 'checkout_path'
  >
>

export const PLANNED_RESTART_STATE_FILE_NAME = 'planned-restart.json'

const PLANNED_RESTART_STATE_VERSION = 1
const ADMISSION_MODES: readonly AdmissionMode[] = ['accepting', 'frozen', 'planned_restart']
const PLANNED_RESTART_KINDS: readonly PlannedRestartKind[] = ['update', 'restart']
const PLANNED_RESTART_PHASES: readonly PlannedRestartPhase[] = [
  'draining',
  'updating',
  'stopping',
  'verifying',
  'completed',
  'failed',
]

/**
 * Idempotent mapping applied to a plan's phase during {@link PlannedRestartStore.load},
 * before validation. Legacy `preparing` (the old entry phase) maps to `draining`;
 * legacy `starting` (now absorbed by `stopping`) maps to `stopping`. New files
 * never carry either legacy word, so the mapping is a no-op on new-format state.
 */
function normalizeLegacyPhase(phase: string): string {
  if (phase === 'preparing') return 'draining'
  if (phase === 'starting') return 'stopping'
  return phase
}

export class PlannedRestartStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlannedRestartStoreError'
    this.code = code
  }
}

interface DurableDispatchState {
  version: number
  mode: AdmissionMode
  prior_mode?: AdmissionMode
  plan?: PlannedRestartPlan
}

export function summarizePlan(plan: PlannedRestartPlan): PlannedRestartPlanSummary {
  return {
    operationId: plan.operation_id,
    kind: plan.kind,
    phase: plan.phase,
    recoveryRequired: plan.recovery_required,
    createdAt: plan.created_at,
  }
}

/**
 * Durable, process-cross-safe admission-mode state machine persisted as one
 * versioned JSON document. A second process constructs the same store against
 * the same root and observes a validated snapshot; no observer can ever read a
 * planned_restart mode without its plan, and malformed/unreadable state throws
 * so bootstrap cannot fail open.
 *
 * Phase vocabulary is the 6-phase set (draining → updating → stopping →
 * verifying → completed/failed). Legacy `preparing`/`starting` are normalized
 * to `draining`/`stopping` on load before validation, so old files written by
 * previous versions remain readable without a state version bump.
 */
export class PlannedRestartStore {
  private readonly statePath: string

  constructor(stateRoot: string = foremanStateRoot()) {
    this.statePath = join(stateRoot, PLANNED_RESTART_STATE_FILE_NAME)
    // Validate on construction so bootstrap cannot fail open (missing file is accepting).
    this.load()
  }

  snapshot(): PlannedRestartSnapshot {
    const state = this.load()
    return { mode: state.mode, plan: state.plan ?? null }
  }

  setAdmissionMode(mode: AdmissionMode): void {
    const state = this.load()
    if (state.mode === 'planned_restart') {
      throw new PlannedRestartStoreError(
        'active_planned_restart',
        'cannot change admission mode while a planned restart is active',
      )
    }
    if (mode === 'planned_restart') {
      throw new PlannedRestartStoreError(
        'planned_restart_requires_plan',
        'cannot enter planned_restart mode without an active plan',
      )
    }
    // Preserve any retained terminal plan across generic accepting<->frozen
    // transitions; only an active planned_restart is refused above. prior_mode
    // is meaningful solely during planned_restart and is dropped here.
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode,
      plan: state.plan,
    })
  }

  beginPlan(plan: PlannedRestartPlan): void {
    const state = this.load()
    if (state.mode === 'planned_restart') {
      throw new PlannedRestartStoreError('plan_already_active', 'a planned restart plan is already active')
    }
    if (state.mode !== 'accepting' && state.mode !== 'frozen') {
      throw new PlannedRestartStoreError(
        'invalid_prior_mode',
        'planned restart can only begin from accepting or frozen mode',
      )
    }
    this.validatePlan(plan)
    // Capture accepting/frozen as prior_mode and persist planned_restart with the
    // complete plan in one atomic replacement before returning.
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode: 'planned_restart',
      prior_mode: state.mode,
      plan: { ...plan },
    })
  }

  updatePlan(operationId: string, patch: PlannedRestartPlanUpdate): void {
    const state = this.load()
    if (state.mode !== 'planned_restart' || !state.plan) {
      throw new PlannedRestartStoreError('no_active_plan', 'no active planned restart plan to update')
    }
    this.assertOperationId(state.plan.operation_id, operationId)
    const plan: PlannedRestartPlan = { ...state.plan, ...patch }
    this.validatePlan(plan)
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode: 'planned_restart',
      prior_mode: state.prior_mode,
      plan,
    })
  }

  abortPlan(operationId: string): void {
    const state = this.load()
    if (state.mode !== 'planned_restart' || !state.plan) {
      throw new PlannedRestartStoreError('no_active_plan', 'no active planned restart plan to abort')
    }
    this.assertOperationId(state.plan.operation_id, operationId)
    const priorMode = state.prior_mode ?? 'accepting'
    // Retain the plan as a durable terminal outcome: mark it failed and
    // non-recoverable, restore the captured admission mode, and drop the stale
    // active-plan restoration state (prior_mode) outside planned_restart.
    const plan: PlannedRestartPlan = {
      ...state.plan,
      phase: 'failed',
      recovery_required: false,
    }
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode: priorMode,
      plan,
    })
  }

  failPlan(operationId: string, failure: PlannedRestartFailure): void {
    const state = this.load()
    if (state.mode !== 'planned_restart' || !state.plan) {
      throw new PlannedRestartStoreError('no_active_plan', 'no active planned restart plan to fail')
    }
    this.assertOperationId(state.plan.operation_id, operationId)
    const plan: PlannedRestartPlan = {
      ...state.plan,
      phase: 'failed',
      // The durable store always imposes recovery_required=true: failPlan is
      // only called at or after the daemon lifecycle has begun (stopping or
      // later), where admission must remain closed until a human reconciles.
      recovery_required: true,
      error_code: failure.error_code,
      error_message: failure.error_message,
      failed_at: failure.failed_at,
      old_head: failure.old_head ?? null,
      new_head: failure.new_head ?? null,
      coordinator_pid: failure.coordinator_pid ?? null,
      config_path: failure.config_path ?? null,
      checkout_path: failure.checkout_path ?? null,
    }
    this.validatePlan(plan)
    // Retain planned_restart (non-accepting) while merging recovery metadata.
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode: 'planned_restart',
      prior_mode: state.prior_mode,
      plan,
    })
  }

  completePlan(operationId: string): void {
    const state = this.load()
    if (state.mode !== 'planned_restart' || !state.plan) {
      throw new PlannedRestartStoreError('no_active_plan', 'no active planned restart plan to complete')
    }
    this.assertOperationId(state.plan.operation_id, operationId)
    const priorMode = state.prior_mode ?? 'accepting'
    // Retain the plan as a durable terminal outcome: mark it completed and
    // non-recoverable, restore the captured admission mode, and drop the stale
    // active-plan restoration state (prior_mode) outside planned_restart.
    const plan: PlannedRestartPlan = {
      ...state.plan,
      phase: 'completed',
      recovery_required: false,
    }
    this.atomicWrite({
      version: PLANNED_RESTART_STATE_VERSION,
      mode: priorMode,
      plan,
    })
  }

  private assertOperationId(active: string, provided: string): void {
    if (active !== provided) {
      throw new PlannedRestartStoreError(
        'operation_id_mismatch',
        `operation id '${provided}' does not match the active plan '${active}'`,
      )
    }
  }

  private load(): DurableDispatchState {
    let raw: string
    try {
      raw = readFileSync(this.statePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { version: PLANNED_RESTART_STATE_VERSION, mode: 'accepting' }
      }
      throw new PlannedRestartStoreError(
        'state_read_failed',
        `failed to read planned restart state at ${this.statePath}: ${(error as Error).message}`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new PlannedRestartStoreError(
        'state_malformed',
        `planned restart state at ${this.statePath} is not valid JSON`,
      )
    }

    return this.validateState(parsed)
  }

  private validateState(value: unknown): DurableDispatchState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PlannedRestartStoreError('state_malformed', 'planned restart state must be an object')
    }
    const obj = value as Record<string, unknown>
    if (typeof obj.version !== 'number' || obj.version !== PLANNED_RESTART_STATE_VERSION) {
      throw new PlannedRestartStoreError(
        'state_version_unsupported',
        `unsupported planned restart state version: ${String(obj.version)}`,
      )
    }
    const mode = obj.mode
    if (typeof mode !== 'string' || !ADMISSION_MODES.includes(mode as AdmissionMode)) {
      throw new PlannedRestartStoreError('state_mode_invalid', `invalid admission mode: ${String(mode)}`)
    }
    const typedMode = mode as AdmissionMode

    let priorMode: AdmissionMode | undefined
    if (obj.prior_mode !== undefined) {
      if (typeof obj.prior_mode !== 'string' || !ADMISSION_MODES.includes(obj.prior_mode as AdmissionMode)) {
        throw new PlannedRestartStoreError('state_mode_invalid', `invalid prior_mode: ${String(obj.prior_mode)}`)
      }
      priorMode = obj.prior_mode as AdmissionMode
    }

    let plan: PlannedRestartPlan | undefined
    if (obj.plan !== undefined && obj.plan !== null) {
      // Normalize legacy phase before validation so old files remain readable.
      plan = this.validatePlan(this.normalizeLegacyPlan(obj.plan))
    }

    // Invariant: planned_restart mode always carries an active plan.
    if (typedMode === 'planned_restart' && !plan) {
      throw new PlannedRestartStoreError(
        'state_inconsistent',
        'planned_restart mode requires an active plan',
      )
    }

    // Fail-closed: accepting/frozen may only retain a terminal, non-recoverable
    // plan (completed/failed with recovery_required false). Any nonterminal or
    // recovery-required retained plan is contradictory state.
    if ((typedMode === 'accepting' || typedMode === 'frozen') && plan) {
      const terminal = plan.phase === 'completed' || plan.phase === 'failed'
      if (!terminal || plan.recovery_required) {
        throw new PlannedRestartStoreError(
          'state_inconsistent',
          'accepting/frozen mode may only retain a completed or failed plan with recovery_required false',
        )
      }
    }

    return { version: PLANNED_RESTART_STATE_VERSION, mode: typedMode, prior_mode: priorMode, plan }
  }

  /**
   * Apply legacy phase normalization to a raw plan object without mutating the
   * input. Only `phase` is rewritten; all other fields pass through unchanged.
   */
  private normalizeLegacyPlan(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    const obj = value as Record<string, unknown>
    const phase = obj.phase
    if (typeof phase !== 'string') return obj
    const normalized = normalizeLegacyPhase(phase)
    if (normalized === phase) return obj
    return { ...obj, phase: normalized }
  }

  private validatePlan(value: unknown): PlannedRestartPlan {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PlannedRestartStoreError('plan_malformed', 'planned restart plan must be an object')
    }
    const obj = value as Record<string, unknown>

    const operation_id = obj.operation_id
    if (typeof operation_id !== 'string' || operation_id.length === 0) {
      throw new PlannedRestartStoreError('plan_field_invalid', 'plan.operation_id must be a non-empty string')
    }

    const kind = obj.kind
    if (typeof kind !== 'string' || !PLANNED_RESTART_KINDS.includes(kind as PlannedRestartKind)) {
      throw new PlannedRestartStoreError('plan_field_invalid', `invalid plan.kind: ${String(kind)}`)
    }

    const phase = obj.phase
    if (typeof phase !== 'string' || !PLANNED_RESTART_PHASES.includes(phase as PlannedRestartPhase)) {
      throw new PlannedRestartStoreError('plan_field_invalid', `invalid plan.phase: ${String(phase)}`)
    }

    const recovery_required = obj.recovery_required
    if (typeof recovery_required !== 'boolean') {
      throw new PlannedRestartStoreError('plan_field_invalid', 'plan.recovery_required must be a boolean')
    }

    const created_at = obj.created_at
    if (typeof created_at !== 'string' || created_at.length === 0) {
      throw new PlannedRestartStoreError('plan_field_invalid', 'plan.created_at must be a non-empty string')
    }

    const plan: PlannedRestartPlan = {
      operation_id,
      kind: kind as PlannedRestartKind,
      phase: phase as PlannedRestartPhase,
      recovery_required,
      created_at,
    }

    this.applyOptionalField(obj, 'error_code', plan, 'string')
    this.applyOptionalField(obj, 'error_message', plan, 'string')
    this.applyOptionalField(obj, 'failed_at', plan, 'string')
    this.applyOptionalField(obj, 'old_head', plan, 'string')
    this.applyOptionalField(obj, 'new_head', plan, 'string')
    this.applyOptionalField(obj, 'coordinator_pid', plan, 'number')
    this.applyOptionalField(obj, 'config_path', plan, 'string')
    this.applyOptionalField(obj, 'checkout_path', plan, 'string')

    return plan
  }

  private applyOptionalField(
    obj: Record<string, unknown>,
    key: string,
    plan: PlannedRestartPlan,
    kind: 'string' | 'number',
  ): void {
    const value = obj[key]
    if (value === undefined) return
    if (value === null) {
      ;(plan as unknown as Record<string, unknown>)[key] = null
      return
    }
    if (typeof value !== kind) {
      throw new PlannedRestartStoreError('plan_field_invalid', `${key} must be a ${kind} or null`)
    }
    ;(plan as unknown as Record<string, unknown>)[key] = value
  }

  private atomicWrite(state: DurableDispatchState): void {
    const dir = dirname(this.statePath)
    mkdirSync(dir, { recursive: true })
    const tmp = join(
      dir,
      `${PLANNED_RESTART_STATE_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    )
    let fd: number | undefined
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      // Windows rejects fsync on a read-only file descriptor with EPERM.
      fd = openSync(tmp, 'r+')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmp, this.statePath)
      // Flush the containing directory so the rename is durable where supported.
      try {
        const dirFd = openSync(dir, 'r')
        try {
          fsyncSync(dirFd)
        } finally {
          closeSync(dirFd)
        }
      } catch {
        // Directory fsync is not supported on all platforms; safe to ignore.
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw error
    }
  }
}
