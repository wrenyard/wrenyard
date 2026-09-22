export interface MessageEnvelope {
  id: string
  kind: 'task.done' | 'task.failed' | 'task.started' | 'flow.done' | 'flow.failed'
    | 'flow.started' | 'flow.checkpoint' | 'progress' | 'message'
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  body: string
  refs: {
    taskId?: string
    workflowId?: string
    sessionId?: string
    project?: string
    originSession?: { id: string; label?: string; host?: string }
  }
  originatingConnectionId?: string
  media?: string
  origin?: { channel: string; peer?: string; thread?: string; sender?: string }
  hops?: number
  ts: string
}

export interface MessageDeliveryResult {
  /** Legacy response field: this now carries the delivery route id. */
  channel: string
  /** Legacy response field: this now carries the transport kind. */
  backend: string
  ok: boolean
  skipped?: boolean
  error?: string
  detail?: unknown
}

export interface OpenclawChannelConfig {
  backend: 'openclaw'
  mode?: 'send' | 'agent'
  target?: string
  channel?: string
  session_key?: string
  model?: string | null
  timeout?: number
}

export interface TelegramChannelConfig {
  backend: 'telegram'
  chat_id: string
  token_env?: string
  token_file?: string
}

export interface WecomChannelConfig {
  backend: 'wecom'
  webhook_env?: string
  webhook_file?: string
}

export interface WebhookChannelConfig {
  backend: 'webhook'
  url: string
  headers?: Record<string, string>
  template?: Record<string, string>
}

export interface SystemChannelConfig {
  backend: 'system'
}

export interface CcChannelConfig {
  backend: 'cc-channel'
}

export interface RemoteChannelConfig {
  backend: 'remote'
  peer: string
  channel: string
}

export type ChannelConfig =
  | OpenclawChannelConfig
  | TelegramChannelConfig
  | WecomChannelConfig
  | WebhookChannelConfig
  | SystemChannelConfig
  | CcChannelConfig
  | RemoteChannelConfig

export interface PeerConfig {
  url: string
  token_env?: string
  token_file?: string
}

export interface MessageDeliveryAuthConfig {
  token_env?: string
  token_file?: string
}

export interface MessageDeliveryRegistryConfig {
  enabled: boolean
  auth?: MessageDeliveryAuthConfig
  peers?: Record<string, PeerConfig>
  /**
   * Legacy event-delivery route map. Kept as channels for external config/API
   * compatibility while message routing uses roles -> routes -> transports.
   */
  channels: Record<string, ChannelConfig>
  default: string[]
  routes?: Partial<Record<MessageEnvelope['kind'], string[]>>
}
