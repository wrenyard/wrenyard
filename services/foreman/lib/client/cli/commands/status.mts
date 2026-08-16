
import { request as httpRequest } from 'node:http'
import { parseArgs } from 'node:util'
import { connectIpcForemanClient } from '../../ipc-foreman-client.mts'
import { requireNoPositionals } from '../helpers.mts'
import {
  type ForemanStatus,
  type IpcForemanClient,
  type JsonRecord,
  type StatusCheck,
  errorMessage,
  isHelpRequest,
  loadServiceConfigForCli,
  localForemanServiceOriginForConfig,
} from '../shared.mts'
import { resolveForemanServiceIpcPath } from '../../../transport/ipc-server.mts'
import { readDaemonSupervisorStatus } from '../daemon-supervisor.mts'

export async function handleStatus(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard status [--config path] [--json]')
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
  requireNoPositionals(positionals, 'wrenyard status [--config path] [--json]')

  const status = await collectForemanStatus(values.config)
  if (values.json) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    printForemanStatus(status)
  }

  if (!status.ok) {
    if (!status.ipc.ok) console.error(`Wrenyard daemon IPC is not reachable at ${status.ipc.path}.`)
    console.error(`Wrenyard daemon is not healthy.`)
    console.error("Start the Wrenyard daemon with 'wrenyard daemon start' and retry.")
    return 1
  }
  return 0
}

export async function collectForemanStatus(configPathValue: unknown): Promise<ForemanStatus> {
  const { config, resolvedConfigPath } = loadServiceConfigForCli(configPathValue)
  const ipcPath = resolveForemanServiceIpcPath({
    port: config.service.port,
    path: config.service.ipc?.path,
  })
  const supervisor = await readDaemonSupervisorStatus({ config, resolvedConfigPath })
  const ipc = await checkIpcStatus(ipcPath)
  const origin = localForemanServiceOriginForConfig(config)
  const http = await checkHttpJson(`${origin}/health`)
  const mcp = await checkHttpReachable(`${origin}/mcp`, [405])
  const db = await checkIpcStats(ipcPath)
  const health = ipcHealthPayload(ipc)
  const daemonStatus = await checkDaemonStatus(ipcPath)
  const daemonStatusPayload = (daemonStatus as StatusCheck & { payload?: unknown }).payload
  const result: ForemanStatus = {
    ok: ipc.ok && http.ok && mcp.ok && db.ok,
    ...(typeof health.uptimeMs === 'number' ? { uptimeMs: health.uptimeMs } : {}),
    config: {
      ok: true,
      path: resolvedConfigPath,
    },
    daemon: {
      running: supervisor.running || ipc.ok,
      process: supervisor.process,
      status: supervisor.status,
      ...(supervisor.pid ? { pid: supervisor.pid } : {}),
      pidAlive: supervisor.pidAlive,
      statePath: supervisor.statePath,
      pidPath: supervisor.pidPath,
      ...(supervisor.state?.suiteRoot ? { suiteRoot: supervisor.state.suiteRoot } : {}),
      ...(supervisor.state?.suiteVersion ? { suiteVersion: supervisor.state.suiteVersion } : {}),
      logPaths: supervisor.logPaths,
    },
    ipc,
    http,
    mcp,
    db,
    ...(daemonStatus.ok ? daemonStatusProjection(daemonStatusPayload) : {}),
  }
  return result
}

export function daemonStatusProjection(payload: unknown): Partial<ForemanStatus> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const value = payload as Record<string, unknown>
  const mode = value.mode
  if (typeof mode !== 'string' || !['accepting', 'frozen', 'planned_restart'].includes(mode)) {
    return {}
  }
  const projection: Partial<ForemanStatus> = {
    mode: mode as ForemanStatus['mode'],
    active_task_count: typeof value.active_task_count === 'number' ? value.active_task_count : 0,
    active_workflow_count: typeof value.active_workflow_count === 'number' ? value.active_workflow_count : 0,
    active_execution_count: typeof value.active_execution_count === 'number' ? value.active_execution_count : 0,
    recovery_required: Boolean(value.recovery_required),
  }
  if (typeof value.operation_id === 'string') projection.operation_id = value.operation_id
  if (value.kind === 'update' || value.kind === 'restart') projection.kind = value.kind
  if (typeof value.phase === 'string') projection.phase = value.phase as ForemanStatus['phase']
  return projection
}

