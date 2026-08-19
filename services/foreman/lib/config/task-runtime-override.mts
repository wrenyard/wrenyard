import { AgentRuntimeParseError, parseAgentRuntime } from '../core/agent-runtime.mts'
import { ForemanConfigManager } from './manager.mts'

/**
 * Read `tasks.agentRuntime` from the live Wrenyard config. Missing or empty
 * maps are a no-op; invalid values fail loudly so a typo cannot silently
 * dispatch the packaged policy.
 */
export function readTaskAgentRuntimeOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const { data } = new ForemanConfigManager({ env }).loadData()
  return normalizeTaskAgentRuntimeOverrides(data.tasks?.agentRuntime)
}

export function applyTaskAgentRuntimeOverride(
  taskName: string,
  declared: string,
  overrides?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const map = overrides ?? readTaskAgentRuntimeOverrides(env)
  return map[taskName] ?? declared
}

export function normalizeTaskAgentRuntimeOverrides(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('tasks.agentRuntime must be an object of task id to agentRuntime string')
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const taskId = name.trim()
    if (!taskId) {
      throw new Error('tasks.agentRuntime keys must be non-empty task ids')
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`tasks.agentRuntime.${taskId} must be a non-empty agentRuntime string`)
    }
    try {
      out[taskId] = parseAgentRuntime(value).toString()
    } catch (error) {
      const message = error instanceof AgentRuntimeParseError ? error.message : String(error)
      throw new Error(`Invalid tasks.agentRuntime.${taskId}: ${message}`)
    }
  }
  return out
}
