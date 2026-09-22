import type { JsonSchema } from '../jsonrpc.mts'
export type {
  ExecStartParams, ExecStartResult, ExecSnapshot, ExecGetParams, ExecGetResult,
  ExecEventEnvelope, ExecEventsParams, ExecEventsResult, ExecCancelParams, ExecCancelResult,
} from '@wrenyard/protocol/exec'

// Runtime validation lives at the daemon boundary; wire types live in protocol/exec.
export const EXEC_STATUS_VALUES = ['running', 'completed', 'failed', 'cancelled'] as const

export const execStartParamsSchema = {
  type: 'object',
  required: ['client', 'model', 'prompt', 'cwd'],
  properties: {
    client: { type: 'string', minLength: 1, maxLength: 120 },
    provider: { type: 'string', minLength: 1, maxLength: 200 },
    model: { type: 'string', minLength: 1, maxLength: 512 },
    mode: { type: 'string', enum: ['native', 'gateway'] },
    prompt: { type: 'string', minLength: 1, maxLength: 4_000_000 },
    cwd: { type: 'string', minLength: 1, maxLength: 4_096 },
    resumeSessionId: { type: 'string', minLength: 1, maxLength: 1_024 },
    thinking: { type: 'string', minLength: 1, maxLength: 128 },
    features: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execSnapshotSchema = {
  type: 'object',
  required: ['id', 'client', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    client: { type: 'string', minLength: 1, maxLength: 120 },
    status: { type: 'string', enum: EXEC_STATUS_VALUES },
    createdAt: { type: 'number', minimum: 0 },
    finishedAt: { type: 'number', minimum: 0 },
    exitCode: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    error: { type: 'string', maxLength: 4_000 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execStartResultSchema = {
  type: 'object',
  required: ['execution'],
  properties: { execution: execSnapshotSchema },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execGetParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 200 } },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execGetResultSchema = execStartResultSchema

export const execEventsParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    afterSeq: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execEventsResultSchema = {
  type: 'object',
  required: ['events', 'nextSeq'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'seq', 'event'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          seq: { type: 'integer', minimum: 1 },
          event: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
    nextSeq: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const execCancelParamsSchema = execGetParamsSchema

export const execCancelResultSchema = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: EXEC_STATUS_VALUES },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
