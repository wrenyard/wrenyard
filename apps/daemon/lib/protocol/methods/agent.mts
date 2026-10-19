import type { JsonSchema } from '../jsonrpc.mts'
import type { SessionEventsResult } from './session.mts'
import { sessionEventsResultSchema } from './session.mts'

// Canonical `agent.*` wire surface for the daemon's bot agents: LLM agents
// assembled from a per-bot JSON config, woken by chat input, routines, watched
// sessions or messages from other bots. Every DTO and runtime JSON schema for
// the agent surface lives here, exactly like the `routine.*` surface.

/** Where a bot definition lives. */
export type AgentBotLocation = 'workspace' | 'device'

/** One file of a bot's memory directory. */
export interface AgentMemoryFile {
  name: string
  size: number
  updatedAt: string
}

/** One bot agent as presented to Desktop. */
export interface AgentBotSummary {
  id: string
  name: string
  icon?: string
  description?: string
  enabled: boolean
  status: 'idle' | 'running' | 'error' | 'disabled'
  error?: string
  location: AgentBotLocation
  primary: boolean
  /** The bot definition directory. */
  directory: string
  tools: string[]
  lastWakeAt?: string
  queued: number
  sessionId?: string
  warning?: string
}

/** Bot ids are lowercase slugs, 1..32 characters. */
const BOT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$'
const botIdSchema = { type: 'string', pattern: BOT_ID_PATTERN } as const
const locationSchema = { type: 'string', enum: ['workspace', 'device'] } as const

const agentMemoryFileSchema = {
  type: 'object',
  required: ['name', 'size', 'updatedAt'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    size: { type: 'integer', minimum: 0 },
    updatedAt: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const agentBotSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'enabled', 'status', 'location', 'primary', 'directory', 'tools', 'queued'],
  additionalProperties: false,
  properties: {
    id: botIdSchema,
    name: { type: 'string', minLength: 1 },
    icon: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    status: { type: 'string', enum: ['idle', 'running', 'error', 'disabled'] },
    error: { type: 'string', minLength: 1 },
    location: locationSchema,
    primary: { type: 'boolean' },
    directory: { type: 'string', minLength: 1 },
    tools: { type: 'array', items: { type: 'string', minLength: 1 } },
    lastWakeAt: { type: 'string', minLength: 1 },
    queued: { type: 'integer', minimum: 0 },
    sessionId: { type: 'string', minLength: 1 },
    warning: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

export type AgentListParams = Record<string, never>
export interface AgentListResult { bots: AgentBotSummary[] }

export interface AgentGetParams { id: string }
export interface AgentGetResult {
  bot: AgentBotSummary
  /** Raw `bot.json` text. */
  config: string
  /** Raw `identity.md` text. */
  identity: string
  /** Read-only listing of the bot's memory files. */
  memory: AgentMemoryFile[]
}

export interface AgentCreateParams {
  id: string
  name: string
  icon?: string
  /** Defaults to `workspace`. */
  location?: AgentBotLocation
}
export interface AgentCreateResult { bot: AgentBotSummary }

export interface AgentMemoryListParams { id: string }
export interface AgentMemoryListResult { files: AgentMemoryFile[] }

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

/** One entry of the shared group transcript. */
export interface GroupMessage {
  seq: number
  at: string
  author: 'user' | 'bot'
  botId?: string
  name?: string
  text: string
}

export interface AgentGroupEventsParams {
  afterSeq: number
  limit?: number
}
export interface AgentGroupEventsResult {
  messages: GroupMessage[]
  lastSeq: number
}

export interface AgentGroupSendParams {
  /** 1..20000 characters; posted to the group exactly once. */
  text: string
}
export interface AgentGroupSendResult {
  message: GroupMessage
  awakened: string[]
}

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
  description: 'Read one bot agent with its raw bot.json and identity.md text.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: botIdSchema },
} as const satisfies JsonSchema
export const agentGetResultSchema = {
  description: 'The bot summary, its raw bot.json and identity.md, and its memory listing.',
  type: 'object', required: ['bot', 'config', 'identity', 'memory'], additionalProperties: false,
  properties: {
    bot: agentBotSummarySchema,
    config: { type: 'string' },
    identity: { type: 'string' },
    memory: { type: 'array', items: agentMemoryFileSchema },
  },
} as const satisfies JsonSchema

export const agentCreateParamsSchema = {
  description: 'Create one bot from the built-in onboard template.',
  type: 'object', required: ['id', 'name'], additionalProperties: false,
  properties: {
    id: botIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    icon: { type: 'string', minLength: 1, maxLength: 16 },
    location: { ...locationSchema, default: 'workspace' },
  },
} as const satisfies JsonSchema
export const agentCreateResultSchema = {
  description: 'The newly created bot agent.',
  type: 'object', required: ['bot'], additionalProperties: false,
  properties: { bot: agentBotSummarySchema },
} as const satisfies JsonSchema

export const agentMemoryListParamsSchema = {
  description: 'List the memory files of one bot without modifying them.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: botIdSchema },
} as const satisfies JsonSchema
export const agentMemoryListResultSchema = {
  description: 'The read-only memory listing of one bot.',
  type: 'object', required: ['files'], additionalProperties: false,
  properties: { files: { type: 'array', items: agentMemoryFileSchema } },
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

const groupMessageSchema = {
  type: 'object', required: ['seq', 'at', 'author', 'text'], additionalProperties: false,
  properties: {
    seq: { type: 'integer', minimum: 1 },
    at: { type: 'string', minLength: 1 },
    author: { type: 'string', enum: ['user', 'bot'] },
    botId: botIdSchema,
    name: { type: 'string', minLength: 1 },
    text: { type: 'string' },
  },
} as const satisfies JsonSchema

export const agentGroupEventsParamsSchema = {
  description: 'Read one bounded page of the shared group transcript after a sequence number.',
  type: 'object', required: ['afterSeq'], additionalProperties: false,
  properties: {
    afterSeq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
} as const satisfies JsonSchema
export const agentGroupEventsResultSchema = {
  description: 'The requested transcript page and the sequence of its last message.',
  type: 'object', required: ['messages', 'lastSeq'], additionalProperties: false,
  properties: {
    messages: { type: 'array', items: groupMessageSchema },
    lastSeq: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema

export const agentGroupSendParamsSchema = {
  description: 'Post one user message to the group; mentioned bots are woken.',
  type: 'object', required: ['text'], additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const satisfies JsonSchema
export const agentGroupSendResultSchema = {
  description: 'The posted group message and the enabled bots that were woken.',
  type: 'object', required: ['message', 'awakened'], additionalProperties: false,
  properties: {
    message: groupMessageSchema,
    awakened: { type: 'array', items: botIdSchema },
  },
} as const satisfies JsonSchema
