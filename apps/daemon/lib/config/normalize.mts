import { isAbsolute, resolve } from 'node:path'
import type { ConfigRecord, ForemanServiceConfig } from './types.mts'

export interface NormalizeForemanConfigOptions {
  configDir: string
  env?: NodeJS.ProcessEnv
}

export function normalizeForemanServiceConfig(
  config: ConfigRecord,
  options: NormalizeForemanConfigOptions,
): ForemanServiceConfig {
  const env = options.env ?? process.env
  const service = record(config.service)
  const serviceIpc = normalizeServiceIpcConfig(record(service.ipc))
  if (config.daily_session !== undefined) {
    throw new Error('daily_session has been removed; configure workspace.root')
  }
  const workspace = record(config.workspace)
  const workspaceRoot = resolveWorkspaceRoot(workspace.root, options.configDir, env)

  // Legacy delivery/principal/grants/message fields are ignored on purpose so an
  // existing config keeps loading after the message subsystem was removed.
  return {
    service: {
      enabled: booleanValue(service.enabled, true),
      ...(serviceIpc ? { ipc: serviceIpc } : {}),
    },
    workspaceRoot,
  }
}

function normalizeServiceIpcConfig(raw: ConfigRecord): ForemanServiceConfig['service']['ipc'] | undefined {
  const path = stringValue(raw.path, '')
  return path ? { path } : undefined
}

function resolveWorkspaceRoot(value: unknown, configDir: string, env: NodeJS.ProcessEnv): string {
  const configured = stringValue(value, '')
  if (configured) return resolveConfigRelativePath(configured, configDir)

  const envWorkspace = env.WRENYARD_WORKSPACE?.trim() || env.FOREMAN_WORKSPACE?.trim()
  if (envWorkspace) return resolve(envWorkspace)

  return configDir
}

function resolveConfigRelativePath(value: string, configDir: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(configDir, value)
}

function record(value: unknown): ConfigRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ConfigRecord : {}
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
