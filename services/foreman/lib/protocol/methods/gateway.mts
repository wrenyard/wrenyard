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
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
