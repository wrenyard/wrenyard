import type { JsonSchema } from '../jsonrpc.mts'
import {
  taskResolvedDispatchSchema,
  taskUsageSchema,
  type TaskResolvedDispatch,
  type TaskUsage,
} from '../task-run-metadata.mts'

export interface StatsTodayParams {}

export interface StatsTodayResult {
  dayKey: string
  startAt: string
  endAt: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'sqlite'
}

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

export interface StatsSummaryParams {
  days?: number
  limit?: number
}

export interface StatsTodayItem {
  dayKey: string
  startAt: string
  endAt: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  outcomes: {
    done: number
    failed: number
    cancelled: number
    running?: number
  }
}

export interface ProfileRankingItem {
  profile: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface TaskRankingItem {
  taskName: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface DailyBucket {
  dayKey: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  outcomes?: {
    done: number
    failed: number
    cancelled: number
  }
}

export type StatsPeriod = '24h' | '7d' | '1mo'

export interface TaskWindowRow {
  taskId: string
  source: 'builtin' | 'project' | 'unknown'
  runCount: number
  durationMs: number
  averageDurationMs: number
}

export interface StatsWindowProfileRow {
  profile: string
  runCount: number
  totalTokens: number
  averageTps?: number
}

export interface StatsWindowTaskStats {
  totalDurationMs: number
  byTask: TaskWindowRow[]
  builtinTotalDurationMs: number
  byBuiltinTask: TaskWindowRow[]
}

export interface StatsWindowSummary {
  period: StatsPeriod
  startAt: string
  endAt: string
  dispatchCount: number
  totalTokens: number
  byProfile: StatsWindowProfileRow[]
  taskStats: StatsWindowTaskStats
}

export interface TaskRunLedgerRow {
  task_run_id: string
  task: string
  /** Exact persisted execution project; present only when nonblank. */
  project?: string
  source: 'builtin' | 'project' | 'unknown'
  status: string
  created_at: string
  started_at?: string
  finished_at?: string
  resolved?: TaskResolvedDispatch
  /**
   * Additive legacy fallback alongside `resolved`: the exact stored nonblank
   * executions.resolved_profile of the task's execution, carried for runs that
   * predate full task_run_attempt_dispatch snapshots. Never derived from the
   * current resolver/defaults and omitted when no nonblank profile is stored.
   */
  resolved_profile?: string
  usage: TaskUsage
}

export interface StatsSummaryResult {
  source: 'sqlite'
  today: StatsTodayItem
  byProfile: ProfileRankingItem[]
  byTask: TaskRankingItem[]
  daily: DailyBucket[]
  totalTaskDurationMs?: number
  byTaskDuration?: Array<{ taskName: string; durationMs: number }>
  windows?: StatsWindowSummary[]
  recentRuns?: TaskRunLedgerRow[]
}

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
        required: ['profile', 'runCount', 'totalTokens'],
        properties: {
          profile: { type: 'string' },
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
      },
      additionalProperties: true,
    },
    byProfile: {
      type: 'array',
      items: {
        type: 'object',
        required: ['profile', 'dispatchCount', 'inputTokens', 'outputTokens', 'totalTokens'],
        properties: {
          profile: { type: 'string' },
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
        required: ['task_run_id', 'task', 'source', 'status', 'created_at', 'usage'],
        properties: {
          task_run_id: { type: 'string' },
          task: { type: 'string' },
          project: { type: 'string' },
          source: { enum: ['builtin', 'project', 'unknown'] },
          status: { type: 'string' },
          created_at: { type: 'string' },
          started_at: { type: 'string' },
          finished_at: { type: 'string' },
          resolved: taskResolvedDispatchSchema,
          // Additive authoritative legacy fallback; only a nonempty string is a
          // valid profile, so empty/malformed values are rejected.
          resolved_profile: { type: 'string', minLength: 1 },
          usage: taskUsageSchema,
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
