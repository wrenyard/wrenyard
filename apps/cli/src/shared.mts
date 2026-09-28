
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foremanPackageRoot, readSuiteVersion, resolveWrenyardSuiteRoot } from '@wrenyard/daemon/layout/suite-root'
import { foremanStateRoot } from '@wrenyard/daemon/config/state'
import { connectIpcForemanClient } from '@wrenyard/daemon/control/ipc-client'
import { resolveForemanServiceIpcPath } from '@wrenyard/daemon/control/ipc-server'
import { ProtocolError } from '@wrenyard/daemon/protocol/errors'
import { protocolVersionMismatchMessage, WRENYARD_PROTOCOL_VERSION } from '@wrenyard/control-client/transport'
import { loadForemanServiceConfig, loadForemanConfigData, resolveDefaultForemanConfigPath, resolveForemanConfigPath as configResolveForemanConfigPath, type ForemanServiceConfig } from '@wrenyard/daemon/config'
import { readSourceDevLock } from './source-dev-lock.mts'

/** Daemon package root (owns task/execution lifecycle and the product IPC server). */
export const foremanDir = foremanPackageRoot
/** CLI package root, derived from this module's location (src/ one level up). */
export const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const suiteDir = resolveWrenyardSuiteRoot({ packageRoot: foremanDir })
export const configPath = resolveDefaultForemanConfigPath()
export const whichCmd = process.platform === 'win32' ? 'where' : 'which'

export type JsonRecord = Record<string, unknown>

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
    status?: string
    pid?: number
    startedAt?: string
    mode?: 'source' | 'installed'
  }
  ipc: StatusCheck
  // Daemon lifecycle projection. Present only when daemon.status is reachable;
  // omitted on lookup failure so we never fabricate an accepting admission or
  // zero active counts.
  shutting_down?: boolean
  idle?: boolean
  active_task_count?: number
  active_workflow_count?: number
  active_execution_count?: number
}

export function applyServiceCliOverrides(config: ForemanServiceConfig, values: Record<string, unknown>): void {
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

export function resolveConfiguredIpcPath(configPathValue: unknown): string {
  const config = loadForemanServiceConfig(resolveConfigPath(configPathValue))
  return resolveForemanServiceIpcPath({ path: config.service.ipc?.path })
}

/**
 * The daemon handshake rejects a version mismatch with the canonical mismatch
 * message as an ordinary Error, so the only stable marker is its text. Derive
 * the fixed prefix from the canonical builder so a formatting change can never
 * silently downgrade an actionable mismatch into the generic unreachable hint.
 */
const PROTOCOL_MISMATCH_PREFIX = (() => {
  const marker = protocolVersionMismatchMessage(WRENYARD_PROTOCOL_VERSION, '')
  const daemonAt = marker.lastIndexOf('daemon ')
  return marker.slice(0, daemonAt + 'daemon '.length)
})()

function isProtocolMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(PROTOCOL_MISMATCH_PREFIX)
}

export async function connectConfiguredForemanClient(configPathValue: unknown): Promise<IpcForemanClient> {
  const ipcPath = resolveConfiguredIpcPath(configPathValue)
  try {
    return await connectIpcForemanClient({ path: ipcPath, timeoutMs: 2_000 })
  } catch (error) {
    // A protocol version mismatch is actionable on its own and must reach the
    // operator verbatim; never replace it with the "daemon not running" hint.
    if (isProtocolMismatch(error)) throw error
    // A live `pnpm dev:desktop` restarts the daemon after every source change, so an
    // unreachable IPC during dev is expected churn, not a missing daemon.
    const devLock = readSourceDevLock()
    if (devLock) {
      const daemonLog = join(foremanStateRoot(), 'dev', 'logs', 'daemon.log')
      throw new Error(`Wrenyard daemon IPC is not reachable at ${ipcPath}. pnpm dev:desktop (pid ${devLock.pid}) is probably restarting it after a source change; retry in a few seconds. If it stays down, the new source failed to start: check the pnpm dev:desktop terminal and ${daemonLog}, then fix the source directly.`)
    }
    const details = error instanceof Error && error.message ? ` ${error.message}` : ''
    throw new Error(`Wrenyard daemon IPC is not reachable at ${ipcPath}.${details} Wrenyard daemon 未运行。请打开啾啾工坊，或在终端运行 \`wrenyard daemon run\`。`)
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

/** Validate that the config file loads; the daemon owns the config schema. */
export function loadConfig(configPathValue?: unknown): void {
  loadForemanConfigData(resolveConfigPath(configPathValue))
}

export function readLocalPackageVersion(): string {
  // The daemon package version is a constant 0.0.0; the suite version (from
  // SUITE_VERSION or the suite package.json) is the only meaningful identity.
  return readSuiteVersion(suiteDir)
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
