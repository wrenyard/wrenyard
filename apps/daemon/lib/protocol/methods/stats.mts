import type { JsonSchema } from '../jsonrpc.mts'
import {
  taskResolvedDispatchSchema,
  taskUsageSchema,
} from '../task-run-metadata.mts'

export type {
  StatsTodayParams,
  StatsTodayResult,
  StatsSummaryParams,
  StatsTodayItem,
  ProfileRankingItem,
  TaskRankingItem,
  DailyBucket,
  StatsPeriod,
  TaskWindowRow,
  StatsWindowProfileRow,
  StatsWindowTaskStats,
  StatsWindowSummary,
  TaskRunLedgerRow,
  StatsSummaryResult,
  StatsSummaryFreshness,
} from '@wrenyard/protocol/stats'

export const statsTodayParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const statsTodayResultSchema = {
  type: 'object',
  required: ['dayKey', 'startAt', 'endAt', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens', 'source'],
  properties: {
    dayKey: { type: 'string' },
    startAt: { type: 'string' },
    endAt: { type: 'string' },
    dispatchCount: { type: 'integer', minimum: 0 },
    inputTokens: { type: 'number', minimum: 0 },
    outputTokens: { type: 'number', minimum: 0 },
    totalTokens: { type: 'number', minimum: 0 },
    source: { const: 'sqlite' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const MAX_STATS_SUMMARY_DAYS = 366

export const statsSummaryParamsSchema = {
  type: 'object',
  properties: {
    days: { type: 'integer', minimum: 1, maximum: MAX_STATS_SUMMARY_DAYS },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskWindowRowSchema = {
  type: 'object',
  required: ['taskId', 'source', 'runCount', 'durationMs', 'averageDurationMs'],
  properties: {
    taskId: { type: 'string' },
    source: { enum: ['builtin', 'project', 'unknown'] },
    runCount: { type: 'integer', minimum: 0 },
    durationMs: { type: 'number', minimum: 0 },
    averageDurationMs: { type: 'number', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const statsWindowSummarySchema = {
  type: 'object',
  required: ['period', 'startAt', 'endAt', 'dispatchCount', 'totalTokens', 'byProfile', 'taskStats'],
  properties: {
    period: { enum: ['24h', '7d', '1mo'] },
    startAt: { type: 'string' },
    endAt: { type: 'string' },
    dispatchCount: { type: 'integer', minimum: 0 },
    totalTokens: { type: 'number', minimum: 0 },
    byProfile: {
      type: 'array',
      items: {
        type: 'object',
        // `model` is additive. Current producers always emit it, while the
        // protocol validator still accepts older profile-only responses.
        required: ['profile', 'runCount', 'totalTokens'],
        properties: {
          profile: { type: 'string' },
          model: { type: 'string' },
          model_display_name: { type: 'string' },
          provider_display_names: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          runCount: { type: 'integer', minimum: 0 },
          totalTokens: { type: 'number', minimum: 0 },
          averageTps: { type: 'number', minimum: 0 },
        },
        additionalProperties: true,
      },
    },
    taskStats: {
      type: 'object',
      required: ['totalDurationMs', 'byTask', 'builtinTotalDurationMs', 'byBuiltinTask'],
      properties: {
        totalDurationMs: { type: 'number', minimum: 0 },
        byTask: { type: 'array', items: taskWindowRowSchema },
        builtinTotalDurationMs: { type: 'number', minimum: 0 },
        byBuiltinTask: { type: 'array', items: taskWindowRowSchema },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const statsSummaryResultSchema = {
  type: 'object',
  required: ['source', 'today', 'byProfile', 'byTask', 'daily'],
  properties: {
    source: { const: 'sqlite' },
    today: {
      type: 'object',
      required: ['dayKey', 'startAt', 'endAt', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens', 'outcomes'],
      properties: {
        dayKey: { type: 'string' },
        startAt: { type: 'string' },
        endAt: { type: 'string' },
        dispatchCount: { type: 'integer', minimum: 0 },
        inputTokens: { type: 'number', minimum: 0 },
        outputTokens: { type: 'number', minimum: 0 },
        totalTokens: { type: 'number', minimum: 0 },
        outcomes: {
          type: 'object',
          required: ['done', 'failed', 'cancelled'],
          properties: {
            done: { type: 'integer', minimum: 0 },
            failed: { type: 'integer', minimum: 0 },
            cancelled: { type: 'integer', minimum: 0 },
            running: { type: 'integer', minimum: 0 },
          },
          additionalProperties: true,
        },
        // Additive optional cohort: absent on older daemons, so it is never
        // required and existing fields/window semantics are unchanged.
        taskDispatches: {
          type: 'object',
          required: ['count', 'done'],
          properties: {
            count: { type: 'integer', minimum: 0 },
            done: { type: 'integer', minimum: 0 },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    byProfile: {
      type: 'array',
      items: {
        type: 'object',
        // `model` is additive. Current producers always emit it, while the
        // protocol validator still accepts older profile-only responses.
        required: ['profile', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens'],
        properties: {
          profile: { type: 'string' },
          model: { type: 'string' },
          model_display_name: { type: 'string' },
          provider_display_names: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          dispatchCount: { type: 'integer', minimum: 0 },
          inputTokens: { type: 'number', minimum: 0 },
          outputTokens: { type: 'number', minimum: 0 },
          totalTokens: { type: 'number', minimum: 0 },
        },
        additionalProperties: true,
      },
    },
    byTask: {
      type: 'array',
      items: {
        type: 'object',
        required: ['taskName', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens'],
        properties: {
          taskName: { type: 'string' },
          dispatchCount: { type: 'integer', minimum: 0 },
          inputTokens: { type: 'number', minimum: 0 },
          outputTokens: { type: 'number', minimum: 0 },
          totalTokens: { type: 'number', minimum: 0 },
        },
        additionalProperties: true,
      },
    },
    daily: {
      type: 'array',
      items: {
        type: 'object',
        required: ['dayKey', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens'],
        properties: {
          dayKey: { type: 'string' },
          dispatchCount: { type: 'integer', minimum: 0 },
          inputTokens: { type: 'number', minimum: 0 },
          outputTokens: { type: 'number', minimum: 0 },
          totalTokens: { type: 'number', minimum: 0 },
          outcomes: {
            type: 'object',
            required: ['done', 'failed', 'cancelled'],
            properties: {
              done: { type: 'integer', minimum: 0 },
              failed: { type: 'integer', minimum: 0 },
              cancelled: { type: 'integer', minimum: 0 },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
    totalTaskDurationMs: { type: 'integer', minimum: 0 },
    byTaskDuration: {
      type: 'array',
      items: {
        type: 'object',
        required: ['taskName', 'durationMs'],
        properties: {
          taskName: { type: 'string' },
          durationMs: { type: 'integer', minimum: 0 },
        },
        additionalProperties: true,
      },
    },
    windows: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: statsWindowSummarySchema,
    },
    recentRuns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['task_run_id', 'kind', 'task', 'source', 'status', 'created_at', 'usage'],
        properties: {
          task_run_id: { type: 'string' },
          kind: { enum: ['task', 'auxiliary'] },
          task: { type: 'string' },
          role: { type: 'string' },
          project: { type: 'string' },
          source: { enum: ['builtin', 'project', 'unknown'] },
          status: { type: 'string' },
          created_at: { type: 'string' },
          started_at: { type: 'string' },
          finished_at: { type: 'string' },
          resolved: taskResolvedDispatchSchema,
          // Execution identity/mode needed to key task.usage.liveList reads.
          executionId: { type: 'string' },
          executionMode: { enum: ['native', 'gateway'] },
          // Additive authoritative legacy fallback; only a nonempty string is a
          // valid profile, so empty/malformed values are rejected.
          resolved_profile: { type: 'string', minLength: 1 },
          // Additive paired human display labels emitted only after an exact
          // current-Catalog mapping of `resolved.provider`/`resolved.model`.
          provider_display_name: { type: 'string' },
          model_display_name: { type: 'string' },
          usage: taskUsageSchema,
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
