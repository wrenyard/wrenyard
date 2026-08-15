import type { JsonSchema } from '../jsonrpc.mts'

export interface AttachmentItem {
  /** Host filesystem path */
  path: string
}

export interface MessageSendParams {
  to: string
  text: string
  sender?: string | {
    role: string
    [key: string]: unknown
  }
  client_message_id?: string
  /** Path-only attachment descriptors */
  attachments?: AttachmentItem[]
}

export interface AttachmentResultItem {
  path: string
  status: 'accepted' | 'rejected'
  mime_type?: string
  size?: number
  sha256?: string
  storage_ref?: string
  error?: 'file_not_found' | 'invalid_path' | 'not_regular_file' | 'too_large' | 'unsupported_content_type' | 'read_failed'
}

export interface MessageSendResult {
  accepted: boolean
  message_id?: string
  target_seq?: number
  queue_depth?: number
  delivery?: Record<string, unknown>
  error?: string
  message?: string
  /** Per-item attachment outcomes */
  attachments?: AttachmentResultItem[]
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
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
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
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'status'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['accepted', 'rejected'] },
          mime_type: { type: 'string' },
          size: { type: 'integer', minimum: 0 },
          sha256: { type: 'string' },
          storage_ref: { type: 'string' },
          error: { type: 'string', enum: ['file_not_found', 'invalid_path', 'not_regular_file', 'too_large', 'unsupported_content_type', 'read_failed'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
