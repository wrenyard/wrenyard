import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { MessageRouteConfig, MessageTransportKind } from '../message/types.mts'
import type { MessageDeliveryAuthConfig, MessageDeliveryRegistryConfig, PeerConfig } from '../message/delivery/types.mts'
import type { ConfigRecord, ForemanPetConfig, ForemanServiceConfig } from './types.mts'
import type { MessagePrincipal, PrincipalRegistry, PrincipalGrant } from '../message/principal.mts'
import { CANONICAL_PRINCIPALS } from '../message/principal.mts'
import { resolveWrenyardSuiteRoot } from '../layout/suite-root.mts'
import { resolvePackagedPetExecutable } from '../pet/packaged-pet.mts'
export interface NormalizeForemanConfigOptions {
  configDir: string
  env?: NodeJS.ProcessEnv
}

function normalizeFwaConfig(raw: ConfigRecord): ForemanServiceConfig['fwa'] {
  if (raw.backend !== undefined) {
    throw new Error('fwa.backend has been removed; native FWA is the only runtime')
  }
  const ws = stringValue(raw.workspace_root, '')
  if (!ws) return undefined
  const resolved = resolve(ws)
  const fwaMd = resolve(resolved, 'FWA.md')
  if (!existsSync(fwaMd)) {
    throw new Error(`fwa workspace root ${resolved} must contain FWA.md`)
  }

  const llmRaw = record(raw.llm)
  rejectStaleMaxIterations(llmRaw, 'fwa.llm')
  const model = stringValue(llmRaw.model, '')
  if (!model) {
    throw new Error('fwa.llm.model is required; expected provider/model')
  }

  return {
    workspaceRoot: resolved,
    llm: {
      model,
      turn_timeout_ms: numberValue(llmRaw.turn_timeout_ms, 300_000),
      http_timeout_ms: normalizePositiveInteger(llmRaw.http_timeout_ms, 120_000, 'fwa.llm.http_timeout_ms'),
      max_retries: normalizeNonNegativeInteger(llmRaw.max_retries, 2, 'fwa.llm.max_retries'),
      retry_backoff_ms: normalizePositiveInteger(llmRaw.retry_backoff_ms, 500, 'fwa.llm.retry_backoff_ms'),
    },
  }
}

function normalizeWorkConfig(raw: ConfigRecord): ForemanServiceConfig['work'] {
  const ws = stringValue(raw.workspace_root, '')
  if (!ws) return undefined

  const resolved = resolve(ws)
  const workMd = resolve(resolved, 'WORK.md')
  if (!existsSync(workMd)) {
    throw new Error(`work.workspace_root ${resolved} must contain WORK.md`)
  }

  const llmRaw = record(raw.llm)
  rejectStaleMaxIterations(llmRaw, 'work.llm')
  const model = stringValue(llmRaw.model, '')
  if (!model) {
    throw new Error('work.llm.model is required; expected provider/model')
  }
  const models = stringArrayValue(llmRaw.models)
  for (const entry of models) {
    if (!entry.trim()) {
      throw new Error('work.llm.models must contain non-empty model strings')
    }
  }

  return {
    workspaceRoot: resolved,
    max_concurrent_turns: normalizePositiveInteger(raw.max_concurrent_turns, 3, 'work.max_concurrent_turns'),
    llm: {
      model,
      ...(models.length > 0 ? { models } : {}),
      turn_timeout_ms: numberValue(llmRaw.turn_timeout_ms, 300_000),
      http_timeout_ms: normalizePositiveInteger(llmRaw.http_timeout_ms, 120_000, 'work.llm.http_timeout_ms'),
      max_retries: normalizeNonNegativeInteger(llmRaw.max_retries, 2, 'work.llm.max_retries'),
      retry_backoff_ms: normalizePositiveInteger(llmRaw.retry_backoff_ms, 500, 'work.llm.retry_backoff_ms'),
    },
  }
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
  const fwa = normalizeFwaConfig(record(config.fwa))
  const pet = record(config.pet)
  const message = record(config.message)
  const messageDeliveryRaw = record(message.delivery)

  const bind = stringValue(service.bind, '127.0.0.1:8787')
  const { host, port } = parseBind(bind)
  const workspaceRoot = resolveWorkspaceRoot(workspace.root, options.configDir, env)

  const workRaw = record(config.work)
  const work = normalizeWorkConfig(workRaw)
  const normalizedMessage = normalizeMessageConfig(message)
  const messageDelivery = isMessageDeliveryConfig(messageDeliveryRaw)
    ? normalizeMessageDeliveryConfig(messageDeliveryRaw)
    : undefined

  return {
    service: {
      enabled: booleanValue(service.enabled, true),
      host,
      port,
      ...(stringValue(service.public_url, '') ? { publicUrl: stringValue(service.public_url, '') } : {}),
      ...(serviceIpc ? { ipc: serviceIpc } : {}),
    },
    workspaceRoot,
    ...(fwa ? { fwa } : {}),
    ...(work ? { work } : {}),
    pet: normalizePetConfig(pet, options.configDir, env),
    message: normalizedMessage,
    ...(messageDelivery ? { messageDelivery } : {}),
  }
}

