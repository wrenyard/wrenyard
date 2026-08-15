import type { ChannelConfig } from './delivery/types.mts'
import type { MessageRouteConfig } from './types.mts'

export function routeToTransportConfig(route: MessageRouteConfig): ChannelConfig {
  return {
    ...(route.address ?? {}),
    backend: route.transport,
  } as ChannelConfig
}
