import {
  type DaemonLifecycleOptions,
  type DaemonLifecycleResult,
  restartDaemonProcess,
  type RestartDaemonProcessHooks,
} from './daemon-supervisor.mts'
import type { DispatchStatus } from '../../daemon/dispatch-control.mts'
import { PlannedRestartStore } from '../../daemon/planned-restart-store.mts'
import type {
  PlannedRestartFailure,
  PlannedRestartKind,
  PlannedRestartPlan,
  PlannedRestartPlanSummary,
  PlannedRestartPlanUpdate,
} from '../../daemon/planned-restart-store.mts'
import type { ForemanServiceConfig } from '../../config/index.mts'
import type { ForemanStatus } from './shared.mts'

const DEFAULT_DRAIN_POLL_INTERVAL_MS = 500
const DEFAULT_VERIFICATION_POLL_INTERVAL_MS = 500
const DEFAULT_VERIFICATION_DEADLINE_MS = 30_000
const MAX_PHASE_TRANSITIONS = 64

/**
 * Stable error codes raised by the planned-restart coordinator and its
 * preparation resolver. Callers and tests match on `code`, never on message
 * text.
 */
export class PlannedRestartCoordinatorError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlannedRestartCoordinatorError'
    this.code = code
  }
}

// ── Preparation provider contract ────────────────────────────────────────

/**
 * Context handed to a preparation provider. It carries only what preparation
 * may legitimately need: the operation id, the exact kind the provider was
 * selected for, and the resolved service config path.
 */
export interface PlannedRestartPreparationContext {
  operationId: string
  kind: PlannedRestartKind
  resolvedConfigPath: string
  config?: ForemanServiceConfig
}

/**
 * A preparation provider declares exactly one {@link PlannedRestartKind} and
 * exposes an idempotent `prepare` operation. Preparation runs only after a
 * stable natural drain and before the daemon lifecycle (stop/start) begins.
 *
 * A provider must NOT own drain, stop/start, health, completion, or recovery.
 * Because preparation may run again during recovery of the `updating` phase,
 * `prepare` MUST be safe to call more than once.
 */
export interface PlannedRestartPreparationProvider {
  kind: PlannedRestartKind
  prepare: (context: PlannedRestartPreparationContext) => Promise<void>
}

/**
 * Built-in preparation providers. Contains only the restart-kind no-op
 * provider: restart does not require any code/repository change before the
 * daemon lifecycle runs. Update preparation is intentionally absent so the
 * default resolver rejects it (see {@link resolvePlannedRestartPreparation}).
 */
export function createRestartPreparationProvider(): PlannedRestartPreparationProvider[] {
  return [
    {
      kind: 'restart',
      prepare: async () => {
        // No-op preparation for restart-kind plans.
      },
    },
  ]
}

/**
 * Resolve the single exact preparation provider for a kind. When no provider
 * declares the requested kind (the default case for `update`), throw a stable
 * `planned_restart_preparation_unsupported` error. A later caller injects an
 * exact-kind provider by passing it through the coordinator options; that
 * injected provider is then found here and accepted.
 */
export function resolvePlannedRestartPreparation(
  providers: PlannedRestartPreparationProvider[],
  kind: PlannedRestartKind,
): PlannedRestartPreparationProvider[] {
  const exact = providers.filter((provider) => provider.kind === kind)
  if (exact.length === 0) {
    throw new PlannedRestartCoordinatorError(
      'planned_restart_preparation_unsupported',
      `planned restart preparation is not supported for kind '${kind}'; an exact-kind preparation provider must be injected`,
    )
  }
  if (exact.length > 1) {
    throw new PlannedRestartCoordinatorError(
      'planned_restart_preparation_ambiguous',
      `multiple preparation providers declare kind '${kind}'; exactly one exact provider is required`,
    )
  }
  return exact
}

// ── Coordinator dependencies and options ─────────────────────────────────

/**
 * Minimal dispatch-control surface the coordinator drives. The real
 * {@link DispatchControl} satisfies this structurally; tests inject a fake.
 * No method accepts a caller id or an exclusion argument — drain is natural.
 */
