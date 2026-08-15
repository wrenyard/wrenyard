import type { MessageDeliveryResult, MessageDeliveryRegistryConfig, MessageEnvelope, ChannelConfig, PeerConfig } from './types.mts'
import { resolveDeliveryRoutes } from './router.mts'

export interface MessageTransport {
  readonly name: string
  deliver(event: MessageEnvelope, routeId: string): Promise<MessageDeliveryResult>
}

export type TransportFactory = (routeId: string, cfg: ChannelConfig) => MessageTransport
/** @deprecated Use MessageTransport. */
export type MessageBackend = MessageTransport
/** @deprecated Use TransportFactory. */
export type BackendFactory = TransportFactory
export type EmitOptions = { channels?: string[] }

export class MessageDeliveryHub {
  private config: MessageDeliveryRegistryConfig
  private factory: TransportFactory

  constructor(config: MessageDeliveryRegistryConfig, factory: TransportFactory) {
    this.config = config
    this.factory = factory
  }

  getRouteNames(): string[] {
    return Object.keys(this.config.channels)
  }

  /** @deprecated Use getRouteNames. */
  getChannelNames(): string[] {
    return this.getRouteNames()
  }

  getPeerConfig(peerName: string): PeerConfig | undefined {
    return this.config.peers?.[peerName]
  }

  getRouteTransportConfig(routeId: string): ChannelConfig | undefined {
    return this.config.channels[routeId]
  }

  /** @deprecated Use getRouteTransportConfig. */
  getChannelConfig(channelName: string): ChannelConfig | undefined {
    return this.getRouteTransportConfig(channelName)
  }

  async emit(event: MessageEnvelope, opts?: EmitOptions): Promise<MessageDeliveryResult[]> {
    // opts.channels is a compatibility input name. Inside the hub it is a route override.
    const { routes: routedRoutes, errors } = resolveDeliveryRoutes(event, opts?.channels, this.config)

    if (errors.length > 0) {
      for (const err of errors) {
        process.stderr.write(`[foreman-message] router: ${err}\n`)
      }
    }

    const missingDeliveries: MessageDeliveryResult[] = errors.map((channel) => ({
      channel,
      backend: 'unknown',
      ok: false,
      error: `no config for channel '${channel}'`,
    }))

    const routeIds = [...routedRoutes]

    if (routeIds.length === 0) {
      return missingDeliveries
    }

    const deliveries = await Promise.allSettled(
      routeIds.map(async (routeId): Promise<MessageDeliveryResult> => {
        const routeTransportCfg = this.config.channels[routeId]
        if (!routeTransportCfg) {
          // Should not happen if resolveDeliveryRoutes works correctly, but safety check.
          // Result.channel is the legacy response field for routeId.
          const delivery: MessageDeliveryResult = {
            channel: routeId,
            backend: 'unknown',
            ok: false,
            error: `no config for channel '${routeId}'`,
          }
          return delivery
        }

        const transport = this.factory(routeId, routeTransportCfg)

        try {
          const delivery = await transport.deliver(event, routeId)
          return delivery
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[foreman-message] ${routeId} (${transport.name}): delivery failed (${routeTransportCfg.backend})\n`)
          const delivery: MessageDeliveryResult = {
            channel: routeId,
            backend: routeTransportCfg.backend,
            ok: false,
            error: message,
          }
          return delivery
        }
      }),
    )

    return [
      ...missingDeliveries,
      ...deliveries.map((settled) => {
        if (settled.status === 'fulfilled') return settled.value
        // This handles the case where the entire Promise.allSettled wrapper itself threw
        // (e.g. factory threw synchronously before deliver was called)
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
        process.stderr.write(`[foreman-message] hub: unexpected rejection\n`)
        const delivery: MessageDeliveryResult = {
          channel: 'unknown',
          backend: 'unknown',
          ok: false,
          error: reason,
        }
        return delivery
      }),
    ]
  }
}
