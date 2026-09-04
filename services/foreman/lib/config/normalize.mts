import { isAbsolute, resolve } from 'node:path'
import type { MessageRouteConfig, MessageTransportKind } from '../message/types.mts'
import type { MessageDeliveryAuthConfig, MessageDeliveryRegistryConfig, PeerConfig } from '../message/delivery/types.mts'
import type { ConfigRecord, ForemanServiceConfig } from './types.mts'
import type { MessagePrincipal, PrincipalRegistry, PrincipalGrant } from '../message/principal.mts'
import { CANONICAL_PRINCIPALS } from '../message/principal.mts'
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
  const message = record(config.message)
  const messageDeliveryRaw = record(message.delivery)

  const bind = stringValue(service.bind, '127.0.0.1:8787')
  const { host, port } = parseBind(bind)
  const workspaceRoot = resolveWorkspaceRoot(workspace.root, options.configDir, env)

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
    message: normalizedMessage,
    ...(messageDelivery ? { messageDelivery } : {}),
  }
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
