import type { LedgerEvent, SessionSummary } from '@wrenyard/session-v2'
import type { JsonSchema } from '../jsonrpc.mts'

export type SessionV2ListParams = Record<string, never>
export interface SessionV2ListResult { sessions: SessionSummary[] }
export type SessionV2CreateParams = Record<string, never>
export interface SessionV2CreateResult { sessionId: string }
export interface SessionV2SendParams {
  sessionId: string
  text: string
  model: { provider: string; model: string; reasoningEffort?: string }
}
export interface SessionV2SendResult { turn: number }
export interface SessionV2InterruptParams { sessionId: string; turn: number }
export type SessionV2InterruptResult = Record<string, never>
export interface SessionV2EventsParams {
  sessionId: string
  afterSeq: number
  limit?: number
  waitMs?: number
}
export interface SessionV2EventsResult { events: LedgerEvent[]; lastSeq: number }

const idSchema = { type: 'string', minLength: 1 } as const
const turnSchema = { type: 'integer', minimum: 1 } as const
const seqSchema = { type: 'integer', minimum: 0 } as const
const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema

export const sessionV2ListParamsSchema = emptySchema
export const sessionV2CreateParamsSchema = emptySchema
export const sessionV2InterruptResultSchema = emptySchema
export const sessionV2ListResultSchema = {
  type: 'object', required: ['sessions'], additionalProperties: false,
  properties: { sessions: { type: 'array', items: { type: 'object' } } },
} as const satisfies JsonSchema
export const sessionV2CreateResultSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionV2SendParamsSchema = {
  type: 'object', required: ['sessionId', 'text', 'model'], additionalProperties: false,
  properties: {
    sessionId: idSchema,
    text: { type: 'string' },
    model: {
      type: 'object', required: ['provider', 'model'], additionalProperties: false,
      properties: { provider: idSchema, model: idSchema, reasoningEffort: idSchema },
    },
  },
} as const satisfies JsonSchema
export const sessionV2SendResultSchema = {
  type: 'object', required: ['turn'], additionalProperties: false,
  properties: { turn: turnSchema },
} as const satisfies JsonSchema
export const sessionV2InterruptParamsSchema = {
  type: 'object', required: ['sessionId', 'turn'], additionalProperties: false,
  properties: { sessionId: idSchema, turn: turnSchema },
} as const satisfies JsonSchema
export const sessionV2EventsParamsSchema = {
  type: 'object', required: ['sessionId', 'afterSeq'], additionalProperties: false,
  properties: {
    sessionId: idSchema, afterSeq: seqSchema,
    limit: { type: 'integer', minimum: 1 },
    waitMs: { type: 'integer', minimum: 0, maximum: 1000 },
  },
} as const satisfies JsonSchema
export const sessionV2EventsResultSchema = {
  type: 'object', required: ['events', 'lastSeq'], additionalProperties: false,
  properties: {
    events: { type: 'array', items: { type: 'object' } }, lastSeq: seqSchema,
  },
} as const satisfies JsonSchema
