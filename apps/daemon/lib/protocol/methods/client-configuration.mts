import type { JsonSchema } from '../jsonrpc.mts'
import type {
  ClientConfigurationId,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientModelSelection,
  ClientSurfaceDiscovery,
  ClientGatewayModel,
} from '../../client-configuration/types.mts'

export interface ClientConfigurationSnapshotParams {}
export interface ClientConfigurationSnapshotResult {
  surfaces: readonly ClientSurfaceDiscovery[]
  configurations: readonly ClientConfigurationStatus[]
  models: readonly ClientGatewayModel[]
}
export interface ClientConfigurationPlanParams {
  clientId: ClientConfigurationId
  selection: ClientModelSelection
}
export type ClientConfigurationPlanResult = ClientConfigurationPlan
export interface ClientConfigurationApplyParams { plan: ClientConfigurationPlan }
export type ClientConfigurationApplyResult = ClientConfigurationStatus
export interface ClientConfigurationPlanRestoreParams { clientId: ClientConfigurationId }
export type ClientConfigurationPlanRestoreResult = ClientConfigurationPlan
export interface ClientConfigurationRestoreParams { plan: ClientConfigurationPlan }
export type ClientConfigurationRestoreResult = ClientConfigurationStatus

const clientIdSchema = {
  type: 'string', enum: ['claude-app', 'claude-code', 'codex-shared', 'grok-build'],
} as const
const surfaceIdSchema = {
  type: 'string', enum: ['claude-app', 'claude-code', 'codex-app', 'codex-cli', 'grok-build'],
} as const
const protocolSchema = {
  type: 'string', enum: ['openai_chat', 'openai_responses', 'anthropic_messages'],
} as const
const stringListSchema = {
  type: 'array', maxItems: 128, uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 240 },
} as const
const protocolMapSchema = {
  type: 'object', maxProperties: 128, propertyNames: { minLength: 1, maxLength: 240 },
  additionalProperties: protocolSchema,
} as const
const selectionSchema = {
  type: 'object', required: ['models', 'defaultModel'], properties: {
    models: stringListSchema,
    defaultModel: { type: 'string', minLength: 1, maxLength: 240 },
    protocols: protocolMapSchema,
  }, additionalProperties: false,
} as const
const planFileSchema = {
  type: 'object', required: ['path', 'digest', 'existed', 'changes'], properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    existed: { type: 'boolean' },
    changes: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 500 } },
  }, additionalProperties: false,
} as const
const planSchema = {
  type: 'object',
  required: ['clientId', 'operation', 'files', 'models', 'connectionMode', 'effects', 'requiresRestart'],
  properties: {
    clientId: clientIdSchema,
    operation: { type: 'string', enum: ['apply', 'restore'] },
    files: { type: 'array', maxItems: 16, items: planFileSchema },
    models: stringListSchema,
    defaultModel: { type: 'string', minLength: 1, maxLength: 240 },
    protocols: protocolMapSchema,
    connectionMode: { type: 'string', enum: ['additive', 'switching'] },
    effects: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 1000 } },
    requiresRestart: { type: 'array', maxItems: 5, uniqueItems: true, items: surfaceIdSchema },
  },
  additionalProperties: false,
} as const
const configurationStatusSchema = {
  type: 'object', required: ['clientId', 'state', 'configuredModels'], properties: {
    clientId: clientIdSchema,
    state: { type: 'string', enum: ['not-configured', 'connected', 'drifted', 'conflict', 'needs-restart'] },
    configuredModels: stringListSchema,
    detail: { type: 'string', maxLength: 2000 },
  }, additionalProperties: false,
} as const
const surfaceSchema = {
  type: 'object', required: ['id', 'label', 'installed', 'compatibility'], properties: {
    id: surfaceIdSchema,
    label: { type: 'string', minLength: 1, maxLength: 160 },
    installed: { type: 'boolean' },
    compatibility: { type: 'string', enum: ['not-installed', 'supported', 'needs-verification', 'needs-upgrade', 'externally-managed'] },
    source: { type: 'string', maxLength: 4096 },
    version: { type: 'string', maxLength: 120 },
    detail: { type: 'string', maxLength: 2000 },
  }, additionalProperties: false,
} as const
const gatewayModelSchema = {
  type: 'object', required: ['id', 'publicId', 'provider', 'displayName', 'protocols'], properties: {
    id: { type: 'string', minLength: 1, maxLength: 240 },
    publicId: { type: 'string', minLength: 3, maxLength: 240 },
    provider: { type: 'string', minLength: 1, maxLength: 120 },
    displayName: { type: 'string', minLength: 1, maxLength: 240 },
    protocols: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: protocolSchema },
    contextWindow: { type: 'integer', minimum: 1 },
    maxTokens: { type: 'integer', minimum: 1 },
    claudeFamily: { type: 'boolean' },
    claudeTier: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
    supports1MContext: { type: 'boolean' },
  }, additionalProperties: false,
} as const

export const clientConfigurationSnapshotParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationSnapshotResultSchema = {
  type: 'object', required: ['surfaces', 'configurations', 'models'], properties: {
    surfaces: { type: 'array', maxItems: 5, items: surfaceSchema },
    configurations: { type: 'array', maxItems: 4, items: configurationStatusSchema },
    models: { type: 'array', maxItems: 512, items: gatewayModelSchema },
  }, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationPlanParamsSchema = {
  type: 'object', required: ['clientId', 'selection'], properties: {
    clientId: clientIdSchema, selection: selectionSchema,
  }, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationPlanResultSchema = planSchema satisfies JsonSchema
export const clientConfigurationApplyParamsSchema = {
  type: 'object', required: ['plan'], properties: { plan: planSchema }, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationApplyResultSchema = configurationStatusSchema satisfies JsonSchema
export const clientConfigurationPlanRestoreParamsSchema = {
  type: 'object', required: ['clientId'], properties: { clientId: clientIdSchema }, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationPlanRestoreResultSchema = planSchema satisfies JsonSchema
export const clientConfigurationRestoreParamsSchema = {
  type: 'object', required: ['plan'], properties: { plan: planSchema }, additionalProperties: false,
} as const satisfies JsonSchema
export const clientConfigurationRestoreResultSchema = configurationStatusSchema satisfies JsonSchema
