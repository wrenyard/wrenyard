import type { LedgerEvent, LiveCall, SessionSummary, SummarySettingsSnapshot } from '@wrenyard/session'
import type { JsonSchema } from '../jsonrpc.mts'

// The context-inspection DTOs are declared once in `@wrenyard/protocol` and
// re-exported here so every existing daemon import path keeps working, exactly
// like the provider/exec wire types. The runtime JSON schemas stay daemon-owned.
export type {
  SessionContextInspectParams,
  SessionContextInspectResult,
  ContextInspection,
} from '@wrenyard/protocol'

// Canonical `session.*` ledger wire surface. Every DTO and runtime JSON schema
// for the append-only session timeline lives here; the daemon validates session
// params/results against these schemas and nothing else.
export type SessionListParams = Record<string, never>
export interface SessionListResult { sessions: SessionSummary[] }
export type SessionCreateParams = Record<string, never>
export interface SessionCreateResult { sessionId: string }
export interface SessionSendParams {
  sessionId: string
  text: string
  model: { provider: string; model: string; reasoningEffort?: string }
}
export interface SessionSendResult { turn: number }
export interface SessionInterruptParams { sessionId: string; turn: number }
export type SessionInterruptResult = Record<string, never>
export interface SessionEventsParams {
  sessionId: string
  afterSeq: number
  limit?: number
  waitMs?: number
  /** When true, the result also carries the current live streaming snapshot. */
  live?: boolean
}
export interface SessionEventsResult {
  events: LedgerEvent[]
  lastSeq: number
  /** Complete current live-call snapshot; present only when `live` was requested. */
  live?: LiveCall[]
}
export type SessionSummarySettingsParams = Record<string, never>
export type SessionSummarySettingsResult = SummarySettingsSnapshot
export interface SessionSummarySaveParams { canonicalModel: string }
export type SessionSummarySaveResult = SummarySettingsSnapshot

const idSchema = { type: 'string', minLength: 1 } as const
const turnSchema = { type: 'integer', minimum: 1 } as const
const seqSchema = { type: 'integer', minimum: 0 } as const
const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema

const summaryModelOptionSchema = {
  type: 'object',
  required: ['canonicalModel', 'displayName', 'available'],
  properties: {
    canonicalModel: { type: 'string', minLength: 1 },
    publicId: { type: 'string' },
    displayName: { type: 'string' },
    providerLabel: { type: 'string' },
    available: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const summarySettingsSchema = {
  type: 'object',
  required: ['selectedCanonicalModel', 'options', 'unresolved'],
  properties: {
    selectedCanonicalModel: { type: 'string' },
    options: { type: 'array', items: summaryModelOptionSchema },
    unresolved: { type: 'boolean' },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionListParamsSchema = emptySchema
export const sessionCreateParamsSchema = emptySchema
export const sessionInterruptResultSchema = emptySchema
export const sessionSummarySettingsParamsSchema = emptySchema
export const sessionListResultSchema = {
  type: 'object', required: ['sessions'], additionalProperties: false,
  properties: { sessions: { type: 'array', items: { type: 'object' } } },
} as const satisfies JsonSchema
export const sessionCreateResultSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionSendParamsSchema = {
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
export const sessionSendResultSchema = {
  type: 'object', required: ['turn'], additionalProperties: false,
  properties: { turn: turnSchema },
} as const satisfies JsonSchema
export const sessionInterruptParamsSchema = {
  type: 'object', required: ['sessionId', 'turn'], additionalProperties: false,
  properties: { sessionId: idSchema, turn: turnSchema },
} as const satisfies JsonSchema
export const sessionEventsParamsSchema = {
  type: 'object', required: ['sessionId', 'afterSeq'], additionalProperties: false,
  properties: {
    sessionId: idSchema, afterSeq: seqSchema,
    limit: { type: 'integer', minimum: 1 },
    waitMs: { type: 'integer', minimum: 0, maximum: 1000 },
    live: { type: 'boolean' },
  },
} as const satisfies JsonSchema
export const sessionEventsResultSchema = {
  type: 'object', required: ['events', 'lastSeq'], additionalProperties: false,
  properties: {
    events: { type: 'array', items: { type: 'object' } }, lastSeq: seqSchema,
    live: { type: 'array', items: { type: 'object' } },
  },
} as const satisfies JsonSchema
export const sessionSummarySettingsResultSchema = summarySettingsSchema
export const sessionSummarySaveParamsSchema = {
  type: 'object', required: ['canonicalModel'], additionalProperties: false,
  properties: { canonicalModel: { type: 'string', minLength: 1, maxLength: 512 } },
} as const satisfies JsonSchema
export const sessionSummarySaveResultSchema = summarySettingsSchema

const contextLayerIdSchema = {
  type: 'string',
  enum: ['wy-system', 'wy-global', 'wy-role', 'wy-workspace', 'wy-ctx', 'wy-info'],
} as const

export const sessionContextInspectParamsSchema = {
  type: 'object', required: ['model'], additionalProperties: false,
  properties: { sessionId: idSchema, model: idSchema },
} as const satisfies JsonSchema
export const sessionContextInspectResultSchema = {
  type: 'object',
  required: ['computedAtSeq', 'estimator', 'model', 'layers', 'items', 'totalTokens'],
  additionalProperties: false,
  properties: {
    computedAtSeq: seqSchema,
    estimator: { type: 'string', enum: ['cl100k_base'] },
    model: {
      type: 'object', required: ['publicId'], additionalProperties: false,
      properties: {
        publicId: idSchema,
        contextWindow: { type: 'integer', minimum: 1 },
        maxOutputTokens: { type: 'integer', minimum: 1 },
      },
    },
    layers: {
      type: 'array', items: {
        type: 'object', required: ['id', 'tokens'], additionalProperties: false,
        properties: { id: contextLayerIdSchema, tokens: { type: 'integer', minimum: 0 } },
      },
    },
    items: {
      type: 'array', items: {
        type: 'object', required: ['seq', 'turn', 'kind', 'label', 'tokens'], additionalProperties: false,
        properties: {
          seq: seqSchema,
          turn: seqSchema,
          cycle: { type: 'integer', minimum: 0 },
          kind: {
            type: 'string',
            enum: ['user', 'assistant', 'reply', 'doc', 'memory', 'action-result', 'ws-update', 'interrupt'],
          },
          label: { type: 'string' },
          tokens: { type: 'integer', minimum: 0 },
        },
      },
    },
    totalTokens: { type: 'integer', minimum: 0 },
    calibration: {
      type: 'object', required: ['callId', 'model', 'estimated', 'actual'], additionalProperties: false,
      properties: {
        callId: idSchema,
        model: idSchema,
        estimated: { type: 'integer', minimum: 0 },
        actual: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const satisfies JsonSchema
