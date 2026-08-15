import type { JsonRecord, JsonSchema } from '../jsonrpc.mts'

export interface EventListParams {
  since?: number
  limit?: number
}

export interface EventListResult {
  events: JsonRecord[]
  count: number
  cursor: number
}

export const eventListParamsSchema = {
  type: 'object',
  properties: {
    since: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const eventListResultSchema = {
  type: 'object',
  required: ['events', 'count', 'cursor'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
    count: { type: 'integer', minimum: 0 },
    cursor: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
