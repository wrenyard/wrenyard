
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { resolveForemanConfigPath } from '@wrenyard/daemon/config'
import { packagedDaemonLaunch } from '@wrenyard/daemon/daemon/launch'
import { bundledSuiteRoot, runningFromBundle } from '@wrenyard/daemon/layout/suite-root'
import { requireNoPositionals } from '../helpers.mts'
import { loadServiceConfigForCli, servicePayload, writeServicePayload } from '../shared.mts'
import { stopDaemonProcess } from '../daemon-supervisor.mts'

/**
 * A Task runs on this daemon, so stopping it from inside a Task would terminate
 * the Task's own work. Refuse before touching the daemon.
 */
function refuseDaemonLifecycleInTaskContext(command: string): void {
  if (Object.prototype.hasOwnProperty.call(process.env, 'WRENYARD_TASK_RUN_ID')) {
    throw new Error(`wrenyard daemon ${command} cannot run inside a Task: the Task runs on this daemon, so stopping it would end the work. Run it from outside the Task instead.`)
  }
}

/**
 * The foreground owner entrypoint. From source the daemon runs in this process
 * (`runForemanService` owns the ready/shutdown IPC contract, first-signal drain
 * and second-signal force); the installed CLI runs the bundled daemon with the
 * suite's Node runtime in the foreground and returns its exit code.
 */
export async function handleDaemonRun(args: string[]): Promise<number> {
  if (!runningFromBundle) {
    const { runForemanService } = await import('@wrenyard/daemon/bootstrap')
    return await runForemanService(args)
  }
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, 'work-dir': { type: 'string' } }, allowPositionals: true, strict: false })
  const launch = packagedDaemonLaunch(bundledSuiteRoot, resolveForemanConfigPath(values.config))
  if (typeof values['work-dir'] === 'string') launch.args.push('--work-dir', values['work-dir'])
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: 'inherit', windowsHide: true })
  // The daemon receives the terminal's signals itself and drains; this process only waits.
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  process.on('SIGTERM', ignore)
  return await new Promise<number>((resolveExit) => {
    child.once('error', (error) => {
      console.error(`wrenyard: failed to start the bundled daemon: ${error.message}`)
      resolveExit(1)
    })
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
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
  if (values.json) {
    // Structured success keeps the same exit contract while giving callers a
    // machine-readable stop acknowledgement.
    writeServicePayload(servicePayload({
      stopped: true,
    }))
    return 0
  }
  console.log('Wrenyard daemon stopped')
  return 0
}
