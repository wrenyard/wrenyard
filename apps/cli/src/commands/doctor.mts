
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
  servicePayload,
  suiteDir,
  workspaceRootForRuntime,
  writeServicePayload,
} from '../shared.mts'
import { collectForemanStatus, formatStatusCheck } from './status.mts'
import { loadForemanServiceConfig, type ForemanServiceConfig } from '@wrenyard/daemon/config'
import { ensureDiscovered, listTasks } from '@wrenyard/daemon/workspace/task-loader'

export async function handleDoctor(args: string[] = []): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard doctor [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard doctor [--config path] [--json]')

  const json = values.json === true
  const report: Record<string, unknown> = {}
  let serviceConfig: ForemanServiceConfig | null = null
  const workDir = resolveWorkDir()
  const workspaceRoot = workspaceRootForRuntime()
  let ok = true
  let status: ForemanStatus | null = null

  report.suite = suiteDir
  report.workspace = workspaceRoot
  report.work_dir = workDir
  if (!json) {
    console.log('Wrenyard doctor')
    console.log(`Suite: ${suiteDir}`)
    console.log(`Workspace: ${workspaceRoot}`)
    console.log(`Work dir: ${workDir}`)
  }

  try {
    const configPath = resolveConfigPath(values.config)
    loadConfig(values.config)
    serviceConfig = loadForemanServiceConfig(configPath)
    report.config = { ok: true, path: configPath }
    if (!json) console.log('Config: ok')
  } catch (error) {
    report.config = { ok: false, error: errorMessage(error) }
    if (!json) console.log(`Config: failed (${errorMessage(error)})`)
    ok = false
  }

  if (serviceConfig) {
    status = await collectForemanStatus(values.config)
    report.daemon = { running: status.daemon.running }
    report.ipc = formatStatusCheck(status.ipc)
    if (!json) {
      console.log(`Daemon: ${status.daemon.running ? 'running' : 'not reachable'}`)
      console.log(`IPC: ${formatStatusCheck(status.ipc)}`)
    }
  } else {
    report.daemon = null
    report.ipc = null
  }

  if (!serviceConfig || !status?.ipc.ok) {
    report.projects = { skipped: true, reason: 'daemon unavailable' }
    if (!json) console.log('Projects: skipped (daemon unavailable)')
  } else {
    let client: IpcForemanClient | undefined
    try {
      client = await connectConfiguredForemanClient(values.config)
      const projects = await client.project.list()
      report.projects = { count: projects.length }
      if (!json) console.log(`Projects: ${projects.length} discovered`)
    } catch (error) {
      report.projects = { error: errorMessage(error) }
      if (!json) console.log(`Projects: failed (${errorMessage(error)})`)
      ok = false
    } finally {
      client?.close()
    }
  }

  try {
    await ensureDiscovered(workspaceRoot)
    const count = listTasks(workspaceRoot, undefined).length
    report.definitions = { count }
    if (!json) console.log(`Definitions: ${count} tasks`)
  } catch (error) {
    report.definitions = { error: errorMessage(error) }
    if (!json) console.log(`Definitions: failed (${errorMessage(error)})`)
    ok = false
  }

  const gitRepo = existsSync(join(suiteDir, '.git'))
  report.git_repo = gitRepo
  if (!json) {
    if (gitRepo) console.log(`Git repo OK (${suiteDir})`)
    else console.log(`Git repo not found at ${suiteDir}`)
  }
  if (!gitRepo) ok = false

  let ghAuthenticated = false
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf-8', windowsHide: true })
    ghAuthenticated = true
  } catch {
    ghAuthenticated = false
  }
  report.gh_authenticated = ghAuthenticated
  if (!json) console.log(ghAuthenticated ? 'gh authenticated' : 'gh not authenticated')

  report.ok = ok
  if (json) writeServicePayload(servicePayload(report))
  return ok ? 0 : 1
}
