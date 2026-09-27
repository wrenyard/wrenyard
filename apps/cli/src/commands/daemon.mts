
import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import { loadServiceConfigForCli } from '../shared.mts'
import { restartDaemonProcess, startDaemonProcess, stopDaemonProcess } from '../daemon-supervisor.mts'
import { readSourceDevLock, sourceDevLockRefusalMessage, sourceDevStopNotice } from '../source-dev-lock.mts'

/**
 * A Task runs on this daemon, so stopping or restarting it from inside a Task
 * would terminate the Task's own work. Refuse before touching the daemon.
 */
function refuseDaemonLifecycleInTaskContext(command: string): void {
  if (Object.prototype.hasOwnProperty.call(process.env, 'FOREMAN_TASK_RUN_ID')) {
    throw new Error(`wrenyard daemon ${command} cannot run inside a Task: the Task runs on this daemon, so stopping or restarting it would end the work. Run it from outside the Task instead.`)
  }
}

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
      force: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon stop [--config path] [--force]')

  refuseDaemonLifecycleInTaskContext('stop')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  await stopDaemonProcess({ config, resolvedConfigPath, cliValues: values, shutdownForce: values.force === true })
  console.log('Wrenyard daemon stopped')
  if (readSourceDevLock()) console.log(sourceDevStopNotice())
  return 0
}

export interface DaemonRestartResult {
  restarted: boolean
  pid: number | null
}

/**
 * Synchronous restart: stop the running daemon, then start it again in this
 * process. `--force` skips the drain via `daemon.shutdown {force:true}`. The
 * shared stop path prints the active-work count every 10 seconds to stderr, so
 * `--json` still emits a single machine-readable envelope on stdout.
 */
export async function handleDaemonRestart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log('Usage: wrenyard daemon restart [--config path] [--host addr] [--port n] [--force] [--json]')
    return 0
  }
  requireNoPositionals(positionals, 'wrenyard daemon restart [--config path] [--host addr] [--port n] [--force] [--json]')

  refuseDaemonLifecycleInTaskContext('restart')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon is disabled by config')

  // A live `pnpm dev` owns the daemon and restarts it itself, so a second
  // restart would fight it for the IPC path.
  const devLock = readSourceDevLock()
  if (devLock) throw new Error(sourceDevLockRefusalMessage(devLock))

  const cliValues = {
    ...(typeof values.host === 'string' ? { host: values.host } : {}),
    ...(typeof values.port === 'string' ? { port: values.port } : {}),
  }

  const result = await restartDaemonProcess({
    config,
    resolvedConfigPath,
    cliValues,
    shutdownForce: values.force === true,
  })

  const payload: DaemonRestartResult = { restarted: true, pid: result.pid ?? null }
  if (values.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(`Wrenyard daemon restarted${payload.pid ? ` (pid ${payload.pid})` : ''}`)
  }
  return 0
}
