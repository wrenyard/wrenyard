import type { ChannelConfig } from './delivery/types.mts'

export type MessageTransportKind = ChannelConfig['backend']
export type MessageRouteAddress = Record<string, unknown>

export interface MessageRouteConfig {
  transport: MessageTransportKind
  address?: MessageRouteAddress
  format?: string
  description?: string
}
