import type { JsonSchema } from '../jsonrpc.mts'


export type {
  HealthPingParams,
  HealthPingResult,
} from '@wrenyard/protocol/daemon'

export const healthPingParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const healthPingResultSchema = {
  type: 'object',
  required: ['ok', 'protocolVersion'],
  properties: {
    ok: { const: true },
    protocolVersion: { type: 'integer', minimum: 1 },
    uptimeMs: { type: 'number', minimum: 0 },
    identity: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['source', 'installed'] },
        version: { type: 'string' },
        checkout: { type: 'string' },
        node: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
