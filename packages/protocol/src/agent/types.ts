import type { LedgerEvent, LiveCall } from '../session/ledger.ts'
import type { JsonSchema } from '../common/jsonrpc'

interface SessionEventsResult {
  events: LedgerEvent[]
  lastSeq: number
  live?: LiveCall[]
}

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
