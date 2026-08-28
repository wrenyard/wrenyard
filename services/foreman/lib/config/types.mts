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
  fwa?: {
    workspaceRoot: string
    llm: {
      model: string
      turn_timeout_ms: number
      http_timeout_ms: number
      max_retries: number
      retry_backoff_ms: number
    }
  }
  work?: {
    workspaceRoot: string
    /** Maximum concurrent branch turns for foreman-work. Default 3; 1 = exact FIFO serial. */
    max_concurrent_turns: number
    llm: {
      model: string
      /** Optional list of model ids allowed for runtime switching. Defaults to [model]. */
      models?: string[]
      turn_timeout_ms: number
      http_timeout_ms: number
      max_retries: number
      retry_backoff_ms: number
    }
  }
  message: import('./normalize.mts').NormalizedMessageConfig
  messageDelivery?: MessageDeliveryRegistryConfig
}
