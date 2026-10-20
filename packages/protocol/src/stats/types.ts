import type { TaskResolvedDispatch, TaskUsage } from '../task/run-metadata.ts'
import type { JsonSchema } from '../common/jsonrpc'

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
  /**
   * Additive today task-dispatch cohort. `count` is the number of unique tasks
   * whose EARLIEST canonical execution was created inside the daemon-local day
   * window (queued dispatches included, retries collapsed by task_id across all
   * days); `done` is how many of that exact cohort currently have
   * tasks.status = 'done'. Not a completion-date total and never clamped to
   * `count`. Optional so older daemons/clients stay compatible.
   */
  taskDispatches?: { count: number; done: number }
}

export interface ProfileRankingItem {
  /**
   * Deprecated legacy alias equal to `model` (the shared canonical id or the
   * provider/model identity for an unmapped route). Retained
   * so old clients can still parse a `profile` field; new clients should read
   * `model`.
   */
  profile: string
  /** Shared canonical model id, or provider/model for an unmapped exact route. */
  model: string
  /** Optional exact short model display name resolved from the current Catalog. */
  model_display_name?: string
  /** Optional sorted, de-duplicated provider display names for the tooltip. */
  provider_display_names?: string[]
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
  /**
   * Deprecated legacy alias equal to `model` (the shared canonical id or the
   * provider/model identity for an unmapped route). Retained
   * so old clients can still parse a `profile` field; new clients should read
   * `model`.
   */
  profile: string
  /** Shared canonical model id, or provider/model for an unmapped exact route. */
  model: string
  /** Optional exact short model display name resolved from the current Catalog. */
  model_display_name?: string
  /** Optional sorted, de-duplicated provider display names for the tooltip. */
  provider_display_names?: string[]
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
  /** Whether this run is a dispatched task or an in-session auxiliary run. */
  kind: 'task' | 'auxiliary'
  task: string
  /** Auxiliary-only: the auxiliary role that ran (document, todo, vcs, ...). */
  role?: string
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
  /**
   * Additive paired human labels resolved exactly once from the current builtin
   * Catalog display names for the persisted canonical `resolved.provider` and
   * `resolved.model`. Emitted together only when both definitions exist with
   * nonempty display names; never derived from client/profile/model_id/run
   * syntax and never filled from raw identity fallbacks. Desktop assembles the
   * final "Provider · Model" label from these separate fields.
   */
  provider_display_name?: string
  model_display_name?: string
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
