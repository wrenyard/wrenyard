import { resolve } from 'node:path'
import type {
  AgentExecutionHost,
  ClientFamily,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
} from '../types.mts'
import type { PermissionMode } from '../../../types.mts'
import type { AgentRuntimePermission, TaskDispatchSnapshot } from '../types.mts'

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
  /** Original requested agent runtime, carried separately from the exact
   *  approved execution profile chosen by the daemon dispatch resolver. */
  requestedAgentRuntime?: string
  /** Full per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: import('../types.mts').TaskDispatchSnapshot | null
  /** Canonical Forge failure class supplied by the resolver. */
  failureClass?: string | null
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
  /** Original requested agent runtime, distinct from the exact execution profile. */
  requestedAgentRuntime?: string
  /** Per-attempt dispatch snapshot produced by the daemon resolver. */
  dispatchSnapshot?: TaskDispatchSnapshot | null
  /** Canonical Forge failure class captured from `run_finished`, if present. */
  failureClass?: string | null
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
  // The exact execution profile is `profile` (resolved by the daemon dispatch
  // resolver); the original requested runtime is carried separately so it is
  // never confused with the approved plan.
  const requestedAgentRuntime = opts.requestedAgentRuntime ?? profile
  const handle = await host.startExecution({
    taskId: opts.taskId,
    profile,
    permission: normalizePermission(opts.permission),
    cwd: resolve(opts.cwd ?? opts.workingDirectory ?? process.cwd()),
    prompt,
    resume: opts.resume,
    timeoutMs: opts.timeoutMs,
    clientFamily: opts.clientFamily,
    requestedAgentRuntime,
    capabilities: opts.capabilities,
    writePaths: opts.writePaths,
    dispatchSnapshot: opts.dispatchSnapshot ?? null,
    failureClass: opts.failureClass ?? null,
  })

  const result = await handle.wait()
  const base = toAgentResult(result, host.getExecution(result.executionId))
  return {
    ...base,
    // Preserve the original requested runtime and per-attempt dispatch metadata
    // on every result, independent of the concrete resolved profile.
    requestedAgentRuntime: base.requestedAgentRuntime ?? requestedAgentRuntime,
    dispatchSnapshot: opts.dispatchSnapshot ?? null,
    failureClass: result.failureClass ?? null,
  }
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
    requestedAgentRuntime: record?.requested_agent_runtime ?? undefined,
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
