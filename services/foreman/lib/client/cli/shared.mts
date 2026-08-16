
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { foremanPackageRoot, resolveWrenyardSuiteRoot } from '../../layout/suite-root.mts'
import { connectIpcForemanClient } from '../ipc-foreman-client.mts'
import { ProtocolError } from '../../protocol/errors.mts'
import { loadForemanServiceConfig, loadForemanConfigData, resolveDefaultForemanConfigPath, resolveForemanConfigPath as configResolveForemanConfigPath, type ForemanServiceConfig } from '../../config/index.mts'
import { resolveForemanServiceIpcPath } from '../../transport/ipc-server.mts'
import { parsePositiveIntegerFlag } from './helpers.mts'

export const foremanDir = foremanPackageRoot
export const suiteDir = resolveWrenyardSuiteRoot({ packageRoot: foremanDir })
export const configPath = resolveDefaultForemanConfigPath()
export const whichCmd = process.platform === 'win32' ? 'where' : 'which'

export type JsonRecord = Record<string, unknown>

export const TASK_TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'interrupted'])
export const TASK_IPC_POLL_INTERVAL_MS = 100
export const POWERSHELL_COMMAND_LINE_ENV = 'WRENYARD_POWERSHELL_COMMAND_LINE'

export type IpcForemanClient = Awaited<ReturnType<typeof connectIpcForemanClient>>

export interface StatusCheck {
  ok: boolean
  error?: string
  status?: number | string
  url?: string
  path?: string
  payload?: unknown
}

export interface ForemanStatus {
  ok: boolean
  uptimeMs?: number
  config: {
    ok: boolean
    path: string
  }
  daemon: {
    running: boolean
    process: string
    status?: string
    pid?: number
    pidAlive?: boolean
    statePath?: string
    pidPath?: string
    suiteRoot?: string
    suiteVersion?: string
    logPaths?: {
      stdout: string
      stderr: string
    }
  }
  ipc: StatusCheck
  http: StatusCheck
  mcp: StatusCheck
  db: StatusCheck
  // Daemon dispatch-admission projection. Present only when daemon.status is
  // reachable; omitted on lookup failure so we never fabricate an accepting
  // mode or zero active counts.
  mode?: 'accepting' | 'frozen' | 'planned_restart'
  active_task_count?: number
  active_workflow_count?: number
  active_execution_count?: number
  recovery_required?: boolean
  operation_id?: string
  kind?: 'update' | 'restart'
  phase?: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
}

export function applyServiceCliOverrides(config: ForemanServiceConfig, values: Record<string, unknown>): void {
  if (typeof values.host === 'string') config.service.host = values.host
  if (typeof values.port === 'string') config.service.port = parsePositiveIntegerFlag(values.port, '--port', config.service.port)
  if (typeof values['public-url'] === 'string') config.service.publicUrl = values['public-url']
  if (typeof values['work-dir'] === 'string') config.workspaceRoot = resolve(values['work-dir'])
}

export function loadServiceConfigForCli(configPathValue: unknown, values: Record<string, unknown> = {}): {
  config: ForemanServiceConfig
  resolvedConfigPath: string
} {
  const resolvedConfigPath = resolveConfigPath(configPathValue)
  const config = loadForemanServiceConfig(resolvedConfigPath)
  applyServiceCliOverrides(config, values)
  return { config, resolvedConfigPath }
}

export interface ForemanConfig {
  messageDelivery?: {
    enabled?: boolean
  }
}

export function resolveWorkDir(): string {
  const override = process.env.WRENYARD_TEST_WORK_DIR?.trim() || process.env.FOREMAN_TEST_WORK_DIR?.trim()
  if (override) return resolve(override)

  const workspaceRoot = process.env.WRENYARD_WORKSPACE?.trim() || process.env.FOREMAN_WORKSPACE?.trim()
  if (workspaceRoot) return resolve(workspaceRoot)

  let current = resolve(foremanDir)
  while (true) {
    if (existsSync(join(current, 'gol-project'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return foremanDir
}

export function resolveRepoDir(workDir: string): string {
  const golProjectDir = join(workDir, 'gol-project')
  if (existsSync(golProjectDir)) return golProjectDir
  return workDir
}

export async function isIpcReachable(ipcPath: string): Promise<boolean> {
  let client: IpcForemanClient | undefined
  try {
    client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 300 })
    await client.health.ping()
    return true
  } catch {
    return false
  } finally {
    client?.close()
  }
}

export async function waitForIpcReachable(ipcPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isIpcReachable(ipcPath)) return
    await sleep(100)
  }
  throw new Error(`IPC is not reachable at ${ipcPath}`)
}

export async function waitForIpcUnreachable(ipcPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await isIpcReachable(ipcPath)) return
    await sleep(100)
  }
}

export interface ServicePayload {
  text: string
  value: unknown
  hasJson: boolean
}

export function localForemanServiceOriginForConfig(config: ForemanServiceConfig): string {
  const host = config.service.host === '0.0.0.0' || config.service.host === '::'
    ? '127.0.0.1'
    : config.service.host
  return `http://${host}:${config.service.port}`
}

export function resolveConfiguredIpcPath(configPathValue: unknown): string {
  const config = loadForemanServiceConfig(resolveConfigPath(configPathValue))
  return resolveForemanServiceIpcPath({
    port: config.service.port,
    path: config.service.ipc?.path,
  })
}

