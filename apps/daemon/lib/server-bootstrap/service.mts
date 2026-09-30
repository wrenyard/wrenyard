import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadForemanServiceConfig, resolveForemanConfigPath, type ForemanServiceConfig } from '../config/index.mts'
import { ForemanDaemon, writeDaemonLog } from '../daemon/daemon.mts'

function requireNoPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument: ${positionals[0]}\nUsage: ${usage}`)
  }
}

const defaultConfigPath = resolveForemanConfigPath()

function resolveConfigPath(value: unknown): string {
  return typeof value === 'string' && value.trim() ? resolve(value.trim()) : defaultConfigPath
}

function applyServiceCliOverrides(config: ForemanServiceConfig, values: Record<string, unknown>): void {
  if (typeof values['work-dir'] === 'string') config.workspaceRoot = resolve(values['work-dir'])
}

function loadServiceConfigForDaemon(configPathValue: unknown, values: Record<string, unknown> = {}): {
  config: ForemanServiceConfig
  resolvedConfigPath: string
} {
  const resolvedConfigPath = resolveConfigPath(configPathValue)
  const config = loadForemanServiceConfig(resolvedConfigPath)
  applyServiceCliOverrides(config, values)
  return { config, resolvedConfigPath }
}

export async function runForemanService(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'work-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon run [--config path]')

  const { config, resolvedConfigPath } = loadServiceConfigForDaemon(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon service is disabled by config')

  const daemon = new ForemanDaemon({
    config,
    configPath: resolvedConfigPath,
    // Ready logs and the parent-process notification are the named startup
    // notification; run() does not call start() a second time to learn about it.
    onStarted: ({ ipcPath }) => {
      // The shared daemon logger appends every line to <state>/logs/daemon.log
      // as well as stderr, so the foreground owner's startup lines and all
      // runtime diagnostics land in one file with no duplicate writers.
      writeDaemonLog('info', `listening (IPC ${ipcPath})`)
      writeDaemonLog('info', `workspace: ${config.workspaceRoot}`)
      if (process.connected && process.send) {
        // The no-op callback routes a channel-closed send error to the callback
        // instead of the process 'error' event when the parent disconnected
        // during bootstrap.
        process.send('ready', () => {})
      }
    },
  })

  // Handlers are installed before run() so a signal, a parent message or a
  // parent IPC disconnect that arrives during bootstrap is recorded on the
  // daemon rather than lost. The first SIGINT/SIGTERM requests a graceful
  // shutdown that drains admitted work; a second escalates to a forced close.
  // A disconnect requests the same graceful drain and never forces cancellation.
  let signalCount = 0
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1
    daemon.requestShutdown(signalCount > 1 ? `${signal} (forced)` : signal, signalCount > 1)
  }
  process.on('SIGTERM', () => { onSignal('SIGTERM') })
  process.on('SIGINT', () => { onSignal('SIGINT') })
  process.on('message', (msg) => {
    if (msg === 'shutdown') daemon.requestShutdown('process shutdown message')
  })
  process.on('disconnect', () => { daemon.requestShutdown('parent disconnected') })

  // run() owns start -> await shutdown request -> drain -> close -> exit code.
  return await daemon.run()
}
