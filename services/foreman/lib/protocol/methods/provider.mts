import type { JsonSchema } from '../jsonrpc.mts'
import type {
  ProviderConfigureParams,
  ProviderConfigureResult,
  ProviderListModel,
  ProviderListModelPricing,
  ProviderListParams,
  ProviderListResult,
  ProviderQuotaParams,
  ProviderQuotaResult,
  ProviderQuotaSnapshot,
} from '@wrenyard/protocol/provider'

// Wire DTOs are declared once in @wrenyard/protocol/provider and re-exported
// here so every existing daemon import path keeps working. The runtime JSON
// schemas below (including the quota schema) stay daemon-owned.
export type {
  ProviderConfigureParams,
  ProviderConfigureResult,
  ProviderListModel,
  ProviderListModelPricing,
  ProviderListParams,
  ProviderListResult,
  ProviderQuotaParams,
  ProviderQuotaResult,
  ProviderQuotaSnapshot,
}

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

export const providerQuotaParamsSchema = {
  type: 'object', properties: {
    forceRefresh: { type: 'boolean' },
  }, additionalProperties: false,
} as const satisfies JsonSchema

export const providerQuotaResultSchema = {
  type: 'object', required: ['providers', 'fetchedAt'], properties: {
    providers: { type: 'array', maxItems: 64, items: {
      type: 'object', required: ['provider', 'status', 'stale'], properties: {
        provider: { type: 'string', minLength: 1, maxLength: 120 },
        status: { type: 'string', enum: ['ok', 'error', 'unavailable'] },
        stale: { type: 'boolean' },
        code: { type: 'string', maxLength: 200 },
        used: { type: 'number' },
        total: { type: 'number' },
        balances: { type: 'array', maxItems: 128, items: {
          type: 'object', required: ['currency', 'amount'], properties: {
            currency: { type: 'string', minLength: 1, maxLength: 32 },
            amount: { type: 'string', maxLength: 64 },
          }, additionalProperties: false,
        } },
        fetched_at: { type: 'string', maxLength: 64 },
        source: { type: 'string', maxLength: 200 },
        message: { type: 'string', maxLength: 500 },
        error: { type: 'string', maxLength: 500 },
        windows: { type: 'array', maxItems: 64, items: {
          type: 'object', required: ['name', 'pct', 'window_minutes'], properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            pct: { type: 'number' },
            window_minutes: { type: 'number' },
            resets_at: { type: 'string', maxLength: 64 },
          }, additionalProperties: false,
        } },
        not_applicable_windows: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 120 } },
      }, additionalProperties: false,
    } },
    fetchedAt: { type: 'number' },
  }, additionalProperties: false,
} as const satisfies JsonSchema
