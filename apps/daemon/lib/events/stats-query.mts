import { get as dbGet, getDb, query as dbQuery, run as dbRun } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import { migrateProviderId } from '../config/chatgpt-migration.mts'
import { AuxiliaryRunStore } from '../db/stores/auxiliary-run-store.mts'
import { MAX_STATS_SUMMARY_DAYS } from '../protocol/methods/stats.mts'
import { readTaskRunMetadataBatch, toTaskRunRecord } from '@wrenyard/task'
import { taskRunMetadataDeps } from '../core/task/run-metadata-source.mts'
import { estimateTps, readCachedExecutionTpsSamples, type ExecutionTpsSample } from './tps.mts'
import type {
  StatsTodayItem,
  ProfileRankingItem,
  TaskRankingItem,
  DailyBucket,
  StatsSummaryResult,
  StatsPeriod,
  StatsWindowSummary,
  StatsWindowProfileRow,
  StatsWindowTaskStats,
  TaskWindowRow,
} from '../protocol/methods/stats.mts'
import type { TaskResolvedDispatch, TaskUsage } from '../protocol/task-run-metadata.mts'

export type JsonRecord = Record<string, unknown>

interface StatsEventRow {
  type: string
  /** Guarded json_extract sums for turn_usage rows; always 0 for dispatch. */
  u_input: number
  u_cached: number
  u_output: number
  created_at: string
  profile: string | null
  resolved_profile: string | null
  template: string | null
  /** Persisted canonical dispatch identity from task_run_attempt_dispatch. */
  provider: string | null
  model: string | null
  model_id: string | null
}

interface StatsTaskIntervalRow {
  template: string | null
  created_at: string
  effective_end: string
  status: string
  project: string | null
  definition_source: string | null
}

interface TaskIntervalAccumulator {
  taskId: string
  source: 'builtin' | 'project' | 'unknown'
  runCount: number
  durationMs: number
}

export interface DailyStatsResponse {
  dayKey: string
  startAt: string
  endAt: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'sqlite'
}

export interface TaskRunLedgerRow {
  task_run_id: string
  /** Whether this run is a dispatched task or an in-session auxiliary run. */
  kind: 'task' | 'auxiliary'
  task: string
  /** Auxiliary-only: the auxiliary role that ran (document, todo, vcs, ...). */
  role?: string
  /** Exact persisted execution project, present only when nonblank. */
  project?: string
  source: 'builtin' | 'project' | 'unknown'
  status: string
  created_at: string
  started_at?: string
  finished_at?: string
  resolved?: TaskResolvedDispatch
  /**
   * Authoritative additive legacy fallback: the exact persisted nonblank
   * executions.resolved_profile of the task's execution. `resolved` remains the
   * preferred full current/attempt snapshot; this scalar is never derived from
   * the current resolver, defaults, or another attempt and is omitted for runs
   * whose execution stores no nonblank profile (for example pre-dispatch
   * failures with no execution at all).
   */
  resolved_profile?: string
  /**
   * Additive paired labels for the run's recorded provider/model identity
   * (falling back to `resolved.provider`/`resolved.model` only when no recorded
   * identity exists). Both are always emitted together for a resolvable
   * identity: the injected resolver supplies current-Catalog labels when the
   * route is still known, otherwise the exact recorded provider/model ids are
   * emitted so a historical row is never blank. No label is invented when the
   * identity is unknown, and both are omitted when no identity is available.
   */
  provider_display_name?: string
  model_display_name?: string
  usage: TaskUsage
}

/**
 * Label resolver injected by the daemon for stats rows. Given the persisted
 * canonical `providerId`/`modelId` it returns paired nonempty labels and an
 * optional namespaced stats identity: the current-Catalog labels when the exact
 * route (or a recognized registry alias of it) is still known, otherwise the
 * exact recorded ids. It never consults a client or upstream identifier and
 * never invents an identity; callers only omit when the identity is unknown.
 */
export type TaskRunDisplayNameResolver = (
  providerId: string,
  modelId: string,
) => {
  provider_display_name: string
  model_display_name: string
  /** Namespaced internal grouping key (`canonical:` or `provider-local:`). */
  stats_model_key?: string
  /** Public stable model identity emitted by model-only rankings. */
  stats_model_id?: string
  /** Provider-independent label for a shared identity, or the exact route label. */
  stats_model_display_name?: string
} | undefined

export interface StatsQueryOptions {
  resolveDisplayNames?: TaskRunDisplayNameResolver
}

interface ModelDisplayTarget {
  model_display_name?: string
  provider_display_names?: string[]
}

interface ModelRankAccumulator {
  model: string
  dispatchCount: number
  inputTokens: number
  outputTokens: number
  modelDisplayNames: Set<string>
  providerDisplayNames: Set<string>
}

interface WindowModelAccumulator {
  model: string
  runCount: number
  inputTokens: number
  outputTokens: number
  tpsSamples: ExecutionTpsSample[]
  modelDisplayNames: Set<string>
  providerDisplayNames: Set<string>
}

interface PersistedModelIdentity {
  provider: string
  model: string
}

interface StatsModelIdentity {
  /** Namespaced internal key; never exposed in the protocol. */
  key: string
  /** Shared canonical id, or provider/model for an unmapped local identity. */
  model: string
  modelDisplayName?: string
  providerDisplayName?: string
}

/**
 * Conservative canonical-model identity check for the today/window model
 * rankings. A dispatch row is eligible only when its persisted
 * task_run_attempt_dispatch exposes non-empty provider, model, and model_id, and
 * model_id is exactly `provider + '/' + model`. Missing pieces, mismatched ids,
 * or any fallback to resolved_profile/profile/display names are never tolerated,
 * and no missing component is derived. Returns the exact persisted pair when
 * eligible, otherwise undefined so the row is omitted.
 */
function eligibleModelIdentity(row: {
  provider: string | null
  model: string | null
  model_id: string | null
}): PersistedModelIdentity | undefined {
  if (!row.provider || !row.model || !row.model_id) return undefined
  const p = row.provider.trim()
  const m = row.model.trim()
  const mid = row.model_id.trim()
  if (p === '' || m === '' || mid === '') return undefined
  if (mid !== `${p}/${m}`) return undefined
  return { provider: migrateProviderId(p), model: m }
}