export interface PlannedRestartCoordinatorDispatch {
  status: () => DispatchStatus
  updatePlannedRestart: (operationId: string, update: PlannedRestartPlanUpdate) => void
  completePlannedRestart: (operationId: string) => void
  abortPlannedRestart: (operationId: string) => void
  failPlannedRestart: (operationId: string, failure: PlannedRestartFailure) => void
}

export interface PlannedRestartCoordinatorDeps {
  dispatchControl: PlannedRestartCoordinatorDispatch
  collectForemanStatus: (configPathValue: unknown) => Promise<ForemanStatus>
  restartDaemonProcess: (
    options: DaemonLifecycleOptions,
    hooks?: RestartDaemonProcessHooks,
  ) => Promise<DaemonLifecycleResult>
  /**
   * Reads the raw durable plan so the coordinator can preserve recovery
   * metadata (old_head/new_head/checkout_path) when recording a failure.
   * Defaults to a fresh {@link PlannedRestartStore} read; tests inject a fake.
   */
  readRawPlan?: (operationId: string) => PlannedRestartPlan | null
  sleep?: (ms: number) => Promise<void>
}

export interface PlannedRestartCoordinatorOptions {
  operationId: string
  config: ForemanServiceConfig
  resolvedConfigPath: string
  /** Exact-kind preparation providers injected on top of the built-in restart no-op. */
  providers?: PlannedRestartPreparationProvider[]
  drainPollIntervalMs?: number
  verificationPollIntervalMs?: number
  verificationDeadlineMs?: number
  coordinatorPid?: number
}

// ── Terminal wait ─────────────────────────────────────────────────────────

/**
 * Poll the dispatch surface for the plan to reach a terminal phase. Returns
 * the terminal summary on `completed`/`failed`, or `null` if the plan
 * disappears entirely.
 *
 * If an `isAlive` callback is supplied and the plan is nonterminal with a
 * known coordinator pid that is no longer alive, returns `null` instead of
 * hanging forever — a caller-side recovery path (next CLI invocation) will
 * resume. A `null` pid means "not yet stamped, keep waiting".
 */
export async function waitForPlanTerminal(
  dispatchControl: PlannedRestartCoordinatorDispatch,
  operationId: string,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  isAlive?: () => boolean,
): Promise<PlannedRestartPlanSummary | null> {
  while (true) {
    const plan = readPlanOrNull(dispatchControl, operationId)
    if (!plan) return null
    if (plan.phase === 'completed' || plan.phase === 'failed') return plan
    if (isAlive && !isAlive()) return null
    await sleep(intervalMs)
  }
}

// ── Engine ───────────────────────────────────────────────────────────────

