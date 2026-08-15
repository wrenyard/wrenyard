import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { loadForemanServiceConfig } from '../../config/index.mts'
import { initDb, closeDb } from '../../db/connection.mts'
import { PlannedRestartStore } from '../../daemon/planned-restart-store.mts'
import { DispatchControl } from '../../daemon/dispatch-control.mts'
import {
  createRestartPreparationProvider,
  resolvePlannedRestartPreparation,
  runPlannedRestartCoordinator,
  type PlannedRestartCoordinatorDeps,
  type PlannedRestartPreparationProvider,
} from './planned-restart-coordinator.mts'
import { createForemanUpdatePreparationProvider, type ForemanUpdatePreparationDispatch } from './foreman-update-preparation.mts'
import { prepareWrenyardSuite } from './suite-update-preparation.mts'
import { ForemanUpdateGit } from '../../core/project/foreman-update.mts'
import { restartDaemonProcess } from './daemon-supervisor.mts'
import { collectForemanStatus } from './commands/status.mts'
import { applyServiceCliOverrides, errorMessage } from './shared.mts'
import type { ForemanServiceConfig } from '../../config/index.mts'
import type { PlannedRestartKind, PlannedRestartPhase, PlannedRestartPlan } from '../../daemon/planned-restart-store.mts'

export interface PlannedRestartCoordinatorProcessArgs {
  operationId: string
  kind: PlannedRestartKind
  resolvedConfigPath: string
  host?: string
  port?: string
}

const TERMINAL_PHASES = new Set<PlannedRestartPhase>(['completed', 'failed'])

/**
 * Single-mode startup decision for the coordinator child. Returns `'run'` with
 * the validated non-null plan when it matches the requested operation id and
 * kind and is nonterminal; `'noop'` when the plan is absent or terminal (the
 * parent already finished or died after completion — log one line and exit 0).
 * Any other mismatch (operation id or kind) throws so the child exits 1.
 *
 * Ownership is NOT checked here: the caller self-stamps its pid via updatePlan
 * immediately after, then re-reads to verify it won the stamp race. This avoids
 * the null-pid gap where two children could both see coordinator_pid=null and
 * both proceed to drive the engine.
 */
export function decideCoordinatorStartup(
  active: PlannedRestartPlan | null,
  args: { operationId: string; kind: PlannedRestartKind },
): { kind: 'run'; plan: PlannedRestartPlan } | { kind: 'noop'; reason: string } {
  if (!active || TERMINAL_PHASES.has(active.phase)) {
    return { kind: 'noop', reason: active ? `is ${active.phase}` : 'absent' }
  }
  if (active.operation_id !== args.operationId) {
    throw new Error(
      `cannot run planned restart coordinator '${args.operationId}': active plan '${active.operation_id}' does not match`,
    )
  }
  if (active.kind !== args.kind) {
    throw new Error(
      `cannot run planned restart coordinator '${args.operationId}': kind mismatch (active '${active.kind}', requested '${args.kind}')`,
    )
  }
  return { kind: 'run', plan: active }
}

/**
 * Private planned-restart entrypoint. Loads and validates everything the
 * coordinator needs, then runs the engine against the already-active durable
 * plan. Both `restart` (built-in no-op provider) and `update` (git-backed
 * provider injected here from `createForemanUpdatePreparationProvider`) are
 * supported; the update provider reads its checkout identity from the durable
 * plan, pulls only after the coordinator reaches a stable drain, and then
 * prepares the whole suite (pnpm install/typecheck/build plus the local Forge
 * self-install) before the daemon lifecycle begins.
 *
 * Startup validation is single-mode: the plan must exist, match the requested
 * operation id and kind, and be nonterminal. A terminal or absent plan means
 * the parent already finished or died after completion — log one line and
 * exit 0. Any other mismatch is a corrupt/conflicting state — exit 1.
 */
