import { isAbsolute, resolve } from 'node:path'
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models'
import type { ConfigRecord, ForemanAuxiliaryModelConfig, ForemanEndpointConfig, ForemanGatewayConfig, ForemanModelsConfig, ForemanServiceConfig, GatewayPortMode } from './types.mts'

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

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
  const gateway = normalizeForemanGatewayConfig(config.gateway)
  const endpoint = normalizeForemanEndpointConfig(config.endpoint)
  const models = normalizeForemanModelsConfig(config.models)

  // Legacy delivery/principal/grants/message fields are ignored on purpose so an
  // existing config keeps loading after the message subsystem was removed.
  return {
    service: {
      enabled: booleanValue(service.enabled, true),
      ...(serviceIpc ? { ipc: serviceIpc } : {}),
    },
    gateway,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(models === undefined ? {} : { models }),
    workspaceRoot,
  }
}

/**
 * Normalize the optional standard endpoint. Both fields are required for a
 * usable connection; an incomplete or malformed entry reads back as absent so
 * startup keeps the built-in gateway connection.
 */
export function normalizeForemanEndpointConfig(value: unknown): ForemanEndpointConfig | undefined {
  const raw = record(value)
  const url = stringValue(raw.url, '')
  const token = stringValue(raw.token, '')
  if (!url || !token) return undefined
  return { url, token }
}

/**
 * Normalize the optional auxiliary model beside the endpoint. A missing model
 * id or an unknown reasoning level reads back as absent, so an incomplete entry
 * never becomes a callable route.
 */
export function normalizeForemanModelsConfig(value: unknown): ForemanModelsConfig | undefined {
  const auxiliary = normalizeAuxiliaryModelConfig(record(value).auxiliary)
  return auxiliary === undefined ? undefined : { auxiliary }
}

function normalizeAuxiliaryModelConfig(value: unknown): ForemanAuxiliaryModelConfig | undefined {
  const raw = record(value)
  const model = stringValue(raw.model, '')
  const reasoningEffort = raw.reasoningEffort
  if (!model || !isReasoningEffort(reasoningEffort)) return undefined
  return { model, reasoningEffort }
}

/**
 * Normalize the persisted top-level gateway settings. Absent settings default to
 * `random` mode; a valid fixed port and token are preserved. An explicitly
 * saved `fixed` mode stays fixed even if its port is unusable; startup rejects
 * that configuration rather than silently choosing a random port.
 */
export function normalizeForemanGatewayConfig(value: unknown): ForemanGatewayConfig {
  const raw = record(value)
  const port = normalizeGatewayPort(raw.port)
  const token = stringValue(raw.token, '')
  const portMode: GatewayPortMode = raw.portMode === 'fixed' ? 'fixed' : 'random'
  return {
    portMode,
    ...(port !== undefined ? { port } : {}),
    ...(token ? { token } : {}),
  }
}

function normalizeGatewayPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return undefined
  return value
}

function normalizeServiceIpcConfig(raw: ConfigRecord): ForemanServiceConfig['service']['ipc'] | undefined {
  const path = stringValue(raw.path, '')
  return path ? { path } : undefined
}

function resolveWorkspaceRoot(value: unknown, configDir: string, env: NodeJS.ProcessEnv): string {
  const configured = stringValue(value, '')
  if (configured) return resolveConfigRelativePath(configured, configDir)

  const envWorkspace = env.WRENYARD_WORKSPACE?.trim()
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