export function defaultForemanPetConfig(configDir = process.cwd(), env?: NodeJS.ProcessEnv): ForemanPetConfig {
  return normalizePetConfig({}, configDir, env)
}

export function normalizeMessageDeliveryConfig(raw: ConfigRecord): MessageDeliveryRegistryConfig {
  const enabled = booleanValue(raw.enabled, true)
  const methods = record(raw.methods)
  const channels = Object.keys(methods).length > 0 ? methods : record(raw.channels)
  const defaultChannels = Array.isArray(raw.default) ? raw.default.map(String) : []

  const channelMap: Record<string, unknown> = {}
  for (const [name, cfg] of Object.entries(channels)) {
    channelMap[name] = normalizeChannelConfig(cfg as ConfigRecord)
  }

  const parsedAuth = parseMessageDeliveryAuth(raw.auth)
  const parsedPeers = parsePeersConfig(raw.peers)

  return {
    enabled,
    ...(parsedAuth ? { auth: parsedAuth } : {}),
    ...(parsedPeers ? { peers: parsedPeers } : {}),
    channels: channelMap as MessageDeliveryRegistryConfig['channels'],
    default: defaultChannels,
    ...(raw.routes ? { routes: raw.routes as MessageDeliveryRegistryConfig['routes'] } : {}),
  } as MessageDeliveryRegistryConfig
}

function normalizePrincipalGrants(raw: unknown): PrincipalGrant[] {
  if (!Array.isArray(raw)) return [{ name: 'message.send' }]
  const grants: PrincipalGrant[] = []
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const r = item as ConfigRecord
      if (typeof r.name === 'string' && r.name.trim()) {
        grants.push({ name: r.name.trim() })
      }
    }
  }
  return grants.length > 0 ? grants : [{ name: 'message.send' }]
}

export interface NormalizedMessageConfig {
  enabled: boolean
  principals: Record<string, MessagePrincipal>
  routes?: Record<string, MessageRouteConfig>
}

