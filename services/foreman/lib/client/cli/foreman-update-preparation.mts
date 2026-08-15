import type { DispatchStatus } from '../../daemon/dispatch-control.mts'
import type {
  PlannedRestartPlan,
  PlannedRestartPlanUpdate,
} from '../../daemon/planned-restart-store.mts'
import type {
  ForemanUpdateCheckoutSnapshot,
  ForemanUpdateGit,
} from '../../core/project/foreman-update.mts'
import type {
  PlannedRestartPreparationContext,
  PlannedRestartPreparationProvider,
} from './planned-restart-coordinator.mts'
import {
  prepareWrenyardSuite,
  SuitePreparationError,
  type SuiteUpdatePreparer,
} from './suite-update-preparation.mts'

/**
 * Minimal, operation-id-guarded dispatch seam the update preparation provider
 * may touch. It mirrors the FU-001 {@link DispatchControl} surface the
 * coordinator drives, narrowed to exactly what preparation needs:
 *
 * - `status` exposes the active plan summary (operation id / kind / phase),
 * - `readRawPlan` returns the durable plan including `checkout_path`,
 *   `old_head`, and `new_head`,
 * - `updatePlannedRestart` is the only mutating call and is operation-id
 *   guarded by {@link DispatchControl}.
 *
 * The provider must NOT call `begin`, `abort`, `fail`, `complete`, `drain`,
 * `restartDaemonProcess`, `collectForemanStatus`, or any stop/start/health
 * operation; those remain owned by the coordinator engine.
 */
export interface ForemanUpdatePreparationDispatch {
  status: () => DispatchStatus
  readRawPlan: (operationId: string) => PlannedRestartPlan | null
  updatePlannedRestart: (operationId: string, update: PlannedRestartPlanUpdate) => void
}

export interface ForemanUpdatePreparationDeps {
  git: ForemanUpdateGit
  dispatch: ForemanUpdatePreparationDispatch
  /** Wall-clock used for `failed_at`; injectable for deterministic tests. */
  clock?: () => Date
  /**
   * Prepares the pulled monorepo checkout (install, typecheck, build, Forge
   * self-install) before the daemon lifecycle. Defaults to the real suite
   * preparer; tests inject a no-op so fake git paths never run real commands.
   */
  prepareSuite?: SuiteUpdatePreparer
}

/**
 * Stable error raised by the update preparation provider. Callers and tests
 * match on `code`, never on message text.
 */
export class ForemanUpdatePreparationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ForemanUpdatePreparationError'
    this.code = code
  }
}

/**
 * Introduce Adapter: build exactly one idempotent `update` preparation provider
 * that runs the drain-gated fast-forward pull and records the result durably.
 *
 * Preparation runs only after the coordinator reaches a stable natural drain
 * and before the daemon lifecycle (stop/start) begins. Because the `updating`
 * phase may be replayed during recovery, `prepare` is safe to call more than
 * once: a successful pull persists `new_head`, and a replayed preparation
 * reconciles using the persisted `new_head` (or the narrow origin/main path).
 *
 * After a successful pull the provider durably persists the new HEAD and then
 * prepares the entire suite from the checkout (see `prepareWrenyardSuite`)
 * before the daemon lifecycle begins; preparation is re-run safely on replay
 * with a persisted `new_head`. On any checkout validation, pull, or suite
 * preparation error the provider records the fixed failure metadata
 * (`error_code`, `error_message`, `failed_at`) while preserving
 * `checkout_path` and `old_head`, then rethrows so the coordinator's pre-stop
 * abort path restores prior admission without stopping the daemon.
 */
export function createForemanUpdatePreparationProvider(
  deps: ForemanUpdatePreparationDeps,
): PlannedRestartPreparationProvider {
  const clock = deps.clock ?? (() => new Date())
  const prepareSuite = deps.prepareSuite ?? { prepare: prepareWrenyardSuite }

  return {
    kind: 'update',
    async prepare(context: PlannedRestartPreparationContext): Promise<void> {
      const plan = deps.dispatch.readRawPlan(context.operationId)
      if (!plan) {
        throw new ForemanUpdatePreparationError(
          'no_active_plan',
          `no active planned update plan for operation '${context.operationId}'`,
        )
      }
      if (plan.operation_id !== context.operationId) {
        throw new ForemanUpdatePreparationError(
          'operation_id_mismatch',
          `active plan '${plan.operation_id}' does not match preparation operation '${context.operationId}'`,
        )
      }
      if (plan.kind !== 'update') {
        throw new ForemanUpdatePreparationError(
          'kind_mismatch',
          `preparation provider is update-kind but active plan is '${plan.kind}'`,
        )
      }

      const checkoutPath = plan.checkout_path
      const oldHead = plan.old_head
      if (!checkoutPath || !oldHead) {
        throw new ForemanUpdatePreparationError(
          'checkout_metadata_missing',
          `planned update plan '${context.operationId}' is missing checkout_path or old_head`,
        )
      }

      // Idempotent reconcile: fresh and resume share one path. When the
      // interrupted update persisted a `new_head`, supply it for the narrow
      // reconciliation path; otherwise run a normal fast-forward pull.
      const snapshot: ForemanUpdateCheckoutSnapshot = {
        checkout_path: checkoutPath,
        old_head: oldHead,
      }

      let failurePersisted = false
      try {
        const pullOptions = plan.new_head ? { recovery: { new_head: plan.new_head } } : {}
        const result = await deps.git.pullAfterDrain(snapshot, pullOptions)

        if (result.error_code) {
          deps.dispatch.updatePlannedRestart(context.operationId, {
            phase: 'updating',
            error_code: result.error_code,
            error_message: result.error_message ?? 'update pull failed',
            failed_at: clock().toISOString(),
            checkout_path: checkoutPath,
            old_head: oldHead,
          })
          failurePersisted = true
          throw new ForemanUpdatePreparationError(
            result.error_code,
            result.error_message ?? 'update pull failed',
          )
        }

        // Success: durably record the pull result (including the new HEAD) so the
        // coordinator may resume safely and the caller may observe progress.
        deps.dispatch.updatePlannedRestart(context.operationId, {
          checkout_path: checkoutPath,
          old_head: oldHead,
          new_head: result.new_head ?? null,
        })

        // Now that the new HEAD is durable, prepare the whole suite from the
        // checkout before the daemon lifecycle. A replayed preparation with a
        // persisted new_head reconciles the pull and runs preparation again.
        try {
          await prepareSuite.prepare(checkoutPath)
        } catch (error) {
          const code = error instanceof SuitePreparationError
            ? error.code
            : 'suite_preparation_failed'
          const message = error instanceof Error ? error.message : String(error)
          deps.dispatch.updatePlannedRestart(context.operationId, {
            phase: 'updating',
            error_code: code,
            error_message: message,
            failed_at: clock().toISOString(),
            checkout_path: checkoutPath,
            old_head: oldHead,
            new_head: result.new_head ?? null,
          })
          failurePersisted = true
          throw error
        }
      } catch (error) {
        // Persist fixed failure metadata once, then rethrow so the coordinator's
        // pre-stop abort path restores prior admission.
        if (!failurePersisted) {
          const code = error instanceof ForemanUpdatePreparationError
            ? error.code
            : 'update_preparation_failed'
          const message = error instanceof Error ? error.message : String(error)
          deps.dispatch.updatePlannedRestart(context.operationId, {
            phase: 'updating',
            error_code: code,
            error_message: message,
            failed_at: clock().toISOString(),
            checkout_path: checkoutPath,
            old_head: oldHead,
          })
        }
        throw error
      }
    },
  }
}