export async function runPlannedRestartCoordinator(
  options: PlannedRestartCoordinatorOptions,
  deps: PlannedRestartCoordinatorDeps,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep
  const drainInterval = options.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS
  const verifyInterval = options.verificationPollIntervalMs ?? DEFAULT_VERIFICATION_POLL_INTERVAL_MS
  const verifyDeadline = options.verificationDeadlineMs ?? DEFAULT_VERIFICATION_DEADLINE_MS
  const readRawPlan = deps.readRawPlan ?? defaultReadRawPlan
  const providers = createRestartPreparationProvider().concat(options.providers ?? [])
  const operationId = options.operationId

  for (let transition = 0; transition < MAX_PHASE_TRANSITIONS; transition++) {
    const plan = readPlanOrNull(deps.dispatchControl, operationId)
    if (!plan) return
    if (plan.phase === 'completed' || plan.phase === 'failed') return

    // Mid-run ownership check: if the durable plan's coordinator_pid is a
    // number and does not match this process, another coordinator has taken
    // ownership — exit 0 without further mutations. After the child's own
    // self-stamp (in the process entrypoint), coordinator_pid is always a
    // number on this child's reads; a null pid means "not yet stamped by
    // anyone" and is allowed only during the startup window before self-stamp.
    const rawForOwnership = readRawPlan(operationId)
    if (
      rawForOwnership
      && typeof rawForOwnership.coordinator_pid === 'number'
      && rawForOwnership.coordinator_pid !== (options.coordinatorPid ?? process.pid)
    ) {
      return
    }

    try {
      switch (plan.phase) {
        case 'draining': {
          await waitForStableDrain(deps.dispatchControl, drainInterval, sleep)
          deps.dispatchControl.updatePlannedRestart(operationId, { phase: 'updating' })
          break
        }
        case 'updating': {
          const provider = resolveExactProvider(providers, plan.kind)
          await provider.prepare(makePreparationContext(options, plan))
          deps.dispatchControl.updatePlannedRestart(operationId, { phase: 'stopping' })
          break
        }
        case 'stopping': {
          await handleStopping(options, deps, operationId, drainInterval, sleep)
          break
        }
        case 'verifying': {
          await handleVerifying(options, deps, operationId, verifyInterval, verifyDeadline, sleep)
          break
        }
      }
    } catch (error) {
      const normalized = normalizeError(error)
      if (plan.phase === 'draining' || plan.phase === 'updating') {
        // Before stop began: restore prior admission, no restart runs.
        deps.dispatchControl.abortPlannedRestart(operationId)
      } else {
        // At or after stopping: retain planned_restart with recovery required,
        // preserving any existing recovery metadata.
        const raw = readRawPlan(operationId)
        deps.dispatchControl.failPlannedRestart(operationId, {
          error_code: normalized.code,
          error_message: normalized.message,
          failed_at: new Date().toISOString(),
          coordinator_pid: options.coordinatorPid ?? process.pid,
          config_path: options.resolvedConfigPath,
          old_head: raw?.old_head ?? null,
          new_head: raw?.new_head ?? null,
          checkout_path: raw?.checkout_path ?? null,
        })
      }
      return
    }
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * Drive the daemon lifecycle to a healthy verifying state. First accept an
 * already-healthy matching handoff: if the daemon is already up and reporting
 * this plan in the verifying phase, skip the lifecycle. Otherwise re-establish
 * a stable zero and retry the existing restart lifecycle (stop -> start), then
 * transition directly to verifying. The `onStopped` hook intentionally writes
 * no phase — `stopping` absorbs the old `starting` phase.
 */
async function handleStopping(
  options: PlannedRestartCoordinatorOptions,
  deps: PlannedRestartCoordinatorDeps,
  operationId: string,
  drainInterval: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const handoff = await deps.collectForemanStatus(options.resolvedConfigPath)
  if (isVerificationSuccess(handoff, operationId)) {
    deps.dispatchControl.updatePlannedRestart(operationId, { phase: 'verifying' })
    return
  }

  // Otherwise re-establish a stable zero and retry the existing restart
  // lifecycle (stop -> start -> verify).
  await waitForStableDrain(deps.dispatchControl, drainInterval, sleep)

  // Post-drain ownership + phase recheck: before running the daemon lifecycle,
  // re-read the RAW plan (not just the summary) and require BOTH that the phase
  // is exactly 'stopping' AND that coordinator_pid matches this process. Any
  // other phase (including 'verifying' driven by a replacement coordinator that
  // already ran the lifecycle) or any foreign pid means this child is stale or
  // superseded — return without running restartDaemonProcess.
  //
  // Residual race: the recheck reads the plan at one instant; a replacement
  // coordinator could begin its own lifecycle a millisecond later. The
  // remaining accepted race is a millisecond-scale stamp/recheck interleave
  // whose worst case is a duplicated stop/start attempt that converges through
  // failPlan (recovery_required=true, operator-visible, recoverable by
  // re-running the same command). The structural elimination (daemon-side
  // ownership arbitration on stop) is deliberately out of scope for this
  // refactor.
  const readRaw = deps.readRawPlan ?? defaultReadRawPlan
  const raw = readRaw(operationId)
  if (
    !raw
    || raw.phase !== 'stopping'
    || (typeof raw.coordinator_pid === 'number'
      && raw.coordinator_pid !== (options.coordinatorPid ?? process.pid))
  ) {
    return
  }

  await deps.restartDaemonProcess(
    { config: options.config, resolvedConfigPath: options.resolvedConfigPath },
    {},
  )
  deps.dispatchControl.updatePlannedRestart(operationId, { phase: 'verifying' })
}

async function handleVerifying(
  options: PlannedRestartCoordinatorOptions,
  deps: PlannedRestartCoordinatorDeps,
  operationId: string,
  intervalMs: number,
  deadlineMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const status = await deps.collectForemanStatus(options.resolvedConfigPath)
    if (isVerificationSuccess(status, operationId)) {
      deps.dispatchControl.completePlannedRestart(operationId)
      return
    }
    await sleep(intervalMs)
  }
  throw new PlannedRestartCoordinatorError(
    'planned_restart_verification_failed',
    `planned restart ${operationId} did not reach a healthy verifying state before the deadline`,
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Poll {@link PlannedRestartCoordinatorDispatch.status} until two consecutive
 * samples (separated by `intervalMs`) report zero active tasks, workflows, and
 * executions. This is the natural drain: it never forces work to stop.
 */
async function waitForStableDrain(
  dispatchControl: PlannedRestartCoordinatorDispatch,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let previousZero = false
  while (true) {
    const status = dispatchControl.status()
    const zero =
      status.activeTaskCount === 0
      && status.activeWorkflowCount === 0
      && status.activeExecutionCount === 0
    if (zero && previousZero) return
    previousZero = zero
    await sleep(intervalMs)
  }
}

/**
 * Success requires the full health gate (status.ok and ipc/http/mcp/db) and the
 * daemon status projection reporting `planned_restart` for the exact
 * operation_id in the `verifying` phase.
 */
function isVerificationSuccess(status: ForemanStatus, operationId: string): boolean {
  return (
    status.ok
    && status.ipc.ok
    && status.http.ok
    && status.mcp.ok
    && status.db.ok
    && status.mode === 'planned_restart'
    && status.operation_id === operationId
    && status.phase === 'verifying'
  )
}

function readPlanOrNull(
  dispatchControl: PlannedRestartCoordinatorDispatch,
  operationId: string,
): PlannedRestartPlanSummary | null {
  const status = dispatchControl.status()
  const plan = status.plannedRestart
  if (!plan) return null
  if (plan.operationId !== operationId) {
    throw new PlannedRestartCoordinatorError(
      'planned_restart_operation_id_mismatch',
      `active planned restart plan '${plan.operationId}' does not match coordinator operation '${operationId}'`,
    )
  }
  return plan
}

function makePreparationContext(
  options: PlannedRestartCoordinatorOptions,
  plan: PlannedRestartPlanSummary,
): PlannedRestartPreparationContext {
  return {
    operationId: plan.operationId,
    kind: plan.kind,
    resolvedConfigPath: options.resolvedConfigPath,
    config: options.config,
  }
}

function resolveExactProvider(
  providers: PlannedRestartPreparationProvider[],
  kind: PlannedRestartKind,
): PlannedRestartPreparationProvider {
  const [provider] = resolvePlannedRestartPreparation(providers, kind)
  if (!provider) {
    // Unreachable: resolvePlannedRestartPreparation throws on zero/ambiguous.
    throw new PlannedRestartCoordinatorError(
      'planned_restart_preparation_missing',
      `no exact preparation provider resolved for kind '${kind}'`,
    )
  }
  return provider
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof PlannedRestartCoordinatorError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'planned_restart_coordinator_error', message: error.message }
  }
  return { code: 'planned_restart_coordinator_error', message: String(error) }
}

function defaultReadRawPlan(operationId: string): PlannedRestartPlan | null {
  const store = new PlannedRestartStore()
  const snapshot = store.snapshot()
  if (!snapshot.plan || snapshot.plan.operation_id !== operationId) return null
  return snapshot.plan
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
