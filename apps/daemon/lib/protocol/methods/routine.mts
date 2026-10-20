import type { JsonSchema } from '../jsonrpc.mts'
import type {
  RoutineCreateParams,
  RoutineCreateResult,
  RoutineDeleteParams,
  RoutineDeleteResult,
  RoutineListParams,
  RoutineListResult,
  RoutineRunParams,
  RoutineRunResult,
  RoutineUpdateParams,
  RoutineUpdateResult,
} from '@wrenyard/protocol/routine'

// Wire DTOs are declared once in @wrenyard/protocol/routine and re-exported
// here so every existing daemon import path keeps working. The runtime JSON
// schemas below stay daemon-owned.
export type {
  RoutineCreateParams,
  RoutineCreateResult,
  RoutineDeleteParams,
  RoutineDeleteResult,
  RoutineListParams,
  RoutineListResult,
  RoutineRecord,
  RoutineRunParams,
  RoutineRunResult,
  RoutineState,
  RoutineUpdateParams,
  RoutineUpdateResult,
} from '@wrenyard/protocol/routine'

/** Bot ids are lowercase slugs, 1..32 characters. */
const BOT_ID_SOURCE = '[a-z0-9][a-z0-9-]{0,31}'
const BOT_ID_PATTERN = `^${BOT_ID_SOURCE}$`

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
    name: { type: 'string', minLength: 1, maxLength: 64 },
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
