import type { JsonSchema } from '../jsonrpc.mts'

// Canonical `routine.*` wire surface for the daemon's bot routines. A routine
// belongs to a bot: when it becomes due it wakes its owning bot agent with the
// routine prompt instead of sending into a session. Every DTO and runtime JSON
// schema for routines lives here, exactly like the `session.*` surface.

/** Bot ids are lowercase slugs, 1..32 characters. */
const BOT_ID_SOURCE = '[a-z0-9][a-z0-9-]{0,31}'
const BOT_ID_PATTERN = `^${BOT_ID_SOURCE}$`

/** Lifecycle of one routine. */
export type RoutineState = 'active' | 'paused'

export interface RoutineRecord {
  /** 8 lowercase hex characters; unique among every stored routine. */
  id: string
  /** The bot this routine wakes when it fires. */
  botId: string
  /** Optional short name from the routine file. */
  name?: string
  /** 1..4000 characters; used verbatim as the wake text when it fires. */
  prompt: string
  /** Whole minutes between runs; 1..10080 (7 days). */
  intervalMinutes: number
  state: RoutineState
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the next due run; absent while paused. */
  nextRunAt?: string
  /** ISO timestamp of the most recent successful run. */
  lastRunAt?: string
  /** Message of the most recent failure. */
  lastError?: string
  /** Number of successful runs. */
  runCount: number
}

export interface RoutineListParams { botId?: string }
export interface RoutineListResult { routines: RoutineRecord[] }
export interface RoutineCreateParams {
  botId: string
  prompt: string
  intervalMinutes: number
}
export interface RoutineCreateResult { routine: RoutineRecord }
export interface RoutineUpdateParams {
  id: string
  state: 'active' | 'paused'
}
export interface RoutineUpdateResult { routine: RoutineRecord }
export interface RoutineRunParams { id: string }
export interface RoutineRunResult { routine: RoutineRecord }
export interface RoutineDeleteParams { id: string }
export interface RoutineDeleteResult { deleted: true }

const idSchema = { type: 'string', minLength: 1 } as const
// A routine id is exactly eight lowercase hex characters.
const routineIdSchema = { type: 'string', pattern: '^[0-9a-f]{8}$' } as const
const botIdSchema = { type: 'string', pattern: BOT_ID_PATTERN } as const
const routineStateSchema = {
  type: 'string',
  enum: ['active', 'paused'],
} as const

const routineRecordSchema = {
  type: 'object',
  required: ['id', 'botId', 'prompt', 'intervalMinutes', 'state', 'createdAt', 'runCount'],
  additionalProperties: false,
  properties: {
    id: routineIdSchema,
    botId: botIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 64 },
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    state: routineStateSchema,
    createdAt: { type: 'string', minLength: 1 },
    nextRunAt: { type: 'string', minLength: 1 },
    lastRunAt: { type: 'string', minLength: 1 },
    lastError: { type: 'string', minLength: 1 },
    runCount: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema

export const routineListParamsSchema = {
  description: 'List routines, optionally limited to one bot.',
  type: 'object', additionalProperties: false,
  properties: { botId: botIdSchema },
} as const satisfies JsonSchema
export const routineListResultSchema = {
  description: 'All matching routines, newest first.',
  type: 'object', required: ['routines'], additionalProperties: false,
  properties: { routines: { type: 'array', items: routineRecordSchema } },
} as const satisfies JsonSchema

export const routineCreateParamsSchema = {
  description: 'Create one routine owned by a bot.',
  type: 'object', required: ['botId', 'prompt', 'intervalMinutes'], additionalProperties: false,
  properties: {
    botId: botIdSchema,
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
  },
} as const satisfies JsonSchema
export const routineCreateResultSchema = {
  description: 'The created routine.',
  type: 'object', required: ['routine'], additionalProperties: false,
  properties: { routine: routineRecordSchema },
} as const satisfies JsonSchema

export const routineUpdateParamsSchema = {
  description: 'Pause or resume one routine.',
  type: 'object', required: ['id', 'state'], additionalProperties: false,
  properties: {
    id: routineIdSchema,
    state: { type: 'string', enum: ['active', 'paused'] },
  },
} as const satisfies JsonSchema
export const routineUpdateResultSchema = {
  description: 'The updated routine.',
  type: 'object', required: ['routine'], additionalProperties: false,
  properties: { routine: routineRecordSchema },
} as const satisfies JsonSchema

export const routineRunParamsSchema = {
  description: 'Mark one routine due now so it wakes its bot on the next scheduler tick.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: routineIdSchema },
} as const satisfies JsonSchema
export const routineRunResultSchema = {
  description: 'The routine after it was marked due.',
  type: 'object', required: ['routine'], additionalProperties: false,
  properties: { routine: routineRecordSchema },
} as const satisfies JsonSchema

export const routineDeleteParamsSchema = {
  description: 'Delete one routine.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: routineIdSchema },
} as const satisfies JsonSchema
export const routineDeleteResultSchema = {
  description: 'Confirms the routine was deleted.',
  type: 'object', required: ['deleted'], additionalProperties: false,
  properties: { deleted: { const: true } },
} as const satisfies JsonSchema
