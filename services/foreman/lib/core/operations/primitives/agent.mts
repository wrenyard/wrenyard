import { resolve } from 'node:path'
import type {
  AgentExecutionHost,
  ClientFamily,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
} from '../types.mts'
import type { PermissionMode } from '../../../types.mts'
import type { AgentRuntimePermission } from './types.mts'

export type AgentStatus = 'done' | 'failed' | 'cancelled'

export interface AgentOpts {
  cwd?: string
  workingDirectory?: string
  timeoutMs?: number
  permission?: PermissionMode
  resume?: string
  taskId?: string
  clientFamily?: ClientFamily
  capabilities?: readonly string[]
  writePaths?: readonly string[]
}

export interface AgentResult {
  output: string
  status: AgentStatus
  executionId?: string
  executionStatus?: ExecutionStatus
  taskId?: string
  nativeSessionId?: string
  clientFamily?: ClientFamily
  error?: string | null
  exitCode?: number | null
  killReason?: string | null
  resolvedProfile?: string
}

let agentExecutionHost: AgentExecutionHost | undefined

export function setAgentExecutionHost(host: AgentExecutionHost | undefined): void {
  agentExecutionHost = host
}

export function getAgentExecutionHost(): AgentExecutionHost {
  if (!agentExecutionHost) {
    throw new Error(
      'AgentExecutionHost has not been injected. Call setAgentExecutionHost(host) during Foreman service bootstrap before using agent().',
    )
  }
  return agentExecutionHost
}

export function setAgentExecutionSupervisor(host: AgentExecutionHost | undefined): void {
  setAgentExecutionHost(host)
}

export function getAgentExecutionSupervisor(): AgentExecutionHost {
  return getAgentExecutionHost()
}

export async function agent(profile: string, prompt: string, opts: AgentOpts = {}): Promise<AgentResult> {
  return createAgentPrimitive(getAgentExecutionHost())(profile, prompt, opts)
}

export function createAgentPrimitive(host: AgentExecutionHost): typeof agent {
  return async (profile, prompt, opts = {}) => runAgentWithHost(host, profile, prompt, opts)
}

async function runAgentWithHost(
  host: AgentExecutionHost,
  profile: string,
  prompt: string,
  opts: AgentOpts,
): Promise<AgentResult> {
  const handle = await host.startExecution({
    taskId: opts.taskId,
    profile,
    permission: normalizePermission(opts.permission),
    cwd: resolve(opts.cwd ?? opts.workingDirectory ?? process.cwd()),
    prompt,
    resume: opts.resume,
    timeoutMs: opts.timeoutMs,
    clientFamily: opts.clientFamily,
    requestedAgentRuntime: profile,
    capabilities: opts.capabilities,
    writePaths: opts.writePaths,
  })

  const result = await handle.wait()
  return toAgentResult(result, host.getExecution(result.executionId))
}

function normalizePermission(permission: AgentOpts['permission']): AgentRuntimePermission {
  switch (permission) {
    case undefined:
    case 'edit':
      return 'edit'
    case 'readonly':
      return 'readonly'
    case 'yolo':
      return 'yolo'
    default:
      throw new Error(`Unsupported agent permission '${String(permission)}'`)
  }
}

function toAgentResult(result: ExecutionResult, record: ExecutionRecord | undefined): AgentResult {
  const status = mapExecutionStatus(result.status)
  const output = result.output ?? (status === 'failed' ? result.error ?? '' : '')

  return {
    output,
    status,
    executionId: result.executionId,
    executionStatus: result.status,
    taskId: record?.task_id ?? undefined,
    nativeSessionId: record?.native_session_id ?? undefined,
    clientFamily: record?.client_family ?? undefined,
    error: result.error ?? null,
    exitCode: result.exitCode ?? null,
    killReason: result.killReason ?? null,
    resolvedProfile: record?.resolved_profile ?? undefined,
  }
}

function mapExecutionStatus(status: ExecutionStatus): AgentStatus {
  switch (status) {
    case 'done':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'timeout':
    case 'interrupted':
    default:
      return 'failed'
  }
}