export async function connectConfiguredForemanClient(configPathValue: unknown): Promise<IpcForemanClient> {
  const ipcPath = resolveConfiguredIpcPath(configPathValue)
  try {
    return await connectIpcForemanClient({ path: ipcPath, timeoutMs: 2_000 })
  } catch (error) {
    const details = error instanceof Error && error.message ? ` ${error.message}` : ''
    throw new Error(`Wrenyard daemon IPC is not reachable at ${ipcPath}.${details} Start the Wrenyard daemon with 'wrenyard daemon start' and retry.`)
  }
}

export function writeServicePayload(payload: ServicePayload): void {
  if (payload.hasJson) {
    console.log(JSON.stringify(payload.value, null, 2))
    return
  }
  writeText(payload.text)
}

export function servicePayload(value: unknown): ServicePayload {
  return {
    text: '',
    value,
    hasJson: true,
  }
}

export function taskListRows(value: unknown): JsonRecord[] {
  const rows = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord).tasks
    : value
  return Array.isArray(rows)
    ? rows.filter((row): row is JsonRecord => row !== null && typeof row === 'object' && !Array.isArray(row))
    : []
}

export function taskRunIdFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const taskRunId = (value as JsonRecord).task_run_id
  return typeof taskRunId === 'string' && taskRunId.trim() ? taskRunId : null
}

export async function waitForTaskCompletionViaIpc(client: IpcForemanClient, taskRunId: string): Promise<unknown> {
  while (true) {
    const status = await client.task.run.status({ task_run_id: taskRunId })
    if (status && typeof status === 'object' && !Array.isArray(status)) {
      const runStatus = (status as unknown as JsonRecord).status
      if (typeof runStatus === 'string' && TASK_TERMINAL_STATUSES.has(runStatus)) return status
    }
    await sleep(TASK_IPC_POLL_INTERVAL_MS)
  }
}

export function taskFinalStatusPayload(taskRunId: string, status: ServicePayload): ServicePayload {
  if (!status.hasJson || !status.value || typeof status.value !== 'object' || Array.isArray(status.value)) return status
  const value = status.value as JsonRecord
  const hasOutput = value.has_output === true
  return {
    text: '',
    hasJson: true,
    value: {
      ...value,
      ...(hasOutput ? { hint: `Task finished. Use wrenyard task output ${taskRunId} to get the result.` } : {}),
    },
  }
}

export function isTaskRunSuccess(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  return (value as JsonRecord).status === 'done'
}

export function isTaskRunRejectionPayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonRecord).error_type === 'string')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function parseTaskJsonInput(raw: string): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid <json-input>: ${errorMessage(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('<json-input> must be a JSON object')
  }
  return value as JsonRecord
}

/** Parse task input without imposing an object shape. The task's own Zod
 * schema is the authority, so builtin tasks may legitimately accept arrays. */
export function parseJsonInput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid <json-input>: ${errorMessage(error)}`)
  }
}

export async function printTaskInputRequiredHint(taskId: string, project: string, configPathValue: unknown): Promise<void> {
  let client: IpcForemanClient | undefined
  try {
    client = await connectConfiguredForemanClient(configPathValue)
    const task = await client.task.definition.describe({ task_id: taskId, project }) as unknown as JsonRecord
    console.error('JSON input is required. Example:')
    console.error(JSON.stringify(task.input_example ?? {}, null, 2))
    if (task.input_schema !== undefined) {
      console.error('Schema:')
      console.error(JSON.stringify(task.input_schema, null, 2))
    }
  } catch {
    return
  } finally {
    client?.close()
  }
}

export function writeText(text: string): void {
  if (!text) return
  process.stdout.write(text)
  if (!text.endsWith('\n')) process.stdout.write('\n')
}

export function field(row: JsonRecord, names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

export function padCell(value: string, width: number): string {
  return value.slice(0, width).padEnd(width)
}

export function commaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

// ── runtime helpers ──

export function isHelpRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h')
}

export function workspaceRootForRuntime(): string {
  const workspace = process.env.WRENYARD_WORKSPACE?.trim() || process.env.FOREMAN_WORKSPACE?.trim()
  return workspace ? resolve(workspace) : resolveWorkDir()
}

export function loadConfig(configPathValue?: unknown): ForemanConfig {
  const data = loadForemanConfigData(resolveConfigPath(configPathValue))
  const msgDelivery = data.message?.delivery
  return {
    messageDelivery: {
      enabled: typeof msgDelivery?.enabled === 'boolean' ? msgDelivery.enabled : true,
    },
  }
}

export function readLocalPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(foremanDir, 'package.json'), 'utf-8')) as { version?: unknown }
  return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : '0.0.0'
}

export function resolveConfigPath(value: unknown): string {
  return configResolveForemanConfigPath(value)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ProtocolError) {
    const paths = protocolValidationPaths(error.data)
    return paths.length > 0 ? `${error.message}: ${paths.join('; ')}` : error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Extract structured AJV validation paths from a ProtocolError's data.details
 * array. Only arrays of non-empty strings are admitted so generic errors never
 * dump arbitrary objects or secrets into CLI stderr.
 */
function protocolValidationPaths(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const details = (data as { details?: unknown }).details
  if (!Array.isArray(details)) return []
  const paths: string[] = []
  for (const entry of details) {
    if (typeof entry === 'string' && entry.trim()) paths.push(entry.trim())
  }
  return paths
}
