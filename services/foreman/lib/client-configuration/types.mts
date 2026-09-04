export type ClientConfigurationId = 'claude-app' | 'claude-code' | 'codex-shared' | 'grok-build'

export type ClientSurfaceId = 'claude-app' | 'claude-code' | 'codex-app' | 'codex-cli' | 'grok-build'

export type ClientCompatibility =
  | 'not-installed'
  | 'supported'
  | 'needs-verification'
  | 'needs-upgrade'
  | 'externally-managed'

export type ClientConfigurationState =
  | 'not-configured'
  | 'connected'
  | 'drifted'
  | 'conflict'
  | 'needs-restart'

export type GatewayProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'

export interface ClientSurfaceDiscovery {
  id: ClientSurfaceId
  label: string
  installed: boolean
  compatibility: ClientCompatibility
  source?: string
  version?: string
  detail?: string
}

export interface ClientGatewayModel {
  id: string
  publicId: string
  provider: string
  displayName: string
  protocols: readonly GatewayProtocol[]
  contextWindow?: number
  maxTokens?: number
  claudeFamily?: boolean
  claudeTier?: 'haiku' | 'sonnet' | 'opus'
  supports1MContext?: boolean
}

export interface GatewayClientConnection {
  openaiChatBaseUrl: string
  openaiResponsesBaseUrl: string
  anthropicBaseUrl: string
  credential: string
  credentialHelperPath: string
  credentialHelperCommand: readonly string[]
  models: readonly ClientGatewayModel[]
}

export interface ClientModelSelection {
  models: readonly string[]
  defaultModel: string
  protocols?: Readonly<Record<string, GatewayProtocol>>
}

export interface ClientPlanFile {
  path: string
  digest: string
  existed: boolean
  changes: readonly string[]
}

export interface ClientConfigurationPlan {
  clientId: ClientConfigurationId
  operation: 'apply' | 'restore'
  files: readonly ClientPlanFile[]
  models: readonly string[]
  defaultModel?: string
  protocols?: Readonly<Record<string, GatewayProtocol>>
  connectionMode: 'additive' | 'switching'
  effects: readonly string[]
  requiresRestart: readonly ClientSurfaceId[]
}

export interface ClientConfigurationStatus {
  clientId: ClientConfigurationId
  state: ClientConfigurationState
  configuredModels: readonly string[]
  detail?: string
}

export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

export interface ClientOwnershipRecord {
  clientId: ClientConfigurationId
  baseline: JsonValue
  lastApplied: JsonValue
  models: string[]
  defaultModel?: string
  updatedAt: string
}

export interface ClientOwnershipStore {
  get(clientId: ClientConfigurationId): Promise<ClientOwnershipRecord | undefined>
  put(record: ClientOwnershipRecord): Promise<void>
  remove(clientId: ClientConfigurationId): Promise<void>
}

export interface ClientAdapter {
  readonly id: ClientConfigurationId
  status(): Promise<ClientConfigurationStatus>
  plan(connection: GatewayClientConnection, selection: ClientModelSelection): Promise<ClientConfigurationPlan>
  apply(plan: ClientConfigurationPlan, connection: GatewayClientConnection): Promise<ClientConfigurationStatus>
  planRestore(): Promise<ClientConfigurationPlan>
  restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus>
}

export interface ClientDiscovery {
  list(): Promise<readonly ClientSurfaceDiscovery[]>
}

export interface GatewayConnectionSource {
  read(): Promise<GatewayClientConnection>
}
