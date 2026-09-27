import type { JsonSchema } from '../jsonrpc.mts'

export interface HealthPingParams {}

export interface HealthPingResult {
  ok: true
  uptimeMs?: number
  identity?: {
    mode: 'source' | 'installed'
    checkout?: string
    node?: string
  }
}

export const healthPingParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const healthPingResultSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { const: true },
    uptimeMs: { type: 'number', minimum: 0 },
    identity: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['source', 'installed'] },
        checkout: { type: 'string' },
        node: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
