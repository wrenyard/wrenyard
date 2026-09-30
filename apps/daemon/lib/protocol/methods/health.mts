import type { JsonSchema } from '../jsonrpc.mts'

export interface HealthPingParams {}

export interface HealthPingResult {
  ok: true
  /**
   * Integer IPC protocol version. Clients send their expected version in the
   * handshake params and validate this echoed value; a missing value fails the
   * client handshake closed.
   */
  protocolVersion: number
  uptimeMs?: number
  identity?: {
    mode: 'source' | 'installed'
    version?: string
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
