import { AgentRuntimeParseError, parseAgentRuntime } from '../core/agent-runtime.mts'
import { ForemanConfigManager } from './manager.mts'

/**
 * Daemon-wide authoritative config binding. When a daemon starts with an
 * explicit `--config` path, task list/describe/execution preference reads must
 * target that exact file instead of silently reading the default config. Only
 * one binding may be active at a time; repeated binds of the *same* path are
 * reference-counted so nested daemon lifecycles release cleanly, while a second
 * daemon with a different authoritative path fails loudly.
 */
let activeBinding: { configPath: string; refs: number } | undefined

export function bindTaskRuntimeOverrideConfigPath(configPath: string): () => void {
  if (activeBinding) {
    if (activeBinding.configPath !== configPath) {
      throw new Error(
        `task runtime override config binding is already active for ${activeBinding.configPath}; cannot bind ${configPath}`,
      )
    }
    activeBinding.refs += 1
  } else {
    activeBinding = { configPath, refs: 1 }
  }
  return () => {
    if (!activeBinding || activeBinding.configPath !== configPath) return
    activeBinding.refs -= 1
    if (activeBinding.refs <= 0) activeBinding = undefined
  }
}

/** Test/shutdown hook that clears any daemon-wide override binding. */
export function resetTaskRuntimeOverrideConfigPathBinding(): void {
  activeBinding = undefined
}

function boundConfigPath(): string | undefined {
  return activeBinding?.configPath
}

/**
 * Read `tasks.agentRuntime` from the live Wrenyard config. Missing or empty
 * maps are a no-op; invalid values fail loudly so a typo cannot silently
 * dispatch the packaged policy.
 */
export function readTaskAgentRuntimeOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const manager = new ForemanConfigManager({ env })
  const authoritativeConfigPath = boundConfigPath()
  // Bound daemon: read override preferences from the daemon's authoritative
  // config file. Non-daemon callers keep the default resolution behavior.
  const { data } = authoritativeConfigPath
    ? manager.loadData(authoritativeConfigPath)
    : manager.loadData()
  return normalizeTaskAgentRuntimeOverrides(data.tasks?.agentRuntime)
}

/**
 * The ONLY execution override seam. Returns the machine-configured runtime
 * override for a task as a *preference* only. Unlike `applyTaskAgentRuntimeOverride`,
 * this does NOT fall back to the task's declared runtime and does NOT authorize any
 * profile: it is purely the operator's soft preference for the daemon-side dispatch
 * resolver to honor when it does not conflict with a task's hard `dispatch`
 * requirements. A task's exact declared `agentRuntime` (and any dispatch
 * requirements) always win; this preference can never replace or relax them.
 * Returns `undefined` when no machine override is configured for the task.
 */
export function taskRuntimeOverridePreference(
  taskName: string,
  overrides?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const map = overrides ?? readTaskAgentRuntimeOverrides(env)
  const value = map[taskName]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * @deprecated Execution must NOT use this to replace a task's exact declared
 * runtime. It is retained ONLY for `list`/`describe` backward-compatible display
 * (showing the operator's soft override preference when present). The daemon
 * dispatch resolver treats any returned value as a soft preference that can never
 * bypass a task's hard `dispatch` requirements or replace the exact declared
 * `agentRuntime`. Parser compatibility is preserved via
 * `normalizeTaskAgentRuntimeOverrides`.
 */
export function applyTaskAgentRuntimeOverride(
  taskName: string,
  declared: string,
  overrides?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const map = overrides ?? readTaskAgentRuntimeOverrides(env)
  // Returns the override when present, otherwise the declared runtime. This
  // value is a *preference* for list/describe display and never bypasses a
  // task's hard dispatch requirements — the daemon resolver treats it as a
  // soft preference only.
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
