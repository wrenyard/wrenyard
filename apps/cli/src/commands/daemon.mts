
import { parseArgs } from 'node:util'
import { runForemanService } from '@wrenyard/daemon/bootstrap'
import { requireNoPositionals } from '../helpers.mts'
import { loadServiceConfigForCli, servicePayload, writeServicePayload } from '../shared.mts'
import { stopDaemonProcess } from '../daemon-supervisor.mts'
import { readSourceDevLock, sourceDevStopNotice } from '../source-dev-lock.mts'

/**
 * A Task runs on this daemon, so stopping it from inside a Task would terminate
 * the Task's own work. Refuse before touching the daemon.
 */
function refuseDaemonLifecycleInTaskContext(command: string): void {
  if (Object.prototype.hasOwnProperty.call(process.env, 'FOREMAN_TASK_RUN_ID')) {
    throw new Error(`wrenyard daemon ${command} cannot run inside a Task: the Task runs on this daemon, so stopping it would end the work. Run it from outside the Task instead.`)
  }
}

/**
 * The single foreground owner entrypoint. The daemon runs in this process:
 * `runForemanService` owns start, the ready/shutdown/disconnect IPC contract,
 * the first-signal drain and second-signal force, and the exit code. Other
 * owners (Desktop, `pnpm dev`) launch this same command.
 */
export async function handleDaemonRun(args: string[]): Promise<number> {
  return await runForemanService(args)
}

export async function handleDaemonStop(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon stop [--config path] [--force] [--json]')

  refuseDaemonLifecycleInTaskContext('stop')

  const { config, resolvedConfigPath } = loadServiceConfigForCli(values.config, values)
  await stopDaemonProcess({ config, resolvedConfigPath, shutdownForce: values.force === true })
  const devLock = readSourceDevLock()
  if (values.json) {
    // Structured success keeps the same exit contract while giving callers a
    // machine-readable stop acknowledgement and the dev-restart notice.
    writeServicePayload(servicePayload({
      stopped: true,
      ...(devLock ? { notice: sourceDevStopNotice() } : {}),
    }))
    return 0
  }
  console.log('Wrenyard daemon stopped')
  if (devLock) console.log(sourceDevStopNotice())
  return 0
}
