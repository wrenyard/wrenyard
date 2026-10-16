import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'

// Canonical `bot.*` wire surface for the daemon's Bot mode feature: autonomous
// dispatcher bots that poll a user-local inbox, drive one session and worktree
// per item, run acceptance and deliver one item at a time. Every DTO and
// runtime JSON schema for bots lives here, exactly like the `schedule.*`
// surface.

/** Lifecycle of one bot. */
export type BotState = 'running' | 'paused' | 'stopped'

/** `live` performs merge/push/complete/notify; `dryRun` only records them. */
export type BotMode = 'live' | 'dryRun'

/**
 * One item's lifecycle state. Mirrors `BOT_ITEM_STATES` in
 * `daemon/services/bot/machine.mts`, which owns the authoritative transition
 * rules.
 */
export type BotItemState =
  | 'discovered'
  | 'verifying'
  | 'verified'
  | 'dispatched'
  | 'in_progress'
  | 'ready'
  | 'accepting'
  | 'accepted'
  | 'rejected'
  | 'merging'
  | 'merged'
  | 'completing'
  | 'completed'
  | 'dismissed'
  | 'parked'
  | 'failed'
  | 'withdrawn'

/** The model a bot dispatches with, taken from the routing policy. */
export interface BotModel {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
}

export interface BotRecord {
  /** 8 lowercase hex characters; unique among every stored bot. */
  id: string
  /** Workspace root that owns this bot; another workspace never lists it. */
  workspaceRoot: string
  name: string
  /** Path of the bot's user-local config file, when one is bound. */
  configPath?: string
  /** Content hash of the config file observed at the last load. */
  configHash?: string
  state: BotState
  mode: BotMode
  /** ISO timestamp of the last completed tick. */
  lastTickAt?: string
  /** ISO timestamp of the next due inbox poll. */
  nextPollAt?: string
  createdAt: string
  updatedAt: string
}

/** One acceptance check recorded for an item. */
export interface BotAcceptanceCheck {
  claim: string
  method: string
  status: 'verified' | 'failed' | 'not_verified'
  evidence?: string[]
  note?: string
}

export interface BotItemRecord {
  id: string
  botId: string
  /** Id of the source item in the user's inbox adapter. */
  sourceId: string
  /** Bumped when a terminal source item is seen again with a new fingerprint. */
  generation: number
  /** Hash of the source title + notes, used to detect a changed request. */
  fingerprint?: string
  title?: string
  body?: string
  project?: string
  class?: string
  state: BotItemState
  /** The state a parked item resumes into. */
  parkedFrom?: BotItemState
  /** The precise question an item is parked on. */
  question?: string
  /** The user's answer, appended to the item context on resume. */
  answer?: string
  sessionId?: string
  sessionModel?: BotModel
  worktreeId?: string
  branch?: string
  headSha?: string
  mergedSha?: string
  acceptance?: BotAcceptanceCheck[]
  counters?: Record<string, number>
  error?: string
  dryRun: boolean
  createdAt: string
  updatedAt: string
}

export interface BotLogRecord {
  seq: number
  botId: string
  itemId?: string
  /** ISO timestamp of the entry. */
  at: string
  level: string
  code?: string
  message: string
}

/** Last and worst delay between a scheduled tick and its actual start. */
export interface BotTickLag {
  last: number
  max: number
}

export interface BotHealthError {
  at: string
  code: string
  message: string
}

/** `installed` when the daemon runs from the bundled suite; `source` otherwise. */
export type BotHostMode = 'installed' | 'source'

/**
 * The device and daemon a bot runs on. `daemonVersion`/`mode` come from the same
 * identity `health.ping` reports; the Bot page shows this so a user can tell
 * which daemon/device owns the bot.
 */
export interface BotHealthHost {
  hostname: string
  platform: string
  arch: string
  daemonVersion?: string
  mode: BotHostMode
}

/** The managed operation components a bot's acceptance may require. */
export type BotComponentId = 'browser' | 'desktop'

