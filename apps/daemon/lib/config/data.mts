import type { TaskSettingsLayer } from './task-settings.mts'

export type ConfigRecord = Record<string, unknown>

export type ServiceConfigData = ConfigRecord & {
  enabled?: boolean
  ipc?: { path?: string }
}

export type WorkspaceConfigData = ConfigRecord & {
  root?: string
}

/** Persisted task settings layer. Mirrors the canonical TaskSettingsLayer while
 *  staying open to unknown/forward-compatible keys. */
export type TaskSettingsLayerData = ConfigRecord & TaskSettingsLayer

export type TaskSettingsData = ConfigRecord & {
  /** Global (non-task-specific) user settings, applied ahead of per-task entries. */
  global?: TaskSettingsLayerData
  /** Per-task settings keyed by stable definition identity (builtin:<name> or
   *  project:<project>:<name>). */
  byTask?: Record<string, TaskSettingsLayerData>
}

export type TasksConfigData = ConfigRecord & {
  /** Layered task settings resolved in order: system defaults -> builtin Task
   *  defaults -> user global -> user task -> invocation. */
  settings?: TaskSettingsData
}

export type ForemanConfigData = {
  service?: ServiceConfigData
  workspace?: WorkspaceConfigData
  tasks?: TasksConfigData
}

export function createDefaultForemanConfigData(
  options?: { env?: NodeJS.ProcessEnv },
): ForemanConfigData {
  const env = options?.env ?? process.env
  return {
    service: {
      enabled: true,
    },
    workspace: {
      root: env.WRENYARD_WORKSPACE ?? env.FOREMAN_WORKSPACE,
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeConfigValue(defaultValue: unknown, overlayValue: unknown): unknown {
  if (overlayValue === undefined) return defaultValue
  if (isObject(defaultValue) && isObject(overlayValue)) {
    const merged: ConfigRecord = {}
    for (const key of new Set([...Object.keys(defaultValue), ...Object.keys(overlayValue)])) {
      const value = mergeConfigValue(defaultValue[key], overlayValue[key])
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
  return overlayValue
}

export function mergeForemanConfigData(
  defaults: ForemanConfigData,
  overlay: ForemanConfigData,
): ForemanConfigData {
  const result = mergeConfigValue(defaults, overlay) as ForemanConfigData
  return result
}
