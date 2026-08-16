export type ConfigRecord = Record<string, unknown>

export type ServiceConfigData = ConfigRecord & {
  enabled?: boolean
  bind?: string
  public_url?: string
  ipc?: { path?: string }
}

export type WorkspaceConfigData = ConfigRecord & {
  root?: string
}

export type PetConfigData = ConfigRecord & {
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  startup_timeout_ms?: number
  stop_timeout_ms?: number
  restart_on_exit?: boolean
  restart_delay_ms?: number
}

export type MessageConfigData = ConfigRecord & {
  enabled?: boolean
  principals?: Record<string, ConfigRecord>
  routes?: Record<string, ConfigRecord>
  delivery?: {
    enabled?: boolean
    default?: string[]
    methods?: Record<string, { backend?: string }>
  }
}

export type FwaConfigData = ConfigRecord & {
  workspace_root?: string
  llm?: {
    model?: string
    turn_timeout_ms?: number
    http_timeout_ms?: number
    max_retries?: number
    retry_backoff_ms?: number
  }
}

export type WorkConfigData = FwaConfigData

export type ForemanConfigData = {
  service?: ServiceConfigData
  workspace?: WorkspaceConfigData
  fwa?: FwaConfigData
  work?: WorkConfigData
  pet?: PetConfigData
  message?: MessageConfigData
}

export function createDefaultForemanConfigData(
  options?: { env?: NodeJS.ProcessEnv },
): ForemanConfigData {
  const env = options?.env ?? process.env
  return {
    service: {
      enabled: true,
      bind: '127.0.0.1:8787',
    },
    workspace: {
      root: env.WRENYARD_WORKSPACE ?? env.FOREMAN_WORKSPACE,
    },
    pet: {
      // command/args are intentionally chosen later by normalizePetConfig so a
      // release with a packaged Pet is not overwritten; source checkouts still
      // default to npm start and explicit user command/args still win.
      enabled: false,
      startup_timeout_ms: 10_000,
      stop_timeout_ms: 5_000,
      restart_on_exit: true,
      restart_delay_ms: 1_000,
    },
    message: {
      enabled: true,
      principals: {
        codex: {
          kind: 'agent',
          can_send: true,
          can_receive: false,
          grants: [{ name: 'message.send' }, { name: 'work.read' }],
        },
      },
      delivery: {
        enabled: true,
        default: ['local.system'],
        methods: {
          'local.system': { backend: 'system' },
        },
      },
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
