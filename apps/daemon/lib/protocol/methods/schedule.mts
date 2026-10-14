import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'

// Canonical `schedule.*` wire surface for the daemon's scheduled-prompt
// feature. A scheduled prompt is sent to its owning session as a new user
// message when it becomes due; every DTO and runtime JSON schema for the
// schedules live here, exactly like the `session.*` surface.

/** Lifecycle of one scheduled prompt. */
export type ScheduleState = 'active' | 'paused' | 'finished' | 'failed'

/** The model a schedule fires with, taken from the turn that created it. */
export interface ScheduleModel {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
}

export interface ScheduleRecord {
  /** 8 lowercase hex characters; unique among every stored schedule. */
  id: string
  sessionId: string
  /** 1..4000 characters; sent to the session verbatim when the schedule fires. */
  prompt: string
  /** Whole minutes between runs; 1..10080 (7 days). */
  intervalMinutes: number
  recurring: boolean
  model: ScheduleModel
  state: ScheduleState
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp when a recurring schedule expires (createdAt + 7 days). */
  expiresAt?: string
  /** ISO timestamp of the next due run; absent once a schedule is finished or failed. */
  nextRunAt?: string
  /** ISO timestamp of the most recent successful run. */
  lastRunAt?: string
  /** Turn number produced by the most recent successful run. */
  lastTurn?: number
  /** Message of the most recent failure. */
  lastError?: string
  /** Number of successful runs. */
  runCount: number
}

export interface ScheduleListParams { sessionId?: string }
export interface ScheduleListResult {
  schedules: Array<ScheduleRecord & { sessionTitle?: string }>
}
export interface ScheduleCreateParams {
  sessionId: string
  prompt: string
  intervalMinutes: number
  recurring: boolean
  model: ScheduleModel
}
export interface ScheduleCreateResult { schedule: ScheduleRecord }
export interface ScheduleUpdateParams {
  id: string
  state: 'active' | 'paused'
  sessionId?: string
}
export interface ScheduleUpdateResult { schedule: ScheduleRecord }
export interface ScheduleRunParams { id: string; sessionId?: string }
export interface ScheduleRunResult { schedule: ScheduleRecord }
export interface ScheduleDeleteParams { id: string; sessionId?: string }
export interface ScheduleDeleteResult { deleted: true }

const idSchema = { type: 'string', minLength: 1 } as const
// A schedule id is exactly eight lowercase hex characters.
const scheduleIdSchema = { type: 'string', pattern: '^[0-9a-f]{8}$' } as const
const reasoningEffortSchema = {
  type: 'string',
  enum: REASONING_EFFORTS,
} as const
const scheduleStateSchema = {
  type: 'string',
  enum: ['active', 'paused', 'finished', 'failed'],
} as const
// The same model shape `session.send` accepts; a schedule reuses the full
// provider/model/reasoning-effort triple of the turn that created it.
const scheduleModelSchema = {
  type: 'object', required: ['provider', 'model', 'reasoningEffort'], additionalProperties: false,
  properties: { provider: idSchema, model: idSchema, reasoningEffort: reasoningEffortSchema },
} as const satisfies JsonSchema

const scheduleRecordSchema = {
  type: 'object',
  required: ['id', 'sessionId', 'prompt', 'intervalMinutes', 'recurring', 'model', 'state', 'createdAt', 'runCount'],
  additionalProperties: false,
  properties: {
    id: scheduleIdSchema,
    sessionId: idSchema,
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    recurring: { type: 'boolean' },
    model: scheduleModelSchema,
    state: scheduleStateSchema,
    createdAt: { type: 'string', minLength: 1 },
    expiresAt: { type: 'string', minLength: 1 },
    nextRunAt: { type: 'string', minLength: 1 },
    lastRunAt: { type: 'string', minLength: 1 },
    lastTurn: { type: 'integer', minimum: 1 },
    lastError: { type: 'string', minLength: 1 },
    runCount: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema

// A listed schedule is the stored record plus the owning session title when
// the session still exists.
const listedScheduleSchema = {
  ...scheduleRecordSchema,
  properties: {
    ...scheduleRecordSchema.properties,
    sessionTitle: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

export const scheduleListParamsSchema = {
  description: 'List scheduled prompts, optionally limited to one session.',
  type: 'object', additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const scheduleListResultSchema = {
  description: 'All matching schedules, newest first, each with the owning session title when known.',
  type: 'object', required: ['schedules'], additionalProperties: false,
  properties: { schedules: { type: 'array', items: listedScheduleSchema } },
} as const satisfies JsonSchema

export const scheduleCreateParamsSchema = {
  description: 'Create one scheduled prompt for a session.',
  type: 'object', required: ['sessionId', 'prompt', 'intervalMinutes', 'recurring', 'model'], additionalProperties: false,
  properties: {
    sessionId: idSchema,
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
    recurring: { type: 'boolean' },
    model: scheduleModelSchema,
  },
} as const satisfies JsonSchema
export const scheduleCreateResultSchema = {
  description: 'The created schedule.',
  type: 'object', required: ['schedule'], additionalProperties: false,
  properties: { schedule: scheduleRecordSchema },
} as const satisfies JsonSchema

export const scheduleUpdateParamsSchema = {
  description: 'Pause or resume one schedule, optionally restricted to its owning session.',
  type: 'object', required: ['id', 'state'], additionalProperties: false,
  properties: {
    id: scheduleIdSchema,
    state: { type: 'string', enum: ['active', 'paused'] },
    sessionId: idSchema,
  },
} as const satisfies JsonSchema
export const scheduleUpdateResultSchema = {
  description: 'The updated schedule.',
  type: 'object', required: ['schedule'], additionalProperties: false,
  properties: { schedule: scheduleRecordSchema },
} as const satisfies JsonSchema

export const scheduleRunParamsSchema = {
  description: 'Mark one schedule due now so it fires on the next scheduler tick.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: scheduleIdSchema, sessionId: idSchema },
} as const satisfies JsonSchema
export const scheduleRunResultSchema = {
  description: 'The schedule after it was marked due.',
  type: 'object', required: ['schedule'], additionalProperties: false,
  properties: { schedule: scheduleRecordSchema },
} as const satisfies JsonSchema

export const scheduleDeleteParamsSchema = {
  description: 'Delete one schedule, optionally restricted to its owning session.',
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: scheduleIdSchema, sessionId: idSchema },
} as const satisfies JsonSchema
export const scheduleDeleteResultSchema = {
  description: 'Confirms the schedule was deleted.',
  type: 'object', required: ['deleted'], additionalProperties: false,
  properties: { deleted: { const: true } },
} as const satisfies JsonSchema
