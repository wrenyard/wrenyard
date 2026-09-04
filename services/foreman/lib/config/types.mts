import type { MessageDeliveryRegistryConfig } from '../message/delivery/types.mts'

export type ConfigRecord = Record<string, unknown>

export interface ForemanServiceConfig {
  service: {
    enabled: boolean
    host: string
    port: number
    publicUrl?: string
    ipc?: {
      path?: string
    }
  }
  workspaceRoot: string
  message: import('./normalize.mts').NormalizedMessageConfig
  messageDelivery?: MessageDeliveryRegistryConfig
}