export function ipcHealthPayload(check: StatusCheck): { uptimeMs?: number } {
  const payload = (check as StatusCheck & { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') return {}
  const uptimeMs = (payload as { uptimeMs?: unknown }).uptimeMs
  return typeof uptimeMs === 'number' ? { uptimeMs } : {}
}

export async function checkIpcStatus(ipcPath: string): Promise<StatusCheck> {
  let client: IpcForemanClient | undefined
  try {
    client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
    const payload = await client.health.ping()
    return { ok: true, path: ipcPath, status: 'ok', payload }
  } catch (error) {
    return { ok: false, path: ipcPath, error: errorMessage(error) }
  } finally {
    client?.close()
  }
}

export async function checkIpcStats(ipcPath: string): Promise<StatusCheck> {
  let client: IpcForemanClient | undefined
  try {
    client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
    const payload = await client.stats.today()
    return { ok: true, path: ipcPath, status: 'ok', payload }
  } catch (error) {
    return { ok: false, path: ipcPath, error: errorMessage(error) }
  } finally {
    client?.close()
  }
}

export async function checkDaemonStatus(ipcPath: string): Promise<StatusCheck> {
  let client: IpcForemanClient | undefined
  try {
    client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
    const payload = await client.daemon.status()
    return { ok: true, path: ipcPath, status: 'ok', payload }
  } catch (error) {
    return { ok: false, path: ipcPath, error: errorMessage(error) }
  } finally {
    client?.close()
  }
}

export async function checkHttpJson(url: string): Promise<StatusCheck> {
  try {
    const response = await httpRequestText(url, 1_000)
    const status = response.statusCode ?? 0
    const parsed = response.text ? JSON.parse(response.text) as JsonRecord : {}
    const ok = status >= 200 && status < 300
    const error = ok ? undefined : jsonErrorMessage(parsed) ?? `HTTP ${status}`
    return { ok, url, status, ...(error ? { error } : {}) }
  } catch (error) {
    return { ok: false, url, error: errorMessage(error) }
  }
}

export async function checkHttpReachable(url: string, okStatuses: number[]): Promise<StatusCheck> {
  try {
    const response = await httpRequestText(url, 1_000)
    const status = response.statusCode ?? 0
    const ok = (status >= 200 && status < 300) || okStatuses.includes(status)
    return { ok, url, status, ...(ok ? {} : { error: `HTTP ${status}` }) }
  } catch (error) {
    return { ok: false, url, error: errorMessage(error) }
  }
}

export function jsonErrorMessage(value: JsonRecord): string | undefined {
  if (typeof value.message === 'string') return value.message
  if (typeof value.error === 'string') return value.error
  return undefined
}

export function httpRequestText(url: string, timeoutMs: number): Promise<{ statusCode?: number; text: string }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolveRequest({
          statusCode: response.statusCode,
          text: Buffer.concat(chunks).toString('utf-8'),
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`))
    })
    request.on('error', reject)
    request.end()
  })
}

export function printForemanStatus(status: ForemanStatus): void {
  console.log('Wrenyard status')
  console.log(`  daemon: ${status.daemon.running ? 'running' : 'not running'}${status.daemon.pid ? ` (pid ${status.daemon.pid})` : ''}`)
  console.log(`  state:  ${status.daemon.status ?? 'unknown'}${status.daemon.pidAlive === false ? ' (pid not alive)' : ''}`)
  if (status.daemon.logPaths?.stderr) console.log(`  logs:   ${status.daemon.logPaths.stderr}`)
  if (status.mode) {
    console.log(`  admission: ${status.mode}`)
    if (status.operation_id !== undefined) {
      console.log(`  plan:   ${status.operation_id}${status.kind ? ` (${status.kind})` : ''}${status.phase ? ` ${status.phase}` : ''}`)
      console.log(`  active tasks: ${status.active_task_count ?? 0}`)
      console.log(`  active workflows: ${status.active_workflow_count ?? 0}`)
      console.log(`  active executions: ${status.active_execution_count ?? 0}`)
      console.log(`  recovery required: ${status.recovery_required ? 'yes' : 'no'}`)
    }
  }
  console.log(`  ipc:    ${formatStatusCheck(status.ipc)}`)
  console.log(`  http:   ${formatStatusCheck(status.http)}`)
  console.log(`  mcp:    ${formatStatusCheck(status.mcp)}`)
  console.log(`  db:     ${formatStatusCheck(status.db)}`)
}

export function formatStatusCheck(check: StatusCheck): string {
  if (check.ok) return check.status ? `ok (${check.status})` : 'ok'
  return `failed${check.error ? ` (${check.error})` : ''}`
}