export type BotComponentState =
  | 'not-installed'
  | 'installing'
  | 'needs-authorization'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'disabled'

/** One operation component's current state, mirrored from `components.list`. */
export interface BotHealthComponent {
  id: BotComponentId
  state: BotComponentState
}

/**
 * Live daemon execution load observed at the last tick. `backedOff` is the
 * current dispatch state, so the Bot page can show whether the bot is holding
 * new work because the daemon is loaded.
 */
export interface BotLoad {
  activeExecutions: number
  maxExecutions: number
  queuedExecutions: number
  /** How long the oldest queued execution has waited, when any is queued. */
  oldestQueuedMs?: number
  backedOff: boolean
}

/**
 * Durable endurance numbers for one bot. The 24h counters are computed from
 * `bot_step` and `bot_log`, so they stay correct across daemon restarts.
 */
export interface BotHealth {
  lowDisk: { status: 'ok' | 'low' | 'unavailable'; availableBytes: number | null; minimumBytes: number; error: string | null }
  /** ISO timestamp the host started serving this bot. */
  uptimeSince: string
  /** Cadence (timer) passes only, so the number tracks the configured cadence. */
  ticks: number
  /** Passes an explicit `bot.tick` asked for; never counted as cadence ticks. */
  forcedTicks: number
  lastTickAt?: string
  tickLagMs: BotTickLag
  itemsByState: Record<string, number>
  stepsFailed24h: number
  adapterErrors24h: number
  escalations24h: number
  lastError?: BotHealthError
  /** Device and daemon the bot runs on. */
  host: BotHealthHost
  /** Operation component states; empty when the service is absent or fails. */
  components: BotHealthComponent[]
  /** Live daemon load from the last tick, and whether new work is backed off. */
  load: BotLoad
}

export type BotControlAction = 'start' | 'pause' | 'resume' | 'stop'
export type BotItemAction = 'retry' | 'dismiss' | 'answer' | 'cleanup'

export type BotListParams = Record<string, never>
export interface BotListResult { bots: BotRecord[] }

export interface BotCreateParams {
  name: string
  configPath: string
  mode?: BotMode
}
export interface BotCreateResult { bot: BotRecord }

export interface BotUpdateParams {
  botId: string
  name?: string
  configPath?: string
  mode?: BotMode
}
export interface BotUpdateResult { bot: BotRecord }

export interface BotControlParams { botId: string; action: BotControlAction }
export interface BotControlResult { bot: BotRecord }

export interface BotDeleteParams { botId: string }
export interface BotDeleteResult { deleted: true }

export interface BotTickParams { botId: string }
export interface BotTickResult { ticked: true }

export interface BotConfigValidateParams { configPath: string }
export interface BotConfigValidateResult {
  valid: boolean
  name?: string
  error?: string
}

export interface BotItemsParams { botId: string; state?: BotItemState }
export interface BotItemsResult { items: BotItemRecord[] }

export interface BotItemGetParams { botId: string; itemId: string }
export interface BotItemGetResult { item: BotItemRecord }

export interface BotItemActionParams {
  botId: string
  itemId: string
  action: BotItemAction
  answer?: string
}
export interface BotItemActionResult { item: BotItemRecord }

export interface BotLogParams { botId: string; afterSeq: number; limit?: number }
export interface BotLogResult { entries: BotLogRecord[] }

export interface BotHealthParams { botId: string }
export type BotHealthResult = BotHealth

const idSchema = { type: 'string', minLength: 1 } as const
/** A bot id is exactly eight lowercase hex characters. */
const botIdSchema = { type: 'string', pattern: '^[0-9a-f]{8}$' } as const
const reasoningEffortSchema = { type: 'string', enum: REASONING_EFFORTS } as const
const botStateSchema = { type: 'string', enum: ['running', 'paused', 'stopped'] } as const
const botModeSchema = { type: 'string', enum: ['live', 'dryRun'] } as const
const itemStateSchema = {
  type: 'string',
  enum: [
    'discovered', 'verifying', 'verified', 'dispatched', 'in_progress', 'ready',
    'accepting', 'accepted', 'rejected', 'merging', 'merged', 'completing',
    'completed', 'dismissed', 'parked', 'failed', 'withdrawn',
  ],
} as const
const botModelSchema = {
  type: 'object', required: ['provider', 'model', 'reasoningEffort'], additionalProperties: false,
  properties: { provider: idSchema, model: idSchema, reasoningEffort: reasoningEffortSchema },
} as const satisfies JsonSchema

