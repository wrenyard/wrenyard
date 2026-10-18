import type { JsonSchema } from '../jsonrpc.mts'
import type { SessionEventsResult } from './session.mts'
import { sessionEventsResultSchema } from './session.mts'

// Canonical `agent.*` wire surface for the daemon's bot agents: LLM agents
// assembled from a per-bot JSON config, woken by chat input, routines, watched
// sessions or messages from other bots. Every DTO and runtime JSON schema for
// the agent surface lives here, exactly like the `routine.*` surface.

/** One bot agent as presented to Desktop. */
export interface AgentBotSummary {
  id: string
  name: string
  enabled: boolean
  status: 'idle' | 'running' | 'error' | 'disabled'
  error?: string
  configPath: string
  tools: string[]
  lastWakeAt?: string
  queued: number
  sessionId?: string
}

/** Bot ids are lowercase slugs, 1..32 characters. */
const BOT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$'
const botIdSchema = { type: 'string', pattern: BOT_ID_PATTERN } as const

const agentBotSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'enabled', 'status', 'configPath', 'tools', 'queued'],
  additionalProperties: false,
  properties: {
    id: botIdSchema,
    name: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    status: { type: 'string', enum: ['idle', 'running', 'error', 'disabled'] },
    error: { type: 'string', minLength: 1 },
    configPath: { type: 'string', minLength: 1 },
    tools: { type: 'array', items: { type: 'string', minLength: 1 } },
    lastWakeAt: { type: 'string', minLength: 1 },
    queued: { type: 'integer', minimum: 0 },
    sessionId: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

export type AgentListParams = Record<string, never>
export interface AgentListResult { bots: AgentBotSummary[] }

export interface AgentGetParams { id: string }
export interface AgentGetResult { bot: AgentBotSummary; config: string }

export interface AgentEventsParams {
  id: string
  afterSeq: number
  limit?: number
}
export type AgentEventsResult = SessionEventsResult

export interface AgentWakeParams {
  id: string
  /** 1..20000 characters; queued verbatim as a user wake. */
  text: string
}
export interface AgentWakeResult { queued: number }

const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema

export const agentListParamsSchema = {
  description: 'List every configured bot agent.',
  ...emptySchema,
} as const satisfies JsonSchema
export const agentListResultSchema = {
  description: 'Every bot agent of the active workspace, sorted by id.',
  type: 'object', required: ['bots'], additionalProperties: false,
  properties: { bots: { type: 'array', items: agentBotSummarySchema } },
} as const satisfies JsonSchema

export const agentGetParamsSchema = {
  description: 'Read one bot agent and its raw config file text.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: botIdSchema },
} as const satisfies JsonSchema
export const agentGetResultSchema = {
  description: 'The bot agent summary plus the raw JSON text of its config file.',
  type: 'object', required: ['bot', 'config'], additionalProperties: false,
  properties: { bot: agentBotSummarySchema, config: { type: 'string' } },
} as const satisfies JsonSchema

export const agentEventsParamsSchema = {
  description: 'Read one bot context ledger page, identical in shape to session.events without long-poll.',
  type: 'object', required: ['id', 'afterSeq'], additionalProperties: false,
  properties: {
    id: botIdSchema,
    afterSeq: { type: 'integer', minimum: 0 },
    // One page: 500 events unless the caller asks for more, 1000 at most.
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
  },
} as const satisfies JsonSchema
export const agentEventsResultSchema = sessionEventsResultSchema

export const agentWakeParamsSchema = {
  description: 'Queue one user wake for a bot agent.',
  type: 'object', required: ['id', 'text'], additionalProperties: false,
  properties: {
    id: botIdSchema,
    text: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const satisfies JsonSchema
export const agentWakeResultSchema = {
  description: 'The bot wake queue length including any in-flight wake.',
  type: 'object', required: ['queued'], additionalProperties: false,
  properties: { queued: { type: 'integer', minimum: 0 } },
} as const satisfies JsonSchema
