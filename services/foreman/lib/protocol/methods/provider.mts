import type { JsonSchema } from '../jsonrpc.mts'

export interface ProviderListParams {}
/** USD per million tokens: [cached, input, output]. */
export type ProviderListModelPricing = readonly [number, number, number]

export interface ProviderListModel {
  id: string
  displayName: string
  contextWindow?: number
  maxTokens?: number
  effectiveTps?: number | null
  quotaAbundant?: boolean
  free?: boolean
  taskOnly?: boolean
  /** Provider-independent canonical model id; falls back to the model id. */
  canonicalId?: string
  /** Catalog intelligence tier for the model. */
  intelligence?: 'low' | 'mid' | 'high' | 'premium'
  /** Catalog list price as [cached, input, output] USD per million tokens. */
  pricing?: ProviderListModelPricing
  /** Which evidence tier produced `effectiveTps`. */
  speedSource?: 'local_31d' | 'provider_override' | 'catalog_default'
  /** True when a credential is configured AND the resolver admits provider/model. */
  available?: boolean
}
export interface ProviderListResult {
  providers: Array<{
    id: string
    displayName: string
    description: string
    setupHint: string
    configured: boolean
    authMode: 'api-key' | 'native' | 'none'
    protocols: Array<'openai_chat' | 'openai_responses' | 'anthropic_messages'>
    models: ProviderListModel[]
  }>
}
export interface ProviderConfigureParams { providerId: string; key: string }
export interface ProviderConfigureResult { ok: true }

export const providerListParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema

export const providerListResultSchema = {
  type: 'object', required: ['providers'], properties: {
    providers: { type: 'array', maxItems: 64, items: {
      type: 'object', required: ['id', 'displayName', 'description', 'setupHint', 'configured', 'authMode', 'protocols', 'models'], properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 }, configured: { type: 'boolean' },
        displayName: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 500 },
        setupHint: { type: 'string', maxLength: 500 },
        authMode: { type: 'string', enum: ['api-key', 'native', 'none'] },
        protocols: { type: 'array', maxItems: 3, uniqueItems: true, items: {
          type: 'string', enum: ['openai_chat', 'openai_responses', 'anthropic_messages'],
        } },
        models: { type: 'array', maxItems: 128, items: {
          type: 'object', required: ['id', 'displayName'], properties: {
            id: { type: 'string', minLength: 1, maxLength: 200 },
            displayName: { type: 'string', minLength: 1, maxLength: 200 },
            contextWindow: { type: 'integer', minimum: 1 },
            maxTokens: { type: 'integer', minimum: 1 },
            taskOnly: { type: 'boolean' },
            effectiveTps: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
            quotaAbundant: { type: 'boolean' },
            free: { type: 'boolean' },
            canonicalId: { type: 'string', minLength: 1, maxLength: 200 },
            intelligence: { type: 'string', enum: ['low', 'mid', 'high', 'premium'] },
            pricing: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: { type: 'number', minimum: 0 },
            },
            speedSource: { type: 'string', enum: ['local_31d', 'provider_override', 'catalog_default'] },
            available: { type: 'boolean' },
          }, additionalProperties: false,
        } },
      }, additionalProperties: false,
    } },
  }, additionalProperties: false,
} as const satisfies JsonSchema

export const providerConfigureParamsSchema = {
  type: 'object', required: ['providerId', 'key'], properties: {
    providerId: { type: 'string', minLength: 1, maxLength: 120 },
    key: { type: 'string', minLength: 1, maxLength: 4096 },
  }, additionalProperties: false,
} as const satisfies JsonSchema

export const providerConfigureResultSchema = {
  type: 'object', required: ['ok'], properties: { ok: { const: true } }, additionalProperties: false,
} as const satisfies JsonSchema
