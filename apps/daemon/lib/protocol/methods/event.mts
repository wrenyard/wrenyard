import type { JsonRecord, JsonSchema } from '../jsonrpc.mts'


export type { EventListParams, EventListResult } from '@wrenyard/protocol/event'
export type { JsonRecord } from '@wrenyard/protocol/common'

export const eventListParamsSchema = {
  type: 'object',
  properties: {
    since: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    tail: { type: 'boolean' },
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
