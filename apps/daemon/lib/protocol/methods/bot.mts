import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'


export type {
  BotState,
  BotMode,
  BotItemState,
  BotModel,
  BotRecord,
  BotAcceptanceCheck,
  BotItemRecord,
  BotLogRecord,
  BotTickLag,
  BotHealthError,
  BotHostMode,
  BotHealthHost,
  BotComponentId,
  BotComponentState,
  BotHealthComponent,
  BotLoad,
  BotHealth,
  BotControlAction,
  BotItemAction,
  BotListParams,
  BotListResult,
  BotCreateParams,
  BotCreateResult,
  BotUpdateParams,
  BotUpdateResult,
  BotControlParams,
  BotControlResult,
  BotDeleteParams,
  BotDeleteResult,
  BotTickParams,
  BotTickResult,
  BotConfigValidateParams,
  BotConfigValidateResult,
  BotItemsParams,
  BotItemsResult,
  BotItemGetParams,
  BotItemGetResult,
  BotItemActionParams,
  BotItemActionResult,
  BotLogParams,
  BotLogResult,
  BotHealthParams,
  BotHealthResult,
} from '@wrenyard/protocol/bot'

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