const botRecordSchema = {
  type: 'object',
  required: ['id', 'workspaceRoot', 'name', 'state', 'mode', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: botIdSchema,
    workspaceRoot: idSchema,
    name: { type: 'string', minLength: 1 },
    configPath: { type: 'string', minLength: 1 },
    configHash: { type: 'string', minLength: 1 },
    state: botStateSchema,
    mode: botModeSchema,
    lastTickAt: { type: 'string', minLength: 1 },
    nextPollAt: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', minLength: 1 },
    updatedAt: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const acceptanceCheckSchema = {
  type: 'object',
  required: ['claim', 'method', 'status'],
  additionalProperties: false,
  properties: {
    claim: { type: 'string', minLength: 1 },
    method: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['verified', 'failed', 'not_verified'] },
    evidence: { type: 'array', items: idSchema },
    note: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const botItemSchema = {
  type: 'object',
  required: ['id', 'botId', 'sourceId', 'generation', 'state', 'dryRun', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: idSchema,
    botId: botIdSchema,
    sourceId: idSchema,
    generation: { type: 'integer', minimum: 1 },
    fingerprint: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    project: { type: 'string', minLength: 1 },
    class: { type: 'string', minLength: 1 },
    state: itemStateSchema,
    parkedFrom: itemStateSchema,
    question: { type: 'string', minLength: 1 },
    answer: { type: 'string', minLength: 1 },
    sessionId: idSchema,
    sessionModel: botModelSchema,
    worktreeId: idSchema,
    branch: { type: 'string', minLength: 1 },
    headSha: { type: 'string', minLength: 1 },
    mergedSha: { type: 'string', minLength: 1 },
    acceptance: { type: 'array', items: acceptanceCheckSchema },
    counters: { type: 'object' },
    error: { type: 'string', minLength: 1 },
    dryRun: { type: 'boolean' },
    createdAt: { type: 'string', minLength: 1 },
    updatedAt: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const botLogEntrySchema = {
  type: 'object',
  required: ['seq', 'botId', 'at', 'level', 'message'],
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', minimum: 0 },
    botId: botIdSchema,
    itemId: idSchema,
    at: { type: 'string', minLength: 1 },
    level: { type: 'string', minLength: 1 },
    code: { type: 'string', minLength: 1 },
    message: { type: 'string' },
  },
} as const satisfies JsonSchema

const botHealthHostSchema = {
  type: 'object', required: ['hostname', 'platform', 'arch', 'mode'], additionalProperties: false,
  properties: {
    hostname: { type: 'string', minLength: 1 },
    platform: { type: 'string', minLength: 1 },
    arch: { type: 'string', minLength: 1 },
    daemonVersion: { type: 'string', minLength: 1 },
    mode: { type: 'string', enum: ['installed', 'source'] },
  },
} as const satisfies JsonSchema

const botHealthComponentSchema = {
  type: 'object', required: ['id', 'state'], additionalProperties: false,
  properties: {
    id: { type: 'string', enum: ['browser', 'desktop'] },
    state: {
      type: 'string',
      enum: ['not-installed', 'installing', 'needs-authorization', 'ready', 'failed', 'unsupported', 'disabled'],
    },
  },
} as const satisfies JsonSchema

const botLoadSchema = {
  type: 'object',
  required: ['activeExecutions', 'maxExecutions', 'queuedExecutions', 'backedOff'],
  additionalProperties: false,
  properties: {
    activeExecutions: { type: 'integer', minimum: 0 },
    maxExecutions: { type: 'integer', minimum: 0 },
    queuedExecutions: { type: 'integer', minimum: 0 },
    oldestQueuedMs: { type: 'number', minimum: 0 },
    backedOff: { type: 'boolean' },
  },
} as const satisfies JsonSchema

const botHealthSchema = {
  type: 'object',
  required: [
    'uptimeSince', 'ticks', 'forcedTicks', 'tickLagMs', 'itemsByState',
    'stepsFailed24h', 'adapterErrors24h', 'escalations24h',
    'host', 'components', 'load',
    'lowDisk',
  ],
  additionalProperties: false,
  properties: {
    uptimeSince: { type: 'string', minLength: 1 },
    ticks: { type: 'integer', minimum: 0 },
    forcedTicks: { type: 'integer', minimum: 0 },
    lastTickAt: { type: 'string', minLength: 1 },
    tickLagMs: {
      type: 'object', required: ['last', 'max'], additionalProperties: false,
      properties: { last: { type: 'number', minimum: 0 }, max: { type: 'number', minimum: 0 } },
    },
    itemsByState: { type: 'object' },
    stepsFailed24h: { type: 'integer', minimum: 0 },
    adapterErrors24h: { type: 'integer', minimum: 0 },
    escalations24h: { type: 'integer', minimum: 0 },
    lastError: {
      type: 'object', required: ['at', 'code', 'message'], additionalProperties: false,
      properties: {
        at: { type: 'string', minLength: 1 },
        code: { type: 'string', minLength: 1 },
        message: { type: 'string' },
      },
    },
    host: botHealthHostSchema,
    components: { type: 'array', items: botHealthComponentSchema },
    load: botLoadSchema,
    lowDisk: { type: 'object', required: ['status', 'availableBytes', 'minimumBytes', 'error'], properties: { status: { type: 'string', enum: ['ok', 'low', 'unavailable'] }, availableBytes: { type: ['integer', 'null'], minimum: 0 }, minimumBytes: { type: 'integer', minimum: 0 }, error: { type: ['string', 'null'] } }, additionalProperties: false },
  },
} as const satisfies JsonSchema

export const botListParamsSchema = {
  description: 'List this workspace\'s bots.',
  type: 'object', additionalProperties: false,
  properties: {},
} as const satisfies JsonSchema
export const botListResultSchema = {
  description: 'Every bot owned by the active workspace, newest first.',
  type: 'object', required: ['bots'], additionalProperties: false,
  properties: { bots: { type: 'array', items: botRecordSchema } },
} as const satisfies JsonSchema

export const botCreateParamsSchema = {
  description: 'Create one bot bound to a user-local config file.',
  type: 'object', required: ['name', 'configPath'], additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    configPath: { type: 'string', minLength: 1 },
    mode: botModeSchema,
  },
} as const satisfies JsonSchema
export const botCreateResultSchema = {
  description: 'The created bot, in the stopped state.',
  type: 'object', required: ['bot'], additionalProperties: false,
  properties: { bot: botRecordSchema },
} as const satisfies JsonSchema

export const botUpdateParamsSchema = {
  description: 'Update one bot\'s name, config file or mode.',
  type: 'object', required: ['botId'], additionalProperties: false,
  properties: {
    botId: botIdSchema,
    name: { type: 'string', minLength: 1 },
    configPath: { type: 'string', minLength: 1 },
    mode: botModeSchema,
  },
} as const satisfies JsonSchema
export const botUpdateResultSchema = {
  description: 'The updated bot.',
  type: 'object', required: ['bot'], additionalProperties: false,
  properties: { bot: botRecordSchema },
} as const satisfies JsonSchema

export const botControlParamsSchema = {
  description: 'Start, pause, resume or stop one bot.',
  type: 'object', required: ['botId', 'action'], additionalProperties: false,
  properties: {
    botId: botIdSchema,
    action: { type: 'string', enum: ['start', 'pause', 'resume', 'stop'] },
  },
} as const satisfies JsonSchema
export const botControlResultSchema = {
  description: 'The bot after the control action.',
  type: 'object', required: ['bot'], additionalProperties: false,
  properties: { bot: botRecordSchema },
} as const satisfies JsonSchema

export const botDeleteParamsSchema = {
  description: 'Delete one bot. Only a stopped bot can be deleted.',
  type: 'object', required: ['botId'], additionalProperties: false,
  properties: { botId: botIdSchema },
} as const satisfies JsonSchema
export const botDeleteResultSchema = {
  description: 'Confirms the bot was deleted.',
  type: 'object', required: ['deleted'], additionalProperties: false,
  properties: { deleted: { const: true } },
} as const satisfies JsonSchema

export const botTickParamsSchema = {
  description: 'Run one bot tick now instead of waiting for the cadence.',
  type: 'object', required: ['botId'], additionalProperties: false,
  properties: { botId: botIdSchema },
} as const satisfies JsonSchema
export const botTickResultSchema = {
  description: 'Confirms a tick was run.',
  type: 'object', required: ['ticked'], additionalProperties: false,
  properties: { ticked: { const: true } },
} as const satisfies JsonSchema

export const botConfigValidateParamsSchema = {
  description: 'Validate one bot config file.',
  type: 'object', required: ['configPath'], additionalProperties: false,
  properties: { configPath: { type: 'string', minLength: 1 } },
} as const satisfies JsonSchema
export const botConfigValidateResultSchema = {
  description: 'Validation outcome for one config file, never a thrown error.',
  type: 'object', required: ['valid'], additionalProperties: false,
  properties: {
    valid: { type: 'boolean' },
    name: { type: 'string', minLength: 1 },
    error: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

export const botItemsParamsSchema = {
  description: 'List one bot\'s items, optionally limited to a single state.',
  type: 'object', required: ['botId'], additionalProperties: false,
  properties: { botId: botIdSchema, state: itemStateSchema },
} as const satisfies JsonSchema
export const botItemsResultSchema = {
  description: 'Matching items, newest first.',
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', items: botItemSchema } },
} as const satisfies JsonSchema

export const botItemGetParamsSchema = {
  description: 'Read one bot item by id.',
  type: 'object', required: ['botId', 'itemId'], additionalProperties: false,
  properties: { botId: botIdSchema, itemId: idSchema },
} as const satisfies JsonSchema
export const botItemGetResultSchema = {
  description: 'The requested item.',
  type: 'object', required: ['item'], additionalProperties: false,
  properties: { item: botItemSchema },
} as const satisfies JsonSchema

export const botItemActionParamsSchema = {
  description: 'Retry, dismiss, answer or clean up one parked or failed item.',
  type: 'object', required: ['botId', 'itemId', 'action'], additionalProperties: false,
  properties: {
    botId: botIdSchema,
    itemId: idSchema,
    action: { type: 'string', enum: ['retry', 'dismiss', 'answer', 'cleanup'] },
    answer: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema
export const botItemActionResultSchema = {
  description: 'The item after the action.',
  type: 'object', required: ['item'], additionalProperties: false,
  properties: { item: botItemSchema },
} as const satisfies JsonSchema

export const botLogParamsSchema = {
  description: 'Read one bot\'s log entries after a cursor.',
  type: 'object', required: ['botId', 'afterSeq'], additionalProperties: false,
  properties: {
    botId: botIdSchema,
    afterSeq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
} as const satisfies JsonSchema
export const botLogResultSchema = {
  description: 'Log entries with seq greater than afterSeq, oldest first.',
  type: 'object', required: ['entries'], additionalProperties: false,
  properties: { entries: { type: 'array', items: botLogEntrySchema } },
} as const satisfies JsonSchema

export const botHealthParamsSchema = {
  description: 'Read one bot\'s endurance and health counters.',
  type: 'object', required: ['botId'], additionalProperties: false,
  properties: { botId: botIdSchema },
} as const satisfies JsonSchema
export const botHealthResultSchema = {
  description: 'The bot host health snapshot for one bot.',
  ...botHealthSchema,
} as const satisfies JsonSchema
