import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/providers/catalog'
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
    intelligence: 'low' | 'mid' | 'high' | 'premium'
    maxOutputTokens?: number
    capabilities?: readonly ('text' | 'image')[]
    /**
     * The legal reasoning-effort levels this model accepts, in ascending
     * intensity. A per-run reasoning-effort choice is validated against this
     * exact ladder.
     */
    reasoningEfforts: readonly ReasoningEffort[]
    speed?: number
    /** USD per million tokens: [cached, input, output]. */
    pricing?: readonly [number, number, number]
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
        required: ['id', 'publicId', 'provider', 'displayName', 'intelligence', 'reasoningEfforts'],
        properties: {
          id: { type: 'string' }, publicId: { type: 'string' }, provider: { type: 'string' },
          displayName: { type: 'string' }, contextWindow: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 },
          taskOnly: { type: 'boolean' }, family: { const: 'claude' },
          claudeTier: { enum: ['haiku', 'sonnet', 'opus'] }, supports1MContext: { type: 'boolean' },
          intelligence: { enum: ['low', 'mid', 'high', 'premium'] },
          maxOutputTokens: { type: 'integer', minimum: 1 },
          capabilities: { type: 'array', items: { enum: ['text', 'image'] } },
          reasoningEfforts: {
            type: 'array', minItems: 1, uniqueItems: true,
            items: { enum: REASONING_EFFORTS },
          },
          speed: { type: 'number', exclusiveMinimum: 0 },
          pricing: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number', minimum: 0 },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
