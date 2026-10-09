
import { parseArgs } from 'node:util'
import { connectIpcForemanClient } from '@wrenyard/daemon/control/ipc-client'
import { requireNoPositionals } from '../helpers.mts'
import {
  type ForemanStatus,
  type IpcForemanClient,
  type StatusCheck,
  errorMessage,
  isHelpRequest,
  loadServiceConfigForCli,
} from '../shared.mts'
import { resolveWrenyardIpcPath } from '@wrenyard/control'
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
    console.error('Wrenyard daemon 未运行。请打开啾啾工坊，或在终端运行 `wrenyard daemon run`。')
    return 1
  }
  return 0
}

export async function collectForemanStatus(configPathValue: unknown): Promise<ForemanStatus> {
  const { config, resolvedConfigPath } = loadServiceConfigForCli(configPathValue)
  const ipcPath = resolveWrenyardIpcPath(process.env, { config })
  const supervisor = await readDaemonSupervisorStatus({ config, resolvedConfigPath })
  const ipc = await checkIpcStatus(ipcPath)
  const health = ipcHealthPayload(ipc)
  const daemonStatus = await checkDaemonStatus(ipcPath)
  const daemonStatusPayload = (daemonStatus as StatusCheck & { payload?: unknown }).payload
  const result: ForemanStatus = {
    ok: ipc.ok,
    ...(typeof health.uptimeMs === 'number' ? { uptimeMs: health.uptimeMs } : {}),
    config: {
      ok: true,
      path: resolvedConfigPath,
    },
    daemon: {
      running: supervisor.running,
      status: supervisor.status,
      ...(supervisor.pid !== undefined ? { pid: supervisor.pid } : {}),
      ...(supervisor.startedAt !== undefined ? { startedAt: supervisor.startedAt } : {}),
      ...(supervisor.mode !== undefined ? { mode: supervisor.mode } : {}),
    },
    ipc,
    ...(daemonStatus.ok ? daemonStatusProjection(daemonStatusPayload) : {}),
  }
  return result
}

export function daemonStatusProjection(payload: unknown): Partial<ForemanStatus> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const value = payload as Record<string, unknown>
  const counts = [value.activeTaskCount, value.activeWorkflowCount, value.activeExecutionCount]
  // Fail closed: a status missing the lifecycle contract never fabricates an
  // accepting admission or a zero active count.
  if (value.ok !== true
    || typeof value.shutting_down !== 'boolean'
    || typeof value.idle !== 'boolean'
    || counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) {
    return {}
  }
  return {
    shutting_down: value.shutting_down,
    idle: value.idle,
    active_task_count: value.activeTaskCount as number,
    active_workflow_count: value.activeWorkflowCount as number,
    active_execution_count: value.activeExecutionCount as number,
  }
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

export function printForemanStatus(status: ForemanStatus): void {
  console.log('Wrenyard status')
  console.log(`  daemon: ${status.daemon.running ? 'running' : 'not running'}${status.daemon.pid ? ` (pid ${status.daemon.pid})` : ''}`)
  if (status.daemon.mode) console.log(`  mode:   ${status.daemon.mode}`)
  if (status.daemon.startedAt) console.log(`  since:  ${status.daemon.startedAt}`)
  if (status.shutting_down !== undefined) {
    console.log(`  admission: ${status.shutting_down ? 'shutting down' : 'accepting'}`)
    console.log(`  active tasks: ${status.active_task_count ?? 0}`)
    console.log(`  active workflows: ${status.active_workflow_count ?? 0}`)
    console.log(`  active executions: ${status.active_execution_count ?? 0}`)
  }
  console.log(`  ipc:    ${formatStatusCheck(status.ipc)}`)
}

export function formatStatusCheck(check: StatusCheck): string {
  if (check.ok) return check.status ? `ok (${check.status})` : 'ok'
  return `failed${check.error ? ` (${check.error})` : ''}`
}
