export type ClientConfigurationId = 'claude-app' | 'claude-code' | 'codex-shared' | 'grok-build';
export type ClientSurfaceId = 'claude-app' | 'claude-code' | 'codex-app' | 'codex-cli' | 'grok-build';
export type ClientCompatibility = 'not-installed' | 'supported' | 'needs-verification' | 'needs-upgrade' | 'externally-managed';
export type ClientConfigurationState = 'not-configured' | 'connected' | 'drifted' | 'conflict' | 'needs-restart';
export type GatewayProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

export interface ClientSurfaceDto {
  id: ClientSurfaceId;
  label: string;
  installed: boolean;
  compatibility: ClientCompatibility;
  source?: string;
  version?: string;
  detail?: string;
}

export interface ClientConfigurationDto {
  clientId: ClientConfigurationId;
  state: ClientConfigurationState;
  configuredModels: string[];
  detail?: string;
}

export interface ClientConfigurationSnapshotDto {
  surfaces: ClientSurfaceDto[];
  configurations: ClientConfigurationDto[];
}

export interface ClientPlanFileDto {
  path: string;
  digest: string;
  existed: boolean;
  changes: string[];
}

export interface ClientConfigurationPlanDto {
  clientId: ClientConfigurationId;
  operation: 'apply' | 'restore';
  files: ClientPlanFileDto[];
  models: string[];
  defaultModel?: string;
  protocols?: Partial<Record<string, GatewayProtocol>>;
  connectionMode: 'additive' | 'switching';
  effects: string[];
  requiresRestart: ClientSurfaceId[];
}

export interface ClientModelSelectionDto {
  models: string[];
  defaultModel: string;
  protocols?: Partial<Record<string, GatewayProtocol>>;
}
