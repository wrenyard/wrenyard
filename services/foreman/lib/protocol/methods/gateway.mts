import type { JsonSchema } from '../jsonrpc.mts'

export interface GatewayConnectionParams {}

export interface GatewayConnectionResult {
  openaiChatBaseUrl: string
  openaiResponsesBaseUrl: string
  anthropicBaseUrl: string
  token: string
  models: Array<{
    id: string
    publicId: string
    provider: string
    displayName: string
    contextWindow?: number
    maxTokens?: number
    taskOnly?: boolean
    family?: 'claude'
    claudeTier?: 'haiku' | 'sonnet' | 'opus'
    supports1MContext?: boolean
    intelligence?: 'low' | 'mid' | 'high' | 'frontier' | 'premium'
    maxOutputTokens?: number
    capabilities?: readonly ('text' | 'image')[]
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    speed?: {
      tps: number
      source: string
      checkedAt: string
      conservative?: boolean
      basis?: string
    }
    pricing?: {
      inputUsdPerMillion: number
      cachedInputUsdPerMillion: number
      outputUsdPerMillion: number
      source: string
      checkedAt: string
    }
  }>
}

export const gatewayConnectionParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema

export const gatewayConnectionResultSchema = {
  type: 'object',
  required: ['openaiChatBaseUrl', 'openaiResponsesBaseUrl', 'anthropicBaseUrl', 'token', 'models'],
  properties: {
    openaiChatBaseUrl: { type: 'string', minLength: 1 },
    openaiResponsesBaseUrl: { type: 'string', minLength: 1 },
    anthropicBaseUrl: { type: 'string', minLength: 1 },
    token: { type: 'string', minLength: 1 },
    models: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'publicId', 'provider', 'displayName'],
        properties: {
          id: { type: 'string' }, publicId: { type: 'string' }, provider: { type: 'string' },
          displayName: { type: 'string' }, contextWindow: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 },
          taskOnly: { type: 'boolean' }, family: { const: 'claude' },
          claudeTier: { enum: ['haiku', 'sonnet', 'opus'] }, supports1MContext: { type: 'boolean' },
          intelligence: { enum: ['low', 'mid', 'high', 'frontier', 'premium'] },
          maxOutputTokens: { type: 'integer', minimum: 1 },
          capabilities: { type: 'array', items: { enum: ['text', 'image'] } },
          reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] },
          speed: {
            type: 'object',
            required: ['tps', 'source', 'checkedAt'],
            properties: {
              tps: { type: 'number', minimum: 0 }, source: { type: 'string', minLength: 1 }, checkedAt: { type: 'string', minLength: 1 },
              conservative: { type: 'boolean' }, basis: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
          pricing: {
            type: 'object',
            required: ['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion', 'source', 'checkedAt'],
            properties: {
              inputUsdPerMillion: { type: 'number', minimum: 0 }, cachedInputUsdPerMillion: { type: 'number', minimum: 0 },
              outputUsdPerMillion: { type: 'number', minimum: 0 }, source: { type: 'string', minLength: 1 }, checkedAt: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
