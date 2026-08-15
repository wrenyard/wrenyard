
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import { connectIpcForemanClient } from '../../ipc-foreman-client.mts'
import { resolveForemanServiceIpcPath } from '../../../transport/ipc-server.mts'
import { loadServiceConfigForCli, type ForemanStatus } from '../shared.mts'
import { startDaemonProcess, stopDaemonProcess } from '../daemon-supervisor.mts'
import { collectForemanStatus } from './status.mts'
import {
  type CoordinatorSpawn,
} from '../planned-restart-launcher.mts'
import { PlannedRestartStore } from '../../../daemon/planned-restart-store.mts'
import { DispatchControl } from '../../../daemon/dispatch-control.mts'
import { initDb } from '../../../db/connection.mts'
import type { PlannedRestartPhase, PlannedRestartPlanSummary } from '../../../daemon/planned-restart-store.mts'
import {
  runPlannedRestartCommand,
  type LaunchCoordinatorFn,
} from '../planned-restart-command.mts'

export async function handleDaemonStart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'public-url': { type: 'string' },
      'work-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon start [--config path] [--host addr] [--port n]')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon is disabled by config')

  const result = await startDaemonProcess({ config, resolvedConfigPath, cliValues: values })

  console.log(`Wrenyard daemon ${result.alreadyRunning ? 'already running' : 'started'}${result.pid ? ` (pid ${result.pid})` : ''}`)
  console.log(`IPC: ${result.ipcPath}`)
  console.log(`Logs: ${result.logPaths.stderr}`)
  return 0
}

export async function handleDaemonStop(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon stop [--config path]')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  const result = await stopDaemonProcess({ config, resolvedConfigPath, cliValues: values })
  console.log('Wrenyard daemon stopped')
  if (result.forced) console.log('Stop required process fallback after IPC shutdown failed or timed out')
  return 0
}

export interface DaemonRestartScheduledResult {
  operation_id: string
  scheduled: true
  status_endpoint: string
  joining: boolean
}

export interface DaemonRestartCompletedResult {
  operation_id: string
  scheduled: false
  phase: PlannedRestartPhase
  restart_result: 'completed' | 'failed'
  health_result: ForemanStatus
}

export type DaemonRestartResult = DaemonRestartScheduledResult | DaemonRestartCompletedResult

export interface DaemonRestartCommandDeps {
  plannedRestartStore?: PlannedRestartStore
  dispatchControl?: DispatchControl
  launchCoordinator?: LaunchCoordinatorFn
  spawnProcess?: CoordinatorSpawn
  isCoordinatorAlive?: (pid: number) => boolean
  waitForPlanTerminal?: typeof import('../planned-restart-coordinator.mts').waitForPlanTerminal
  collectForemanStatus?: typeof collectForemanStatus
  sleep?: (ms: number) => Promise<void>
  acquireLock?: () => Promise<{ release: () => void }>
  commandEnv?: NodeJS.ProcessEnv
}

function generateOperationId(): string {
  return `op_restart_${randomBytes(12).toString('hex')}`
}

/**
 * Safe planned restart. From task context it schedules (plan-first) and
 * returns immediately; a human without --no-wait waits for the same operation
 * to reach a terminal state and reports the final health. It never performs
 * stop/start in the caller process — the detached coordinator owns the
 * lifecycle. An active update plan is rejected; a terminal recovery-required
 * plan is surfaced, never retried implicitly.
 */
export async function handleDaemonRestart(
  args: string[],
  deps: DaemonRestartCommandDeps = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'no-wait': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log('Usage: wrenyard daemon restart [--config path] [--host addr] [--port n] [--no-wait] [--json]')
    return 0
  }
  requireNoPositionals(positionals, 'wrenyard daemon restart [--config path] [--host addr] [--port n] [--no-wait] [--json]')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon is disabled by config')

  // Initialize the SQLite connection (FOREMAN_DB_PATH or default state) so this
  // standalone CLI process can read dispatch status and schedule a plan.
  initDb(process.env.FOREMAN_DB_PATH)

  const store = deps.plannedRestartStore ?? new PlannedRestartStore()
  const dispatchControl = deps.dispatchControl ?? new DispatchControl(store)
  const commandEnv = deps.commandEnv ?? process.env
  const isTaskContext = Object.prototype.hasOwnProperty.call(commandEnv, 'FOREMAN_TASK_RUN_ID')
  const collectStatus = deps.collectForemanStatus ?? collectForemanStatus

  return runPlannedRestartCommand<DaemonRestartResult>({
    kind: 'restart',
    resolvedConfigPath,
    ...(typeof values.host === 'string' ? { host: values.host } : {}),
    ...(typeof values.port === 'string' ? { port: values.port } : {}),
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
    generateOperationId,
    hooks: {
      buildScheduledResult: ({ operationId, joining }) => ({
        operation_id: operationId,
        scheduled: true,
        status_endpoint: 'wrenyard status --json',
        joining,
      }),
      buildTerminalResult: async ({ operationId, terminal }) =>
        buildDaemonRestartCompletedResult(operationId, terminal, await collectStatus(resolvedConfigPath)),
      printHuman: printDaemonRestartHuman,
      exitCode: (result) =>
        (result as DaemonRestartScheduledResult).scheduled === true
          ? 0
          : (result as DaemonRestartCompletedResult).phase === 'completed'
            ? 0
            : 1,
      oppositeKindRejection:
        'A planned update is currently active; restart is not available until it completes or is recovered.',
    },
  })
}

