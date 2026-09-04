import type { JsonSchema } from '../jsonrpc.mts'

export interface MessageSendParams {
  to: string
  text: string
  sender?: string | {
    role: string
    [key: string]: unknown
  }
  client_message_id?: string
}

export interface MessageSendResult {
  accepted: boolean
  message_id?: string
  target_seq?: number
  queue_depth?: number
  delivery?: Record<string, unknown>
  error?: string
  message?: string
}

export const messageSendParamsSchema = {
  type: 'object',
  required: ['to', 'text'],
  properties: {
    to: { type: 'string', minLength: 1 },
    text: { type: 'string', minLength: 1 },
    sender: {
      anyOf: [
        { type: 'string', minLength: 1 },
        {
          type: 'object',
          required: ['role'],
          properties: {
            role: { type: 'string', minLength: 1 },
          },
          additionalProperties: true,
        },
      ],
    },
    client_message_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const messageSendResultSchema = {
  type: 'object',
  required: ['accepted'],
  properties: {
    accepted: { type: 'boolean' },
    message_id: { type: 'string' },
    target_seq: { type: 'integer', minimum: 0 },
    queue_depth: { type: 'integer', minimum: 0 },
    delivery: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
