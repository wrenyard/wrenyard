import type { TaskSettingsLayer } from './task-settings.mts'
import type { GatewayPortMode } from './types.mts'

export type ConfigRecord = Record<string, unknown>

/**
 * Persisted top-level gateway settings. `portMode` defaults to `random`; a
 * `fixed` mode carries the validated TCP port the next bind must use, while
 * `token` (when present) is the persisted gateway credential. The raw on-disk
 * shape stays open to unknown/forward-compatible keys like every other layer;
 * the read and write paths both re-normalize it.
 */
export type GatewayConfigData = ConfigRecord & {
  portMode?: GatewayPortMode
  port?: number
  token?: string
}

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

/**
 * One saved remote host the daemon remembers. It carries only the SSH alias and
 * user-facing metadata; it must never hold a password, private key, passphrase,
 * token or any other secret. `platform`/`arch`/`daemonVersion` are recorded only
 * after a validated, compatible, ready remote connection.
 */
export type RemoteHostRecordData = ConfigRecord & {
  /** Concrete SSH `Host` alias from the user's SSH configuration. Never a
   *  wildcard or negated pattern. */
  alias: string
  /** User-facing display name; defaults to {@link alias} when unset. */
  displayName?: string
  /** Verified remote operating system (e.g. `darwin`, `win32`). */
  platform?: string
  /** Verified remote CPU architecture (e.g. `arm64`, `x64`). */
  arch?: string
  /** Verified remote daemon product version at save time. */
  daemonVersion?: string
}

/** The daemon-owned remote host registry: the saved connections list. */
export type RemoteHostRegistryData = ConfigRecord & {
  hosts: RemoteHostRecordData[]
}

/** Remote-connection configuration owned by the daemon config, not Desktop settings. */
export type RemoteConfigData = ConfigRecord & {
  hosts?: RemoteHostRegistryData
}

export type ForemanConfigData = {
  service?: ServiceConfigData
  gateway?: GatewayConfigData
  workspace?: WorkspaceConfigData
  tasks?: TasksConfigData
  remote?: RemoteConfigData
}

export function createDefaultForemanConfigData(
  options?: { env?: NodeJS.ProcessEnv },
): ForemanConfigData {
  const env = options?.env ?? process.env
  return {
    service: {
      enabled: true,
    },
    // The gateway defaults to an OS-assigned random loopback port. No token is
    // defaulted: the daemon generates and persists one once, then reuses it.
    gateway: {
      portMode: 'random',
    },
    workspace: {
      root: env.WRENYARD_WORKSPACE,
    },
    // The default registry is produced by the same normalizer used on every
    // read and before every write, so the default value, the read path and the
    // pre-write path are the identical `RemoteHostRegistryData` shape.
    remote: {
      hosts: normalizeRemoteHostRegistry(undefined),
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

/** Upper bound on saved remote hosts; keeps the registry bounded. */
export const MAX_REMOTE_HOSTS = 100

/**
 * Normalize any candidate registry value into a bounded, secret-free list of
 * host records. Unknown fields are dropped, so a hand-edited config can never
 * smuggle a password/private-key field into the persisted registry, and every
 * record always carries a non-empty `alias`. This is the single coercion used
 * both on read and before a write.
 */
export function normalizeRemoteHostRegistry(value: unknown): RemoteHostRegistryData {
  const raw = isObject(value) ? value.hosts : undefined
  const source = Array.isArray(raw) ? raw : []
  const hosts: RemoteHostRecordData[] = []
  const seen = new Set<string>()
  for (const entry of source) {
    if (!isObject(entry)) continue
    const alias = typeof entry.alias === 'string' ? entry.alias.trim() : ''
    if (!alias || alias.length > 255 || seen.has(alias)) continue
    seen.add(alias)
    const record: RemoteHostRecordData = { alias }
    const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : ''
    if (displayName) record.displayName = displayName.slice(0, 255)
    const platform = typeof entry.platform === 'string' ? entry.platform.trim() : ''
    if (platform) record.platform = platform.slice(0, 64)
    const arch = typeof entry.arch === 'string' ? entry.arch.trim() : ''
    if (arch) record.arch = arch.slice(0, 64)
    const daemonVersion = typeof entry.daemonVersion === 'string' ? entry.daemonVersion.trim() : ''
    if (daemonVersion) record.daemonVersion = daemonVersion.slice(0, 64)
    hosts.push(record)
    if (hosts.length >= MAX_REMOTE_HOSTS) break
  }
  return { hosts }
}