export function normalizeMessageConfig(raw: ConfigRecord): NormalizedMessageConfig {
  if (raw.roles !== undefined || raw.local_role !== undefined || raw.remote !== undefined) {
    throw new Error('message.roles, message.local_role, and message.remote have been removed; use principals and routes')
  }
  const principalsRaw = record(raw.principals)
  const routesRaw = record(raw.routes)
  const principals: Record<string, MessagePrincipal> = {}

  for (const [id, cfg] of Object.entries(principalsRaw)) {
    const p = record(cfg)
    if (p.canSend !== undefined || p.canReceive !== undefined || p.deliveryRoute !== undefined || p.channels !== undefined) {
      throw new Error(`message principal '${id}' uses a removed compatibility key`)
    }
    const kindRaw = stringValue(p.kind, 'agent')
    const kind: MessagePrincipal['kind'] = kindRaw === 'human' || kindRaw === 'agent' || kindRaw === 'service'
      ? kindRaw
      : 'agent'
    principals[id] = {
      id,
      kind,
      canSend: booleanValue(p.can_send, true),
      canReceive: booleanValue(p.can_receive, true),
      grants: normalizePrincipalGrants(p.grants),
      ...(stringValue(p.delivery_route, '')
        ? { deliveryRoute: stringValue(p.delivery_route, '') }
        : {}),
    }
  }

  // Ensure canonical principals are present
  for (const [id, principal] of Object.entries(CANONICAL_PRINCIPALS)) {
    if (!principals[id]) {
      principals[id] = { ...principal }
    }
  }

  const routes: Record<string, MessageRouteConfig> = {}
  for (const [routeId, cfg] of Object.entries(routesRaw)) {
    const route = record(cfg)
    if (route.channels !== undefined) {
      throw new Error(`message route '${routeId}' uses removed channels; configure one transport and address`)
    }
    routes[routeId] = normalizeMessageRouteConfig(route, routeId)
  }

  return {
    enabled: booleanValue(raw.enabled, true),
    principals,
    ...(Object.keys(routes).length > 0 ? { routes } : {}),
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

function parseBind(bind: string): { host: string; port: number } {
  const index = bind.lastIndexOf(':')
  if (index < 0) return { host: bind, port: 8787 }
  const host = bind.slice(0, index)
  const rawPort = bind.slice(index + 1)
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid service bind port: ${rawPort}`)
  return { host: host || '127.0.0.1', port }
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

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => typeof entry === 'string' ? entry.trim() : '')
}

function rejectStaleMaxIterations(raw: ConfigRecord, keyPrefix: string): void {
  if (raw.max_iterations !== undefined || raw.maxIterations !== undefined) {
    throw new Error(
      `${keyPrefix}.max_iterations has been removed; turn termination is governed by ` +
      `${keyPrefix}.turn_timeout_ms and no-progress cycle detection`,
    )
  }
}

function normalizePositiveInteger(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function normalizeNonNegativeInteger(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function normalizePetConfig(raw: ConfigRecord, configDir: string, env?: NodeJS.ProcessEnv): ForemanPetConfig {
  const configuredCwd = typeof raw.cwd === 'string' && raw.cwd.trim()
    ? raw.cwd.trim()
    : ''
  const cwd = configuredCwd
    ? resolveConfigRelativePath(configuredCwd, configDir)
    : resolveDefaultPetCwd(env)

  // Explicit command/args always win. With no explicit command, an installed
  // release's packaged executable is selected when it exists at the resolved
  // cwd; otherwise the source defaults (npm start) are preserved.
  const explicitCommand = stringValue(raw.command, '')
  const explicitArgs = Array.isArray(raw.args)
    ? raw.args.map(String)
    : undefined
  let command = 'npm'
  let args = ['start']
  if (explicitCommand) {
    command = explicitCommand
  } else {
    const packaged = resolvePackagedPetExecutable(cwd)
    if (packaged) {
      command = packaged
      args = []
    }
  }
  if (explicitArgs) args = explicitArgs

  return {
    enabled: booleanValue(raw.enabled, false),
    command,
    args,
    cwd,
    startupTimeoutMs: numberValue(raw.startup_timeout_ms, 10_000),
    stopTimeoutMs: numberValue(raw.stop_timeout_ms, 5_000),
    restartOnExit: booleanValue(raw.restart_on_exit, true),
    restartDelayMs: numberValue(raw.restart_delay_ms, 1_000),
  }
}

function resolveDefaultPetCwd(env?: NodeJS.ProcessEnv): string {
  const suiteRoot = resolveWrenyardSuiteRoot({ env })
  // Pet is an optional, separately packaged app: global config normalization
  // (status/update/daemon loads) must resolve the canonical candidate without
  // requiring apps/pet/package.json to exist. Start-time validation happens in
  // the pet service's assertLaunchConfig.
  return resolve(suiteRoot, 'apps', 'pet')
}

function isMessageDeliveryConfig(value: ConfigRecord): boolean {
  if (Array.isArray(value.default)) return true
  if (typeof value.methods === 'object' && value.methods !== null && !Array.isArray(value.methods)) return true
  if (typeof value.channels === 'object' && value.channels !== null && !Array.isArray(value.channels)) return true
  return false
}

function parseMessageDeliveryAuth(raw: unknown): MessageDeliveryAuthConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const auth = raw as ConfigRecord
  const tokenEnv = typeof auth.token_env === 'string' ? auth.token_env.trim() : undefined
  const tokenFile = typeof auth.token_file === 'string' ? auth.token_file.trim() : undefined
  if (!tokenEnv && !tokenFile) return undefined
  const result: MessageDeliveryAuthConfig = {}
  if (tokenEnv) result.token_env = tokenEnv
  if (tokenFile) result.token_file = tokenFile
  return result
}

function parsePeersConfig(raw: unknown): Record<string, PeerConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const peersRaw = raw as ConfigRecord
  const result: Record<string, PeerConfig> = {}
  for (const [name, cfg] of Object.entries(peersRaw)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue
    const peer = cfg as ConfigRecord
    const url = typeof peer.url === 'string' ? peer.url.trim() : ''
    if (!url) continue
    const entry: PeerConfig = { url }
    if (typeof peer.token_env === 'string' && peer.token_env.trim()) {
      entry.token_env = peer.token_env.trim()
    }
    if (typeof peer.token_file === 'string' && peer.token_file.trim()) {
      entry.token_file = peer.token_file.trim()
    }
    result[name] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeChannelConfig(raw: ConfigRecord): ConfigRecord {
  const backend = raw.backend as string | undefined
  if (!backend) return { backend: 'system', ...raw }
  return raw
}

function normalizeMessageRouteConfig(raw: ConfigRecord, routeId: string): MessageRouteConfig {
  const transport = stringValue(raw.transport, '') as MessageTransportKind
  if (!transport) throw new Error(`message route '${routeId}' requires transport`)
  const address = record(raw.address)
  return {
    transport,
    ...(Object.keys(address).length > 0 ? { address } : {}),
    ...(stringValue(raw.format, '') ? { format: stringValue(raw.format, '') } : {}),
    ...(stringValue(raw.description, '') ? { description: stringValue(raw.description, '') } : {}),
  }
}
