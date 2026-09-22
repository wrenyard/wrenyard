import type { ChannelConfig, MessageDeliveryResult, MessageEnvelope, PeerConfig } from '../../../message/delivery/types.mts'
import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageRouteConfig } from '../../../message/types.mts'
import { routeToTransportConfig } from '../../../message/transport.mts'

import { createOpenclawBackend } from './openclaw.mts'
import { createTelegramBackend } from './telegram.mts'
import { createWecomBackend } from './wecom.mts'
import { createWebhookBackend } from './webhook.mts'
import { createSystemBackend } from './system.mts'
import { createCcChannelBackend, deliverToConnection } from './cc-channel.mts'

export { deliverToConnection }
import { createRemoteBackend } from './remote.mts'

// Re-export the MessageBackend interface from hub for convenience.
export type { MessageBackend } from '../../../message/delivery/hub.mts'

export interface McpConnection {
  id: string
  channelCapable: boolean
  sendNotification(message: { method: string; params: Record<string, unknown> }): void
  originRing?: MessageEnvelope['origin'][]
  label?: string
  cwd?: string
  pid?: number
  startedAt?: string
  clientName?: string
  clientVersion?: string
  host?: string
}

const MAX_ORIGIN_RING = 8

export function recordOrigin(conn: McpConnection, origin: MessageEnvelope['origin']): void {
  if (!conn.originRing) conn.originRing = []
  conn.originRing.push(origin)
  while (conn.originRing.length > MAX_ORIGIN_RING) conn.originRing.shift()
}

export function mostRecentOrigin(conn: McpConnection): MessageEnvelope['origin'] | undefined {
  return conn.originRing?.at(-1)
}

// Dependencies that backends need; injected so tests may supply fakes.
export interface BackendDeps {
  fetch?: typeof globalThis.fetch
  connections?: Map<string, McpConnection>
  peers?: Record<string, PeerConfig>
}

export type MessageTransport = MessageBackend
export type TransportDeps = BackendDeps
export type TransportFactory = (routeId: string, route: MessageRouteConfig) => MessageTransport

export function createTransport(
  routeId: string,
  route: MessageRouteConfig,
  deps?: TransportDeps,
): MessageTransport {
  return createBackend(routeId, routeToTransportConfig(route), deps)
}

/**
 * @deprecated Transport drivers used to be named backends. Keep this alias for
 * older tests and call sites while the core message model uses transport.
 */
export function createBackend(
  name: string,
  channelCfg: ChannelConfig,
  deps?: BackendDeps,
): MessageBackend {
  switch (channelCfg.backend) {
    case 'openclaw':
      return createOpenclawBackend(channelCfg)
    case 'telegram':
      return createTelegramBackend(channelCfg, deps)
    case 'wecom':
      return createWecomBackend(channelCfg, deps)
    case 'webhook':
      return createWebhookBackend(channelCfg, deps)
    case 'system':
      return createSystemBackend()
    case 'cc-channel':
      return createCcChannelBackend(name, channelCfg, deps)
    case 'remote':
      return createRemoteBackend(channelCfg, deps)
  }
}