export async function runPlannedRestartCoordinatorProcess(
  args: PlannedRestartCoordinatorProcessArgs,
): Promise<void> {
  // 1. Load and validate the service configuration with the same supported overrides.
  const config: ForemanServiceConfig = loadForemanServiceConfig(args.resolvedConfigPath)
  applyServiceCliOverrides(config, {
    ...(typeof args.host === 'string' ? { host: args.host } : {}),
    ...(typeof args.port === 'string' ? { port: args.port } : {}),
  })
  if (!config.service.enabled) {
    throw new Error('Wrenyard daemon is disabled by config')
  }

  // 2. Initialize the coordinator SQLite connection (FOREMAN_DB_PATH or default state).
  initDb(process.env.FOREMAN_DB_PATH)

  // 3. Construct the durable store and exactly one dispatch control.
  const store = new PlannedRestartStore()
  const dispatchControl = new DispatchControl(store)

  // 4. Single-mode startup validation. The plan must already be active, match
  //    this coordinator's operation id and kind, and be nonterminal. A terminal
  //    or absent plan is a no-op (parent died or operation finished); anything
  //    else is a conflict.
  const active = store.snapshot().plan
  const decision = decideCoordinatorStartup(active, args)
  if (decision.kind === 'noop') {
    process.stdout.write(
      `planned restart coordinator '${args.operationId}' has nothing to do (plan ${decision.reason}); exiting\n`,
    )
    return
  }
  const plan = decision.plan

  // 4b. Self-stamp: atomically write our pid as coordinator_pid, then re-read
  //     the plan. If the re-read shows a different pid, another coordinator
  //     won the stamp race — exit 0 (ownership superseded). This closes the
  //     null-pid gap where two children could both see coordinator_pid=null
  //     and both proceed to drive the engine. The parent's post-spawn
  //     updatePlan (in the CLI helper) provides an early signal for join
  //     decisions, but the child's own self-stamp is the authoritative
  //     ownership claim.
  //
  //     Residual race: two children can both self-stamp before either re-reads.
  //     The store's last-write-wins means one pid overwrites the other; the
  //     loser discovers this at its re-read and exits 0. The winner's pid is
  //     the one durably persisted, so downstream join/resume decisions are
  //     consistent. The remaining accepted race is a millisecond-scale
  //     stamp/recheck interleave whose worst case is a duplicated stop/start
  //     attempt that converges through failPlan (recovery_required=true,
  //     operator-visible, recoverable by re-running the same command). The
  //     structural elimination (daemon-side ownership arbitration on stop) is
  //     deliberately out of scope for this refactor.
  dispatchControl.updatePlannedRestart(args.operationId, { coordinator_pid: process.pid })
  const postStamp = store.snapshot().plan
  if (
    !postStamp
    || postStamp.operation_id !== args.operationId
    || (typeof postStamp.coordinator_pid === 'number' && postStamp.coordinator_pid !== process.pid)
  ) {
    process.stdout.write(
      `planned restart coordinator '${args.operationId}' superseded by pid ${postStamp?.coordinator_pid ?? 'unknown'}; exiting\n`,
    )
    return
  }

  // 5. Resolve the preparation provider. For update, construct the git-backed
  //    provider exactly once from the durable plan's checkout identity. No
  //    preflight happens here; after the drain the provider pulls the suite
  //    and prepares it (install/typecheck/build/forge self-install) before the
  //    daemon lifecycle runs.
  const injectedProviders: PlannedRestartPreparationProvider[] = []
  if (args.kind === 'update') {
    if (!plan.checkout_path || !plan.old_head) {
      throw new Error(
        `cannot run update coordinator '${args.operationId}': durable plan is missing checkout_path or old_head`,
      )
    }
    const preparationDispatch: ForemanUpdatePreparationDispatch = {
      status: () => dispatchControl.status(),
      readRawPlan: (op) => (op === args.operationId ? store.snapshot().plan : null),
      updatePlannedRestart: (op, update) => dispatchControl.updatePlannedRestart(op, update),
    }
    const git = new ForemanUpdateGit(plan.checkout_path)
    injectedProviders.push(createForemanUpdatePreparationProvider({
      git,
      dispatch: preparationDispatch,
      // Explicit for clarity: the real detached coordinator activates full
      // suite preparation while tests inject a no-op preparer.
      prepareSuite: { prepare: prepareWrenyardSuite },
    }))
  }
  resolvePlannedRestartPreparation(
    createRestartPreparationProvider().concat(injectedProviders),
    args.kind,
  )

  // 6. Eagerly bind the daemon lifecycle and status collection the coordinator drives.
  const deps: PlannedRestartCoordinatorDeps = {
    dispatchControl,
    collectForemanStatus: (configPathValue: unknown) => collectForemanStatus(configPathValue),
    restartDaemonProcess: (lifecycleOptions, hooks) =>
      restartDaemonProcess(
        {
          ...lifecycleOptions,
          cliValues: {
            ...lifecycleOptions.cliValues,
            ...(typeof args.host === 'string' ? { host: args.host } : {}),
            ...(typeof args.port === 'string' ? { port: args.port } : {}),
          },
        },
        hooks,
      ),
  }

  // 7. Run the engine against the active plan.
  await runPlannedRestartCoordinator(
    {
      operationId: args.operationId,
      config,
      resolvedConfigPath: args.resolvedConfigPath,
      coordinatorPid: process.pid,
      ...(injectedProviders.length > 0 ? { providers: injectedProviders } : {}),
    },
    deps,
  )
}

function parseCoordinatorProcessArgs(argv: string[]): PlannedRestartCoordinatorProcessArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      'operation-id': { type: 'string' },
      kind: { type: 'string' },
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  })

  const operationId = values['operation-id']
  const kind = values.kind
  const config = values.config

  if (typeof operationId !== 'string' || !operationId) throw new Error('--operation-id is required')
  if (kind !== 'restart' && kind !== 'update') throw new Error("--kind must be 'restart' or 'update'")
  if (typeof config !== 'string' || !config) throw new Error('--config is required')

  return {
    operationId,
    kind: kind as PlannedRestartKind,
    resolvedConfigPath: config,
    ...(typeof values.host === 'string' ? { host: values.host } : {}),
    ...(typeof values.port === 'string' ? { port: values.port } : {}),
  }
}

const isDirectEntry = (() => {
  try {
    return resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isDirectEntry) {
  runPlannedRestartCoordinatorProcess(parseCoordinatorProcessArgs(process.argv.slice(2)))
    .then(() => {
      try {
        closeDb()
      } catch {
        // ignore close errors during shutdown
      }
      process.exit(0)
    })
    .catch((error: unknown) => {
      process.stderr.write(`planned restart coordinator failed: ${errorMessage(error)}\n`)
      try {
        closeDb()
      } catch {
        // ignore close errors during shutdown
      }
      process.exit(1)
    })
}
