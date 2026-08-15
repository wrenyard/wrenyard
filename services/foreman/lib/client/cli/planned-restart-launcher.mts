import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { foremanDir } from './shared.mts'
import { foremanStateRoot } from '../../config/state.mts'
import { errorMessage } from './shared.mts'
import type { PlannedRestartKind } from '../../daemon/planned-restart-store.mts'
import { resolveDependencyPackageRoot } from '../../layout/suite-root.mts'

/**
 * Structural spawn signature for the coordinator child. The real `spawn` from
 * `node:child_process` satisfies this; tests inject a fake that returns an
 * EventEmitter-shaped {@link ChildProcess}.
 */
export type CoordinatorSpawn = (
  command: string,
  args: readonly string[],
  options: import('node:child_process').SpawnOptions,
) => import('node:child_process').ChildProcess

/**
 * Dispatch surface the launcher drives. It is the coordinator's dispatch plus
 * `beginPlannedRestart`, used by the CLI helper to activate a fresh plan
 * before spawning the coordinator (plan-first).
 */
export interface PlannedRestartLauncherDispatch {
  status: () => import('../../daemon/dispatch-control.mts').DispatchStatus
  updatePlannedRestart: (operationId: string, update: import('../../daemon/planned-restart-store.mts').PlannedRestartPlanUpdate) => void
  completePlannedRestart: (operationId: string) => void
  abortPlannedRestart: (operationId: string) => void
  failPlannedRestart: (operationId: string, failure: import('../../daemon/planned-restart-store.mts').PlannedRestartFailure) => void
  beginPlannedRestart: (plan: import('../../daemon/planned-restart-store.mts').PlannedRestartPlan) => void
}

export interface PlannedRestartLauncherDeps {
  dispatchControl: PlannedRestartLauncherDispatch
  spawnProcess?: CoordinatorSpawn
}

export interface LaunchPlannedRestartOptions {
  operationId: string
  kind: PlannedRestartKind
  resolvedConfigPath: string
  host?: string
  port?: string
}

export interface LaunchPlannedRestartResult {
  child: import('node:child_process').ChildProcess
  pid: number
  logPath: string
}

/**
 * Build the detached child invocation: process.execPath with the repository-local
 * tsx preflight/loader in front of the private coordinator entrypoint, followed
 * by non-shell arguments (operation id, kind, resolved config path, and
 * supported host/port overrides). The coordinator runs in a single mode: it
 * reads its durable plan (including checkout identity for updates) from the
 * store rather than from argv, so no `--mode`/`--checkout-path`/`--old-head`
 * arguments are emitted.
 */
export function buildPlannedRestartCoordinatorInvocation(options: {
  operationId: string
  kind: PlannedRestartKind
  resolvedConfigPath: string
  host?: string
  port?: string
}): { command: string; args: string[] } {
  const tsxPackageRoot = resolveDependencyPackageRoot(foremanDir, 'tsx')
  const preflightPath = join(tsxPackageRoot, 'dist', 'preflight.cjs')
  const loaderPath = join(tsxPackageRoot, 'dist', 'loader.mjs')
  if (!existsSync(preflightPath) || !existsSync(loaderPath)) {
    throw new Error('Local tsx loader files were not found. Run pnpm install at the Wrenyard suite root.')
  }
  const args: string[] = [
    '--require',
    preflightPath,
    '--import',
    pathToFileURL(loaderPath).href,
    join(foremanDir, 'lib', 'client', 'cli', 'planned-restart-coordinator-process.mts'),
    '--operation-id',
    options.operationId,
    '--kind',
    options.kind,
    '--config',
    options.resolvedConfigPath,
  ]
  appendStringOverride(args, '--host', options.host)
  appendStringOverride(args, '--port', options.port)
  return { command: process.execPath, args }
}

function appendStringOverride(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) args.push(flag, value)
}

export function resolveCoordinatorLogPath(operationId: string): string {
  return join(foremanStateRoot(), 'logs', `planned-restart-coordinator-${operationId}.log`)
}

function openAppendLog(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true })
  return openSync(logPath, 'a')
}

/**
 * Launch the detached coordinator child and resolve immediately with the
 * resulting pid. The child runs in a single mode and reads its durable plan
 * from the store. stdio is purely file-backed (stdout/stderr to the
 * coordinator log) — there is no IPC channel, no readiness handshake, and no
 * activation wait: the parent activates the plan before spawning (fresh) or
 * merely stamps `coordinator_pid` afterwards (resume). The child is unref'd so
 * it has no lifetime dependency on the caller or the old daemon.
 */
export function launchPlannedRestartCoordinator(
  options: LaunchPlannedRestartOptions,
  deps: PlannedRestartLauncherDeps,
): LaunchPlannedRestartResult {
  const spawnProcess = deps.spawnProcess ?? spawn
  const invocation = buildPlannedRestartCoordinatorInvocation(options)
  const logPath = resolveCoordinatorLogPath(options.operationId)
  const stdoutFd = openAppendLog(logPath)
  const stderrFd = openAppendLog(logPath)

  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.FOREMAN_TASK_RUN_ID
  env.FOREMAN_CONFIG = options.resolvedConfigPath

  let child: import('node:child_process').ChildProcess
  try {
    child = spawnProcess(invocation.command, invocation.args, {
      cwd: foremanDir,
      env,
      detached: true,
      shell: false,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    })
  } catch (error) {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    throw new Error(`Failed to spawn planned restart coordinator: ${errorMessage(error)}`)
  }

  const pid = child.pid
  if (!pid) {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    throw new Error('planned restart coordinator did not expose a pid')
  }

  closeSync(stdoutFd)
  closeSync(stderrFd)
  child.unref()

  return { child, pid, logPath }
}

export function isCoordinatorAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}