/**
 * Resolves an eligible persisted pair into a model-only stats identity. Shared
 * grouping is accepted only from an explicit namespaced Catalog result. Any
 * absent or malformed mapping stays provider-local, so equal raw model strings
 * from unrelated providers can never collide. Exact current aliases are never
 * consulted here and cannot reinterpret historical rows.
 */
function resolveStatsModelIdentity(
  persisted: PersistedModelIdentity,
  resolveDisplayNames: TaskRunDisplayNameResolver | undefined,
): StatsModelIdentity {
  const localModel = `${persisted.provider}/${persisted.model}`
  const resolved = resolveDisplayNames?.(persisted.provider, persisted.model)
  const providerDisplayName = nonBlankString(resolved?.provider_display_name)
  const routeDisplayName = nonBlankString(resolved?.model_display_name)
  const statsKey = nonBlankString(resolved?.stats_model_key)
  const statsModel = nonBlankString(resolved?.stats_model_id)
  const statsDisplayName = nonBlankString(resolved?.stats_model_display_name)
  const hasNamespacedKey = statsKey === `canonical:${statsModel}`
    || statsKey === `provider-local:${statsModel}`
  if (statsKey && hasNamespacedKey && statsModel && statsDisplayName) {
    return { key: statsKey, model: statsModel, modelDisplayName: statsDisplayName, ...(providerDisplayName ? { providerDisplayName } : {}) }
  }
  return {
    key: `provider-local:${localModel}`,
    model: localModel,
    ...(routeDisplayName ? { modelDisplayName: routeDisplayName } : {}),
    ...(providerDisplayName ? { providerDisplayName } : {}),
  }
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function recordModelDisplay(source: ModelRankAccumulator | WindowModelAccumulator, identity: StatsModelIdentity): void {
  if (identity.modelDisplayName) source.modelDisplayNames.add(identity.modelDisplayName)
  if (identity.providerDisplayName) source.providerDisplayNames.add(identity.providerDisplayName)
}

function applyModelDisplay(source: ModelRankAccumulator | WindowModelAccumulator, target: ModelDisplayTarget): void {
  if (source.providerDisplayNames.size > 0) {
    target.provider_display_names = [...source.providerDisplayNames].sort()
  }
  if (source.modelDisplayNames.size === 1) {
    target.model_display_name = [...source.modelDisplayNames][0]
  }
}

/**
 * Conservative upper bound on the additive recent-run ledger so the stats
 * summary keeps exposing individual runs for Desktop without ever scanning an
 * unbounded number of task rows.
 */
const RECENT_RUNS_CAP = 25

/**
 * Short-lived response cache for stats.summary, keyed per database handle so a
 * reopened or isolated database never inherits another database's entries. Each
 * entry is keyed by days, limit and the local day (the daily buckets and all
 * local-calendar windows depend on it). An entry is served only when a cheap
 * stamp query of per-table rowid maxima matches and the entry is younger than
 * SUMMARY_CACHE_MAX_AGE_MS; both the stored and returned values are cloned so a
 * caller can never mutate a cached snapshot. Failures are never cached.
 */
const SUMMARY_CACHE_MAX_AGE_MS = 30_000

interface SummaryCacheEntry {
  stamp: string
  cachedAtMs: number
  result: StatsSummaryResult
}

const summaryCache = new WeakMap<ForemanDatabase, Map<string, SummaryCacheEntry>>()

/** One indexed-max probe per table the summary reads; NULL-safe on empty tables. total_changes() counts every insert/update/delete on the connection, covering in-place updates that leave row maxima unchanged. */
function readSummaryStamp(): string {
  const row = dbGet<{ e: number; t: number; x: number; a: number; c: number }>(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM events) AS e,
            (SELECT COALESCE(MAX(rowid), 0) FROM tasks) AS t,
            (SELECT COALESCE(MAX(rowid), 0) FROM executions) AS x,
            (SELECT COALESCE(MAX(rowid), 0) FROM auxiliary_runs) AS a,
            (SELECT total_changes()) AS c`,
  )
  return row ? `${row.e}/${row.t}/${row.x}/${row.a}/${row.c}` : ''
}

interface StatsDayCacheRow {
  day_key: string
  dispatch_count: number
  input_tokens: number
  output_tokens: number
  done_count: number
  failed_count: number
  cancelled_count: number
  built_at: string
}

/** Guarded json_extract for turn_usage input_tokens (matches live summary scan). */
const SQL_TURN_USAGE_INPUT = `CASE WHEN e.type = 'turn_usage' AND json_valid(e.data)
      AND json_type(e.data, '$.input_tokens') IN ('integer','real')
      AND json_extract(e.data, '$.input_tokens') > 0
      AND json_extract(e.data, '$.input_tokens') < 1e308
 THEN json_extract(e.data, '$.input_tokens') ELSE 0 END`

const SQL_TURN_USAGE_CACHED = `CASE WHEN e.type = 'turn_usage' AND json_valid(e.data)
      AND json_type(e.data, '$.cached_input_tokens') IN ('integer','real')
      AND json_extract(e.data, '$.cached_input_tokens') > 0
      AND json_extract(e.data, '$.cached_input_tokens') < 1e308
 THEN json_extract(e.data, '$.cached_input_tokens') ELSE 0 END`

const SQL_TURN_USAGE_OUTPUT = `CASE WHEN e.type = 'turn_usage' AND json_valid(e.data)
      AND json_type(e.data, '$.output_tokens') IN ('integer','real')
      AND json_extract(e.data, '$.output_tokens') > 0
      AND json_extract(e.data, '$.output_tokens') < 1e308
 THEN json_extract(e.data, '$.output_tokens') ELSE 0 END`

interface StatsDayWindow {
  dayKey: string
  startAt: string
  endAt: string
}

function closedDayWindows(startAt: string, endBeforeIso: string): StatsDayWindow[] {
  const days: StatsDayWindow[] = []
  let start = new Date(startAt)
  while (start.toISOString() < endBeforeIso) {
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    days.push({ dayKey: localDayKeyOf(start.toISOString()), startAt: start.toISOString(), endAt: end.toISOString() })
    start = end
  }
  return days
}

function readSealedDayCacheRow(dayKey: string): StatsDayCacheRow | undefined {
  return dbGet<StatsDayCacheRow>(
    `SELECT day_key, dispatch_count, input_tokens, output_tokens, done_count, failed_count, cancelled_count, built_at
     FROM stats_day_cache WHERE day_key = ?`,
    dayKey,
  )
}

/** Missing closed day keys strictly before sealBeforeIso, oldest first, bounded to MAX_STATS_SUMMARY_DAYS. */
export function listMissingSealedDayKeys(sealBeforeIso: string, now = new Date()): string[] {
  const oldestStart = localDayOffsetStartIso(now, -(MAX_STATS_SUMMARY_DAYS - 1))
  const missing: string[] = []
  for (const day of closedDayWindows(oldestStart, sealBeforeIso)) {
    if (!readSealedDayCacheRow(day.dayKey)) missing.push(day.dayKey)
  }
  return missing
}

function dayWindowFromDayKey(dayKey: string): StatsDayWindow | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return undefined
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  return { dayKey, startAt: start.toISOString(), endAt: end.toISOString() }
}

/** Seal one local calendar day of dispatch/turn_usage totals and terminal task outcomes. */
export function sealStatsDay(dayKey: string): void {
  const window = dayWindowFromDayKey(dayKey)
  if (!window) return
  const { startAt, endAt } = window
  const builtAt = new Date().toISOString()
  const eventTotals = dbGet<{
    dispatch_count: number
    input_tokens: number
    output_tokens: number
  }>(
    `SELECT COALESCE(SUM(CASE WHEN e.type = 'dispatch' THEN 1 ELSE 0 END), 0) AS dispatch_count,
            COALESCE(SUM(${SQL_TURN_USAGE_INPUT} + ${SQL_TURN_USAGE_CACHED}), 0) AS input_tokens,
            COALESCE(SUM(${SQL_TURN_USAGE_OUTPUT}), 0) AS output_tokens
     FROM events e
     WHERE e.type IN ('dispatch', 'turn_usage')
       AND e.created_at >= ? AND e.created_at < ?`,
    startAt,
    endAt,
  )
  const outcomeTotals = dbGet<{
    done_count: number
    failed_count: number
    cancelled_count: number
  }>(
    `SELECT COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
            COALESCE(SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
            COALESCE(SUM(CASE WHEN t.status IN ('cancelled', 'interrupted') THEN 1 ELSE 0 END), 0) AS cancelled_count
     FROM tasks t
     WHERE t.ended_at >= ? AND t.ended_at < ?
       AND t.status IN ('done', 'failed', 'cancelled', 'interrupted')`,
    startAt,
    endAt,
  )
  dbRun(
    `INSERT OR REPLACE INTO stats_day_cache (day_key, dispatch_count, input_tokens, output_tokens, done_count, failed_count, cancelled_count, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    dayKey,
    eventTotals?.dispatch_count ?? 0,
    eventTotals?.input_tokens ?? 0,
    eventTotals?.output_tokens ?? 0,
    outcomeTotals?.done_count ?? 0,
    outcomeTotals?.failed_count ?? 0,
    outcomeTotals?.cancelled_count ?? 0,
    builtAt,
  )
}

let statsDayCacheSealerStopped = false

export function stopStatsDayCacheBackgroundSealer(): void {
  statsDayCacheSealerStopped = true
}

/** Opportunistically seal missing closed days; never blocks startup. */
export function startStatsDayCacheBackgroundSealer(options: { isShuttingDown: () => boolean }): void {
  statsDayCacheSealerStopped = false
  void (async () => {
    try {
      const sealBeforeIso = localDayOffsetStartIso(new Date(), -(31 - 1))
      const missing = listMissingSealedDayKeys(sealBeforeIso)
      for (const dayKey of missing) {
        if (statsDayCacheSealerStopped || options.isShuttingDown()) return
        try {
          sealStatsDay(dayKey)
        } catch (error) {
          writeDaemonLogNonFatal('stats day cache seal failed', error)
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch (error) {
      writeDaemonLogNonFatal('stats day cache background sealer failed', error)
    }
  })()
}

function writeDaemonLogNonFatal(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.warn(`${message}: ${detail}`)
}

function applySealedTotalsToBucket(bucket: DailyBucket, row: StatsDayCacheRow): void {
  bucket.dispatchCount = row.dispatch_count
  bucket.inputTokens = row.input_tokens
  bucket.outputTokens = row.output_tokens
  bucket.totalTokens = row.input_tokens + row.output_tokens
  if (row.done_count > 0 || row.failed_count > 0 || row.cancelled_count > 0) {
    bucket.outcomes = {
      done: row.done_count,
      failed: row.failed_count,
      cancelled: row.cancelled_count,
    }
  }
}

function ensureSealedDayForBucket(dayKey: string, sealBeforeDayKey: string): StatsDayCacheRow | undefined {
  if (dayKey >= sealBeforeDayKey) return undefined
  let row = readSealedDayCacheRow(dayKey)
  if (!row) {
    sealStatsDay(dayKey)
    row = readSealedDayCacheRow(dayKey)
  }
  return row
}

export function readTodayStats(now = new Date()): DailyStatsResponse {
  const window = localDayWindow(now)
  const dispatchRow = dbGet<{ count: number }>(
    `SELECT COUNT(*) AS count
    FROM events
    WHERE type = 'dispatch'
      AND created_at >= ?
      AND created_at < ?`,
    window.startAt,
    window.endAt,
  )
  const usageRows = dbQuery<{ data: string | null }>(
    `SELECT data
    FROM events
    WHERE type = 'turn_usage'
      AND created_at >= ?
      AND created_at < ?`,
    window.startAt,
    window.endAt,
  )

  let inputTokens = 0
  let outputTokens = 0
  for (const row of usageRows) {
    const data = parseJsonValue(row.data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    inputTokens += fullInputTokens(data as JsonRecord)
    outputTokens += nonNegativeNumber((data as JsonRecord).output_tokens)
  }

  return {
    dayKey: window.dayKey,
    startAt: window.startAt,
    endAt: window.endAt,
    dispatchCount: dispatchRow?.count ?? 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'sqlite',
  }
}

export function readStatsSummary(
  params: { days?: number; limit?: number } = {},
  now = new Date(),
  options: StatsQueryOptions = {},
): StatsSummaryResult {
  const days = params.days ?? 7
  const limit = params.limit ?? 20

  if (!Number.isInteger(days) || days < 1 || days > MAX_STATS_SUMMARY_DAYS) {
    throw new Error(`Invalid days: ${days}. Must be an integer between 1 and ${MAX_STATS_SUMMARY_DAYS}.`)
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error(`Invalid limit: ${limit}. Must be an integer between 1 and 50.`)
  }

  const database = getDb()
  const todayWindow = localDayWindow(now)
  const cacheKey = `${days}:${limit}:${todayWindow.dayKey}`
  let byKey = summaryCache.get(database)
  if (!byKey) {
    byKey = new Map()
    summaryCache.set(database, byKey)
  }
  const stamp = readSummaryStamp()
  const hit = byKey.get(cacheKey)
  if (hit && hit.stamp === stamp && now.getTime() - hit.cachedAtMs < SUMMARY_CACHE_MAX_AGE_MS) {
    return structuredClone(hit.result)
  }

  const result = readStatsSummaryUncached(params, now, options, todayWindow)
  byKey.set(cacheKey, { stamp, cachedAtMs: now.getTime(), result: structuredClone(result) })
  return result
}

function readStatsSummaryUncached(
  params: { days?: number; limit?: number },
  now: Date,
  options: StatsQueryOptions,
  todayWindow: { dayKey: string; startAt: string; endAt: string },
): StatsSummaryResult {
  const days = params.days ?? 7
  const limit = params.limit ?? 20


  const dailyBuckets = buildDailyBuckets(now, days)

  // Keep the fixed 31-local-day period window while allowing the daily
  // activity projection to extend to a full year.
  const windowsStartIso = localDayOffsetStartIso(now, -(31 - 1))
  const dailyStartIso = localDayOffsetStartIso(now, -(days - 1))
  const sealBeforeDayKey = localDayKeyOf(windowsStartIso)
  const fullEndIso = todayWindow.endAt

  // Daily chart days strictly before the 31-day live window are served from
  // sealed per-day totals (lazy seal on read); rankings and fixed windows stay live.
  for (const bucket of dailyBuckets) {
    if (bucket.dayKey >= sealBeforeDayKey) continue
    const sealed = ensureSealedDayForBucket(bucket.dayKey, sealBeforeDayKey)
    if (sealed) applySealedTotalsToBucket(bucket, sealed)
  }

  // Bounded live event scan for the rolling 31-local-day window only. Token
  // fields are extracted in SQL under json_valid so the event `data` blob never
  // crosses to JS; executions wide profile columns are not selected.
  const allEventsRows = dbQuery<StatsEventRow>(
    `SELECT e.type, e.created_at, COALESCE(t.template, ex_t.template) AS template,
            tra.provider AS provider, tra.model AS model, tra.model_id AS model_id,
            ${SQL_TURN_USAGE_INPUT} AS u_input,
            ${SQL_TURN_USAGE_CACHED} AS u_cached,
            ${SQL_TURN_USAGE_OUTPUT} AS u_output
     FROM events e
     LEFT JOIN executions ex ON e.execution_id = ex.id
     LEFT JOIN tasks t ON e.task_id = t.id
     LEFT JOIN tasks ex_t ON ex.task_id = ex_t.id
     LEFT JOIN task_run_attempt_dispatch tra ON e.execution_id = tra.execution_id
     WHERE e.type IN ('dispatch', 'turn_usage')
       AND e.created_at >= ? AND e.created_at < ?`,
    windowsStartIso,
    fullEndIso,
  )

  // One bounded terminal+active task interval scan over the 31-day window.
  // Terminal rows overlap via ended_at (idx_task_ended_at); queued/running rows
  // are bounded by status (idx_task_status) and end at the injected now.
  const taskIntervalRows = dbQuery<StatsTaskIntervalRow>(
    `SELECT template, created_at, effective_end, status, project, definition_source
     FROM (
       SELECT t.template AS template, t.created_at AS created_at, t.ended_at AS effective_end, t.status AS status, t.project AS project, t.definition_source AS definition_source
       FROM tasks t INDEXED BY idx_task_ended_at
       WHERE t.ended_at >= ? AND t.ended_at < ?
         AND t.status IN ('done','failed','cancelled','interrupted')
       UNION ALL
       SELECT t.template AS template, t.created_at AS created_at, ? AS effective_end, t.status AS status, t.project AS project, t.definition_source AS definition_source
       FROM tasks t
       WHERE t.status IN ('queued','running')
         AND t.created_at < ?
     )`,
    windowsStartIso,
    fullEndIso,
    now.toISOString(),
    fullEndIso,
  )

  // One bounded cohort scan over canonical executions (never events). Each
  // task's EARLIEST execution created_at (via idx_exec_task_meta) decides its
  // first-dispatch day: queued executions are included and retries collapse
  // across all days, so a task first dispatched yesterday but retried today
  // stays in yesterday's cohort. `done` is the current tasks.status of that
  // exact cohort — never a completion-date total and never clamped.
  const todayDispatchCohort = dbGet<{ count: number; done: number }>(
    // Equivalent to grouping executions by task_id and keeping groups whose
    // MIN(created_at) falls in today's window: a task first dispatched today
    // has at least one execution in the window (EXISTS) and none before it
    // (NOT EXISTS). Both probes hit idx_exec_task_meta per candidate task
    // instead of aggregating every execution row ever written.
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done
     FROM tasks t
     WHERE EXISTS (
       SELECT 1 FROM executions e
       WHERE e.task_id = t.id AND e.created_at >= ? AND e.created_at < ?
     )
     AND NOT EXISTS (
       SELECT 1 FROM executions e
       WHERE e.task_id = t.id AND e.created_at < ?
     )`,
    todayWindow.startAt,
    todayWindow.endAt,
    todayWindow.startAt,
  )

  // Partition events into daily buckets by local calendar day
  const bucketByDayKey = new Map<string, DailyBucket>()
  for (const bucket of dailyBuckets) {
    bucketByDayKey.set(bucket.dayKey, bucket)
  }

  for (const row of allEventsRows) {
    const key = localDayKeyOf(row.created_at)
    const bucket = bucketByDayKey.get(key)
    if (!bucket) continue

    if (row.type === 'dispatch') {
      bucket.dispatchCount++
    } else if (row.type === 'turn_usage') {
      bucket.inputTokens += row.u_input + row.u_cached
      bucket.outputTokens += row.u_output
    }
  }

  // Recompute totalTokens after event partitioning
  for (const bucket of dailyBuckets) {
    bucket.totalTokens = bucket.inputTokens + bucket.outputTokens
  }

  // Partition terminal task rows into daily buckets and compute today outcomes
  const todaysOutcomes: { done: number; failed: number; cancelled: number } = { done: 0, failed: 0, cancelled: 0 }

  for (const row of taskIntervalRows) {
    if (row.status === 'queued' || row.status === 'running') continue
    const key = localDayKeyOf(row.effective_end)

    // Accumulate into today
    if (key === todayWindow.dayKey) {
      if (row.status === 'done') todaysOutcomes.done++
      else if (row.status === 'failed') todaysOutcomes.failed++
      else if (row.status === 'cancelled' || row.status === 'interrupted') todaysOutcomes.cancelled++
    }

    // Accumulate into daily bucket
    const bucket = bucketByDayKey.get(key)
    if (!bucket) continue

    if (row.status === 'done') {
      if (!bucket.outcomes) bucket.outcomes = { done: 0, failed: 0, cancelled: 0 }
      bucket.outcomes.done++
    } else if (row.status === 'failed') {
      if (!bucket.outcomes) bucket.outcomes = { done: 0, failed: 0, cancelled: 0 }
      bucket.outcomes.failed++
    } else if (row.status === 'cancelled' || row.status === 'interrupted') {
      if (!bucket.outcomes) bucket.outcomes = { done: 0, failed: 0, cancelled: 0 }
      bucket.outcomes.cancelled++
    }
  }

  const today: StatsTodayItem = {
    dayKey: todayWindow.dayKey,
    startAt: todayWindow.startAt,
    endAt: todayWindow.endAt,
    dispatchCount: dailyBuckets[dailyBuckets.length - 1].dispatchCount,
    inputTokens: dailyBuckets[dailyBuckets.length - 1].inputTokens,
    outputTokens: dailyBuckets[dailyBuckets.length - 1].outputTokens,
    totalTokens: dailyBuckets[dailyBuckets.length - 1].totalTokens,
    outcomes: todaysOutcomes,
    taskDispatches: {
      count: todayDispatchCohort?.count ?? 0,
      done: todayDispatchCohort?.done ?? 0,
    },
  }

  // --- TODAY RANKINGS: filter the full event set to today only ---
  const todayRows = allEventsRows.filter((row) => localDayKeyOf(row.created_at) === todayWindow.dayKey)

  // --- byProfile: group by explicit shared canonical identity when the exact
  // persisted provider/model route declares one; otherwise retain a namespaced
  // provider-local identity. `profile` remains the deprecated output alias equal
  // to `model`. Ineligible historical rows are omitted from model rankings (but
  // still counted in overall totals above).
  const modelMap = new Map<string, ModelRankAccumulator>()
  for (const row of todayRows) {
    const persisted = eligibleModelIdentity(row)
    if (!persisted) continue
    const identity = resolveStatsModelIdentity(persisted, options.resolveDisplayNames)
    let g = modelMap.get(identity.key)
    if (!g) {
      g = {
        model: identity.model,
        dispatchCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        modelDisplayNames: new Set<string>(),
        providerDisplayNames: new Set<string>(),
      }
      modelMap.set(identity.key, g)
    }
    recordModelDisplay(g, identity)
    if (row.type === 'dispatch') {
      g.dispatchCount++
    } else if (row.type === 'turn_usage') {
      g.inputTokens += row.u_input + row.u_cached
      g.outputTokens += row.u_output
    }
  }

  const byProfile: ProfileRankingItem[] = [...modelMap.entries()]
    .map(([, g]) => {
      const item: ProfileRankingItem = {
        profile: g.model,
        model: g.model,
        dispatchCount: g.dispatchCount,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        totalTokens: g.inputTokens + g.outputTokens,
      }
      applyModelDisplay(g, item)
      return item
    })
    .sort((a, b) => {
      const diff = b.totalTokens - a.totalTokens
      if (diff !== 0) return diff
      return a.model.localeCompare(b.model)
    })
    .slice(0, limit)

  // --- byTask: group by task display name (template name), NEVER a run id ---
  const taskMap = new Map<string, { dispatchCount: number; inputTokens: number; outputTokens: number }>()
  for (const row of todayRows) {
    const taskName = normalizeTaskName(row.template)
    let g = taskMap.get(taskName)
    if (!g) {
      g = { dispatchCount: 0, inputTokens: 0, outputTokens: 0 }
      taskMap.set(taskName, g)
    }
    if (row.type === 'dispatch') {
      g.dispatchCount++
    } else if (row.type === 'turn_usage') {
      g.inputTokens += row.u_input + row.u_cached
      g.outputTokens += row.u_output
    }
  }

  const byTask: TaskRankingItem[] = [...taskMap.entries()]
    .map(([taskName, g]) => ({
      taskName,
      dispatchCount: g.dispatchCount,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.inputTokens + g.outputTokens,
    }))
    .sort((a, b) => {
      const diff = b.totalTokens - a.totalTokens
      if (diff !== 0) return diff
      return a.taskName.localeCompare(b.taskName)
    })
    .slice(0, limit)

  // --- TODAY TASK LIFECYCLE DURATIONS: reuse the candidate scan, clamped to
  // [today.startAt, today.endAt); invalid and inverted spans are discarded.
  const todayStartMs = new Date(todayWindow.startAt).getTime()
  const todayEndMs = new Date(todayWindow.endAt).getTime()
  const durationByTask = new Map<string, number>()
  let totalTaskDurationMs = 0
  for (const row of taskIntervalRows) {
    const durationMs = clampedOverlapMs(row, todayStartMs, todayEndMs)
    if (durationMs === undefined) continue
    totalTaskDurationMs += durationMs
    const taskName = normalizeTaskName(row.template)
    durationByTask.set(taskName, (durationByTask.get(taskName) ?? 0) + durationMs)
  }

  const byTaskDuration = rankTaskDuration(durationByTask, limit)

  // --- FIXED PERIOD WINDOWS: project 24h/7d/1mo in memory from the same scans.
  // Execution-based TPS samples come from the cached vector shared with local
  // routing (local calendar window, no SQL); narrower windows reuse the same
  // samples filtered by endedAt, so stats and routing share one measured rate.
  const tpsSamples = readCachedExecutionTpsSamples(now)
  const windows = buildWindows({
    todayWindow,
    windowsStartIso,
    windowsEndAt: fullEndIso,
    allEventsRows,
    taskIntervalRows,
    tpsSamples,
    now,
    limit,
    resolveDisplayNames: options.resolveDisplayNames,
  })

  return {
    source: 'sqlite',
    today,
    byProfile,
    byTask,
    daily: dailyBuckets,
    totalTaskDurationMs,
    byTaskDuration,
    windows,
    recentRuns: readRecentTaskRunLedger(Math.min(limit, RECENT_RUNS_CAP), options.resolveDisplayNames),
  }
}

/**
 * Bounded recent per-run ledger for the stats summary. Reuses the shared
 * run-metadata helper so each row's resolved dispatch and exact TaskUsage are
 * projected by the canonical DB-backed projection rather than recomputed here.
 * Ordering follows the existing indexed task recency (ended_at then created_at)
 * and the result is capped by RECENT_RUNS_CAP.
 */
function readRecentTaskRunLedger(
  recentLimit: number,
  resolveDisplayNames?: TaskRunDisplayNameResolver,
): TaskRunLedgerRow[] {
  const rows = dbQuery<{
    id: string
    template: string | null
    project: string | null
    status: string
    created_at: string
    ended_at: string | null
    definition_source: string | null
    started_at: string | null
    resolved_profile: string | null
    summary: string | null
  }>(
    // The MIN(started_at) probe runs per already-selected recent task row via
    // idx_exec_task_meta instead of grouping every execution in the table; the
    // inner SELECT fixes the same ORDER BY + LIMIT candidate set first, and the
    // outer ORDER BY restores it because subquery ordering is not guaranteed to
    // propagate through the joins.
    `SELECT t.id AS id, t.template AS template, t.project AS project, t.status AS status,
            t.created_at AS created_at, t.ended_at AS ended_at, t.definition_source AS definition_source,
            t.summary AS summary,
            (SELECT MIN(e2.started_at) FROM executions e2 WHERE e2.task_id = t.id) AS started_at,
            exe.resolved_profile AS resolved_profile
     FROM (
       SELECT id, template, project, status, created_at, ended_at, definition_source, summary, execution_id
       FROM tasks
       ORDER BY COALESCE(ended_at, created_at) DESC, created_at DESC
       LIMIT ?
     ) t
     LEFT JOIN executions exe ON exe.id = t.execution_id
     ORDER BY COALESCE(t.ended_at, t.created_at) DESC, t.created_at DESC`,
    recentLimit,
  )

  const metadataById = readTaskRunMetadataBatch(rows.map((row) => row.id), taskRunMetadataDeps)

  const taskRows: TaskRunLedgerRow[] = rows.map((row) => {
    const meta = metadataById.get(row.id) ?? { usage: { completeness: 'unavailable' as const, attempt_count: 0, usage_event_count: 0, reference_cost_complete: false } }
    // Shared run-record projection of the same row. Built alongside the ledger
    // row and not emitted on the wire yet: the recentRuns shape is unchanged.
    const runRecord = toTaskRunRecord({
      id: row.id,
      taskId: row.id,
      status: row.status,
      timing: {
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.ended_at ?? undefined,
      },
      usage: meta.usage,
      resolved: meta.resolved,
      summary: row.summary ?? undefined,
    })
    void runRecord
    const ledger: TaskRunLedgerRow = {
      task_run_id: row.id,
      kind: 'task',
      task: normalizeTaskName(row.template),
      source: taskSourceOf(row.definition_source),
      status: row.status,
      created_at: row.created_at,
      usage: meta.usage,
    }
    if (row.project && row.project.trim() !== '') ledger.project = row.project
    if (row.started_at) ledger.started_at = row.started_at
    if (row.ended_at) ledger.finished_at = row.ended_at
    if (meta.resolved) ledger.resolved = meta.resolved
    // Additive paired human display labels. The recorded identity is preferred:
    // it survives an incomplete pricing/speed snapshot, while the strict
    // resolved dispatch is only a fallback. The persisted canonical provider is
    // normalized through the same legacy migration the model rankings use, then
    // resolved once by the injected resolver. When the current offerings no
    // longer label the historical route (or no resolver is injected) the exact
    // recorded provider/model ids are emitted verbatim: a historical row is
    // never blank, and a missing identity is never invented.
    const identity = meta.recorded
      ?? (meta.resolved ? { provider: meta.resolved.provider, model: meta.resolved.model } : undefined)
    if (identity) {
      const recordedProvider = migrateProviderId(identity.provider)
      const displayNames = resolveDisplayNames?.(recordedProvider, identity.model)
      const pairedProvider = nonBlankString(displayNames?.provider_display_name)
      const pairedModel = nonBlankString(displayNames?.model_display_name)
      if (pairedProvider && pairedModel) {
        ledger.provider_display_name = pairedProvider
        ledger.model_display_name = pairedModel
      } else {
        const fallbackProvider = nonBlankString(recordedProvider)
        const fallbackModel = nonBlankString(identity.model)
        if (fallbackProvider && fallbackModel) {
          ledger.provider_display_name = fallbackProvider
          ledger.model_display_name = fallbackModel
        }
      }
    }
    // Additive authoritative legacy fallback: the exact persisted
    // executions.resolved_profile of the task's execution, only when nonblank.
    // Never derived from the current resolver/defaults or another attempt and
    // never emitted when the run has no execution/profile at all.
    const legacyResolvedProfile = normalizeResolvedProfile(row.resolved_profile)
    if (legacyResolvedProfile) ledger.resolved_profile = legacyResolvedProfile
    return ledger
  })

  // Auxiliary runs union into the same ledger: one row per finished in-session
  // auxiliary run, labelled by its role, never touching the task aggregates.
  const auxiliaryRows = new AuxiliaryRunStore(getDb())
    .readRecent(recentLimit)
    .map((row): TaskRunLedgerRow => {
      const ledger: TaskRunLedgerRow = {
        task_run_id: row.id,
        kind: 'auxiliary',
        task: row.role,
        role: row.role,
        source: 'unknown',
        status: row.status,
        created_at: row.created_at,
        usage: parseAuxiliaryUsage(row.usage),
      }
      if (row.started_at) ledger.started_at = row.started_at
      if (row.finished_at) ledger.finished_at = row.finished_at
      const provider = nonBlankString(row.provider)
      const model = nonBlankString(row.model)
      if (provider && model) {
        const migrated = migrateProviderId(provider)
        const displayNames = resolveDisplayNames?.(migrated, model)
        const pairedProvider = nonBlankString(displayNames?.provider_display_name)
        const pairedModel = nonBlankString(displayNames?.model_display_name)
        ledger.provider_display_name = pairedProvider ?? migrated
        ledger.model_display_name = pairedModel ?? model
      }
      return ledger
    })

  return [...taskRows, ...auxiliaryRows]
    .sort((a, b) => {
      const aInstant = Date.parse(a.finished_at ?? a.created_at)
      const bInstant = Date.parse(b.finished_at ?? b.created_at)
      if (aInstant !== bInstant) return bInstant - aInstant
      return Date.parse(b.created_at) - Date.parse(a.created_at)
    })
    .slice(0, recentLimit)
}

/** Parse one stored auxiliary usage JSON back into the TaskUsage wire shape. */
function parseAuxiliaryUsage(stored: string | null): TaskUsage {
  const parsed = parseJsonValue(stored)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as TaskUsage
    if (record.completeness === 'complete' || record.completeness === 'partial' || record.completeness === 'unavailable') {
      return parsed as TaskUsage
    }
  }
  return { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false }
}

function localDayWindow(now: Date): { dayKey: string; startAt: string; endAt: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  const month = String(start.getMonth() + 1).padStart(2, '0')
  const day = String(start.getDate()).padStart(2, '0')
  return {
    dayKey: `${start.getFullYear()}-${month}-${day}`,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  }
}

function buildDailyBuckets(now: Date, count: number): DailyBucket[] {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const buckets: DailyBucket[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(todayStart)
    d.setDate(d.getDate() - (count - 1 - i))
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    buckets.push({
      dayKey: `${d.getFullYear()}-${month}-${day}`,
      dispatchCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })
  }
  return buckets
}

function parseJsonValue(value: string | null): unknown | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Full input for a turn_usage event is the untrusted input_tokens plus the
 * optional cached_input_tokens partition the client reported (Cursor exposes
 * cached_input_tokens as the total cached-input partition, of which
 * cache_read_input_tokens and cache_creation_input_tokens are the read/write
 * split). Legacy events that only report input_tokens are unchanged. The cache
 * partition is counted exactly once here; the read/creation split is never
 * added on top, and a separate total_tokens field is never added either
 * because that would double count the same input.
 */
function fullInputTokens(record: JsonRecord): number {
  return nonNegativeNumber(record.input_tokens) + nonNegativeNumber(record.cached_input_tokens)
}

function localDayKeyOf(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function localDayOffsetStartIso(now: Date, offsetDays: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString()
}

function normalizeTaskName(template: string | null): string {
  return (template && template.trim()) ? template.trim() : 'unknown'
}

/**
 * Maps a persisted tasks.definition_source to the stats source enum. NULL and
 * any other value mean pre-migration/legacy unknown and are reported as
 * 'unknown' — never guessed from project/name/id or the current registry.
 */
function taskSourceOf(definitionSource: string | null): 'builtin' | 'project' | 'unknown' {
  if (definitionSource === 'builtin' || definitionSource === 'project') return definitionSource
  return 'unknown'
}

function normalizeResolvedProfile(profile: string | null): string | undefined {
  if (!profile || !profile.trim()) return undefined
  return profile.trim()
}

/**
 * Returns the overlap of a task interval with [startMs, endMs), or undefined
 * when the interval is invalid, inverted, or has no positive overlap.
 */
function clampedOverlapMs(row: StatsTaskIntervalRow, startMs: number, endMs: number): number | undefined {
  const startIso = new Date(row.created_at).getTime()
  const endIso = new Date(row.effective_end).getTime()
  if (!Number.isFinite(startIso) || !Number.isFinite(endIso)) return undefined
  const clampedStart = Math.max(startIso, startMs)
  const clampedEnd = Math.min(endIso, endMs)
  if (clampedEnd <= clampedStart) return undefined
  return clampedEnd - clampedStart
}

function buildWindows(options: {
  todayWindow: { startAt: string; endAt: string }
  windowsStartIso: string
  windowsEndAt: string
  allEventsRows: StatsEventRow[]
  taskIntervalRows: StatsTaskIntervalRow[]
  tpsSamples: ExecutionTpsSample[]
  now: Date
  limit: number
  resolveDisplayNames?: TaskRunDisplayNameResolver
}): StatsWindowSummary[] {
  const specs: Array<{ period: StatsPeriod; startAt: string; endAt: string }> = [
    { period: '24h', startAt: options.todayWindow.startAt, endAt: options.todayWindow.endAt },
    { period: '7d', startAt: localDayOffsetStartIso(options.now, -(7 - 1)), endAt: options.windowsEndAt },
    { period: '1mo', startAt: options.windowsStartIso, endAt: options.windowsEndAt },
  ]
  return specs.map((spec) => buildWindow(spec.period, spec.startAt, spec.endAt, options))
}

function buildWindow(
  period: StatsPeriod,
  startAt: string,
  endAt: string,
  options: {
    allEventsRows: StatsEventRow[]
    taskIntervalRows: StatsTaskIntervalRow[]
    tpsSamples: ExecutionTpsSample[]
    limit: number
    resolveDisplayNames?: TaskRunDisplayNameResolver
  },
): StatsWindowSummary {
  const startMs = new Date(startAt).getTime()
  const endMs = new Date(endAt).getTime()
  let dispatchCount = 0
  let totalTokens = 0
  // Group by an explicit shared identity or a namespaced provider-local one;
  // `profile` is later emitted as the legacy alias equal to the model. Ineligible
  // rows are omitted from model rankings but still counted in totals.
  const modelMap = new Map<string, WindowModelAccumulator>()

  for (const row of options.allEventsRows) {
    const tsMs = new Date(row.created_at).getTime()
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs >= endMs) continue

    const persisted = eligibleModelIdentity(row)
    if (row.type === 'dispatch') {
      dispatchCount++
      if (!persisted) continue
      const identity = resolveStatsModelIdentity(persisted, options.resolveDisplayNames)
      const g = ensureWindowModel(modelMap, identity)
      recordModelDisplay(g, identity)
      g.runCount++
    } else if (row.type === 'turn_usage') {
      const inputTokens = row.u_input + row.u_cached
      const outputTokens = row.u_output
      totalTokens += inputTokens + outputTokens
      if (!persisted) continue
      const identity = resolveStatsModelIdentity(persisted, options.resolveDisplayNames)
      const g = ensureWindowModel(modelMap, identity)
      recordModelDisplay(g, identity)
      g.inputTokens += inputTokens
      g.outputTokens += outputTokens
    }
  }

  // Attach response-paired TPS samples for this window to the same model
  // display grouping used for tokens/runs, resolved through the existing
  // identity resolver. Ended-but-outside-window samples are filtered by endedAt.
  for (const sample of options.tpsSamples) {
    const endedMs = new Date(sample.endedAt).getTime()
    if (!Number.isFinite(endedMs) || endedMs < startMs || endedMs >= endMs) continue
    const identity = resolveStatsModelIdentity(
      { provider: sample.provider, model: sample.model },
      options.resolveDisplayNames,
    )
    const g = ensureWindowModel(modelMap, identity)
    recordModelDisplay(g, identity)
    g.tpsSamples.push(sample)
  }

  const byProfile: StatsWindowProfileRow[] = [...modelMap.entries()]
    .map(([, g]) => {
      const item: StatsWindowProfileRow = {
        profile: g.model,
        model: g.model,
        runCount: g.runCount,
        totalTokens: g.inputTokens + g.outputTokens,
      }
      // Same median calculation and sample filter as local routing; fewer than
      // 3 usable samples omit the aggregate TPS entirely.
      const estimate = estimateTps(g.tpsSamples)
      if (estimate) item.averageTps = estimate.tps
      applyModelDisplay(g, item)
      return item
    })
    .sort((a, b) => {
      const diff = b.totalTokens - a.totalTokens
      if (diff !== 0) return diff
      return a.model.localeCompare(b.model)
    })
    .slice(0, options.limit)

  const taskStats = buildTaskStats(startMs, endMs, options.taskIntervalRows, options.limit)

  return { period, startAt, endAt, dispatchCount, totalTokens, byProfile, taskStats }
}

function ensureWindowModel(
  modelMap: Map<string, WindowModelAccumulator>,
  identity: StatsModelIdentity,
): WindowModelAccumulator {
  let g = modelMap.get(identity.key)
  if (!g) {
    g = {
      model: identity.model,
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      tpsSamples: [],
      modelDisplayNames: new Set<string>(),
      providerDisplayNames: new Set<string>(),
    }
    modelMap.set(identity.key, g)
  }
  return g
}

function buildTaskStats(
  startMs: number,
  endMs: number,
  taskIntervalRows: StatsTaskIntervalRow[],
  limit: number,
): StatsWindowTaskStats {
  const byTask = new Map<string, TaskIntervalAccumulator>()
  let totalDurationMs = 0
  const byBuiltin = new Map<string, TaskIntervalAccumulator>()
  let builtinTotalDurationMs = 0

  for (const row of taskIntervalRows) {
    const durationMs = clampedOverlapMs(row, startMs, endMs)
    if (durationMs === undefined) continue
    const taskId = normalizeTaskName(row.template)
    const source = taskSourceOf(row.definition_source)

    totalDurationMs += durationMs
    const allKey = `${source}\u0000${taskId}`
    const allAcc = byTask.get(allKey)
    if (allAcc) {
      allAcc.runCount++
      allAcc.durationMs += durationMs
    } else {
      byTask.set(allKey, { taskId, source, runCount: 1, durationMs })
    }

    if (source === 'builtin') {
      builtinTotalDurationMs += durationMs
      const builtinAcc = byBuiltin.get(taskId)
      if (builtinAcc) {
        builtinAcc.runCount++
        builtinAcc.durationMs += durationMs
      } else {
        byBuiltin.set(taskId, { taskId, source: 'builtin', runCount: 1, durationMs })
      }
    }
  }

  return {
    totalDurationMs,
    byTask: rankTaskRows(byTask, limit),
    builtinTotalDurationMs,
    byBuiltinTask: rankTaskRows(byBuiltin, limit),
  }
}

function rankTaskRows(accumulators: Map<string, TaskIntervalAccumulator>, limit: number): TaskWindowRow[] {
  return [...accumulators.values()]
    .map((a) => ({
      taskId: a.taskId,
      source: a.source,
      runCount: a.runCount,
      durationMs: a.durationMs,
      averageDurationMs: a.durationMs / a.runCount,
    }))
    .sort((a, b) => {
      const diff = b.durationMs - a.durationMs
      if (diff !== 0) return diff
      const nameDiff = a.taskId.localeCompare(b.taskId)
      if (nameDiff !== 0) return nameDiff
      return a.source.localeCompare(b.source)
    })
    .slice(0, limit)
}

function rankTaskDuration(durationByTask: Map<string, number>, limit: number): Array<{ taskName: string; durationMs: number }> {
  return [...durationByTask.entries()]
    .map(([taskName, durationMs]) => ({ taskName, durationMs }))
    .sort((a, b) => {
      const diff = b.durationMs - a.durationMs
      if (diff !== 0) return diff
      return a.taskName.localeCompare(b.taskName)
    })
    .slice(0, limit)
}
