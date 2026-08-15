#!/usr/bin/env tsx
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadForemanServiceConfig, resolveForemanConfigPath, type ForemanServiceConfig } from '../../../config/index.mts'
import { ForemanDaemon } from '../../../daemon/daemon.mts'
import { parsePositiveIntegerFlag, requireNoPositionals } from '../helpers.mts'

const defaultConfigPath = resolveForemanConfigPath()

function resolveConfigPath(value: unknown): string {
  return typeof value === 'string' && value.trim() ? resolve(value.trim()) : defaultConfigPath
}

function applyServiceCliOverrides(config: ForemanServiceConfig, values: Record<string, unknown>): void {
  if (typeof values.host === 'string') config.service.host = values.host
  if (typeof values.port === 'string') config.service.port = parsePositiveIntegerFlag(values.port, '--port', config.service.port)
  if (typeof values['public-url'] === 'string') config.service.publicUrl = values['public-url']
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
      host: { type: 'string' },
      port: { type: 'string' },
      'public-url': { type: 'string' },
      'work-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard daemon service [--config path] [--host addr] [--port n]')

  const { config, resolvedConfigPath } = loadServiceConfigForDaemon(values.config, values)
  if (!config.service.enabled) throw new Error('Wrenyard daemon service is disabled by config')

  let shutdownFromRpc: ((reason: string) => Promise<void>) | undefined
  const daemon = new ForemanDaemon({
    config,
    configPath: resolvedConfigPath,
    onShutdownRequest: async (reason) => {
      await shutdownFromRpc?.(reason)
    },
  })
  const running = await daemon.start()
  process.stderr.write(`[foreman-daemon] listening on http://${config.service.host}:${config.service.port}\n`)
  process.stderr.write(`[foreman-daemon] MCP:     http://${config.service.host}:${config.service.port}/mcp\n`)
  process.stderr.write(`[foreman-daemon] Message: use send_message on /mcp?sender=<role-id>\n`)
  process.stderr.write(`[foreman-daemon] Health:  http://${config.service.host}:${config.service.port}/health\n`)
  process.stderr.write(`[foreman-daemon] IPC:     ${running.ipcPath}\n`)
  process.stderr.write(`[foreman-daemon] workspace: ${config.workspaceRoot}\n`)

  if (process.send) process.send('ready')

  let shuttingDown = false

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    const forceExitTimer = setTimeout(() => process.exit(1), 5000)
    forceExitTimer.unref()
    console.log(`[foreman] Shutting down: ${reason}`)

    try {
      await daemon.stop()
    } catch {
      // Best effort during process shutdown.
    }

    process.exit(0)
  }
  shutdownFromRpc = shutdown

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('process shutdown message')
  })

  await new Promise(() => {})
  return 0
}
