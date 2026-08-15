
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import {
  type ForemanStatus,
  type IpcForemanClient,
  connectConfiguredForemanClient,
  errorMessage,
  isHelpRequest,
  loadConfig,
  resolveConfigPath,
  resolveWorkDir,
  suiteDir,
  whichCmd,
  workspaceRootForRuntime,
} from '../shared.mts'
import { collectForemanStatus, formatStatusCheck } from './status.mts'
import { loadForemanServiceConfig, type ForemanServiceConfig } from '../../../config/index.mts'
import { resolveDaemonForgeEnv } from '../../../daemon/execution/forge-support.mts'
import { ensureDiscovered, listTasks } from '../../../workspace/task-loader.mts'

export async function handleDoctor(args: string[] = []): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard doctor [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard doctor [--config path]')

  let serviceConfig: ForemanServiceConfig | null = null
  const workDir = resolveWorkDir()
  const workspaceRoot = workspaceRootForRuntime()
  let ok = true
  let status: ForemanStatus | null = null

  console.log('Wrenyard doctor')
  console.log(`Suite: ${suiteDir}`)
  console.log(`Workspace: ${workspaceRoot}`)
  console.log(`Work dir: ${workDir}`)

  try {
    loadConfig(values.config)
    serviceConfig = loadForemanServiceConfig(resolveConfigPath(values.config))
    console.log('Config: ok')
  } catch (error) {
    console.log(`Config: failed (${errorMessage(error)})`)
    ok = false
  }

  if (serviceConfig) {
    status = await collectForemanStatus(values.config)
    console.log(`Daemon: ${status.daemon.running ? 'running' : 'not reachable'}`)
    console.log(`IPC: ${formatStatusCheck(status.ipc)}`)
    console.log(`HTTP: ${formatStatusCheck(status.http)}`)
    console.log(`MCP: ${formatStatusCheck(status.mcp)}`)
    console.log(`DB: ${formatStatusCheck(status.db)}`)
  }

  if (!serviceConfig || !status?.ipc.ok) {
    console.log('Projects: skipped (daemon unavailable)')
  } else {
    let client: IpcForemanClient | undefined
    try {
      client = await connectConfiguredForemanClient(values.config)
      const projects = await client.project.list()
      console.log(`Projects: ${projects.length} discovered`)
    } catch (error) {
      console.log(`Projects: failed (${errorMessage(error)})`)
      ok = false
    } finally {
      client?.close()
    }
  }

  try {
    await ensureDiscovered(workspaceRoot)
    console.log(`Definitions: ${listTasks(workspaceRoot, undefined).length} tasks`)
  } catch (error) {
    console.log(`Definitions: failed (${errorMessage(error)})`)
    ok = false
  }

  if (serviceConfig) {
    const messagePrincipals = Object.keys(serviceConfig.message.principals ?? {}).length
    const messageRoutes = Object.keys(serviceConfig.message.routes ?? {}).length
    console.log(`Message config: ${serviceConfig.message.enabled ? 'enabled' : 'disabled'} (${messagePrincipals} principals, ${messageRoutes} routes)`)
    const deliveryConfig = serviceConfig.messageDelivery
    const deliveryChannels = Object.keys(deliveryConfig?.channels ?? {}).length
    const deliveryEnabled = deliveryConfig?.enabled ?? false
    console.log(`Message delivery config: ${deliveryEnabled ? 'enabled' : 'disabled'} (${deliveryChannels} channels)`)
  }

  if (existsSync(join(suiteDir, '.git'))) {
    console.log(`Git repo OK (${suiteDir})`)
  } else {
    console.log(`Git repo not found at ${suiteDir}`)
    ok = false
  }

  try {
    execFileSync(whichCmd, ['forge'], { stdio: 'pipe', env: resolveDaemonForgeEnv(), windowsHide: true })
    console.log('Forge binary OK')
  } catch {
    console.log("Forge binary 'forge' not found on PATH")
  }

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf-8', windowsHide: true })
    console.log('gh authenticated')
  } catch {
    console.log('gh not authenticated')
  }

  return ok ? 0 : 1
}