async function buildDaemonRestartCompletedResult(
  operationId: string,
  terminal: PlannedRestartPlanSummary | null,
  health: ForemanStatus,
): Promise<DaemonRestartCompletedResult> {
  return {
    operation_id: operationId,
    scheduled: false,
    phase: terminal ? terminal.phase : 'failed',
    restart_result: terminal && terminal.phase === 'completed' ? 'completed' : 'failed',
    health_result: health,
  }
}

function printDaemonRestartHuman(result: DaemonRestartResult): void {
  if (result.scheduled) {
    if (result.joining) {
      console.log(`Joined running planned restart ${result.operation_id}. Track with: ${result.status_endpoint}`)
    } else {
      console.log(`Planned restart ${result.operation_id} scheduled. Track with: ${result.status_endpoint}`)
    }
    return
  }
  if (result.restart_result === 'completed') {
    console.log(`Planned restart ${result.operation_id} completed.`)
  } else {
    console.log(`Planned restart ${result.operation_id} failed.`)
  }
}

export async function handleDaemonFreeze(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon freeze [--config path] [--json]')
  const client = await connectIpcForDaemon(values.config)
  try {
    const result = await client.daemon.freeze()
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('Dispatch frozen.')
      if (result.activeTaskCount > 0) console.log(`  Active tasks: ${result.activeTaskCount}`)
      if (result.activeWorkflowCount > 0) console.log(`  Active workflows: ${result.activeWorkflowCount}`)
      if (result.activeExecutionCount > 0) console.log(`  Active executions: ${result.activeExecutionCount}`)
    }
    return 0
  } finally {
    client.close()
  }
}

export async function handleDaemonThaw(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon thaw [--config path] [--json]')
  const client = await connectIpcForDaemon(values.config)
  try {
    const result = await client.daemon.thaw()
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      // Inspect the actual returned accepting state so an active planned_restart
      // is never reported as successfully thawed.
      console.log(result.accepting ? 'Dispatch thawed.' : 'Dispatch not reopened.')
    }
    return 0
  } finally {
    client.close()
  }
}

export async function handleDaemonDrain(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'timeout-ms': { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon drain [--config path] [--timeout-ms ms] [--json]')
  const timeoutMs = values['timeout-ms'] !== undefined
    ? parsePositiveTimeoutFlag(values['timeout-ms'])
    : undefined
  const client = await connectIpcForDaemon(values.config)
  try {
    const result = await client.daemon.drain({ ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) })
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.drained) {
        console.log('Drained.')
      } else {
        console.log(`Drain timed out.`)
        if (result.activeTaskCount > 0) console.log(`  Active tasks: ${result.activeTaskCount}`)
        if (result.activeWorkflowCount > 0) console.log(`  Active workflows: ${result.activeWorkflowCount}`)
        if (result.activeExecutionCount > 0) console.log(`  Active executions: ${result.activeExecutionCount}`)
      }
    }
    return result.drained ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleDaemonDispatchStatus(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon dispatch-status [--config path] [--json]')
  const client = await connectIpcForDaemon(values.config)
  try {
    const result = await client.daemon.status()
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Dispatch: ${result.mode}`)
      console.log(`  Active tasks: ${result.activeTaskCount}`)
      console.log(`  Active workflows: ${result.activeWorkflowCount}`)
      console.log(`  Active executions: ${result.activeExecutionCount}`)
    }
    return 0
  } finally {
    client.close()
  }
}

async function connectIpcForDaemon(configPathValue: unknown) {
  const { config } = loadServiceConfigForCli(configPathValue)
  const ipcPath = resolveForemanServiceIpcPath({
    port: config.service.port,
    path: config.service.ipc?.path,
  })
  return connectIpcForemanClient({ path: ipcPath, timeoutMs: 5_000 })
}

function parsePositiveTimeoutFlag(value: string | boolean | undefined): number {
  if (value === undefined || value === false) throw new Error('--timeout-ms must be a positive integer')
  if (typeof value !== 'string' || !/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  return Number(value)
}
