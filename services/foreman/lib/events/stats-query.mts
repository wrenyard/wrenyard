import { get as dbGet, query as dbQuery } from '../db/connection.mts'
import { MAX_STATS_SUMMARY_DAYS } from '../protocol/methods/stats.mts'
import { readTaskRunMetadata } from '../core/task/run-metadata.mts'
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
  data: string | null
  created_at: string
  profile: string | null
  resolved_profile: string | null
  template: string | null
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
  task: string
  source: 'builtin' | 'project' | 'unknown'
  status: string
  created_at: string
  started_at?: string
  finished_at?: string
  resolved?: TaskResolvedDispatch
  usage: TaskUsage
}

/**
 * Conservative upper bound on the additive recent-run ledger so the stats
 * summary keeps exposing individual runs for Desktop without ever scanning an
 * unbounded number of task rows.
 */
const RECENT_RUNS_CAP = 25

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

export function readStatsSummary(params: { days?: number; limit?: number } = {}, now = new Date()): StatsSummaryResult {
  const days = params.days ?? 7
  const limit = params.limit ?? 20

  if (!Number.isInteger(days) || days < 1 || days > MAX_STATS_SUMMARY_DAYS) {
    throw new Error(`Invalid days: ${days}. Must be an integer between 1 and ${MAX_STATS_SUMMARY_DAYS}.`)
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error(`Invalid limit: ${limit}. Must be an integer between 1 and 50.`)
  }

  const todayWindow = localDayWindow(now)
  const dailyBuckets = buildDailyBuckets(now, days)

  // Keep the fixed 31-local-day period window while allowing the daily
  // activity projection to extend to a full year.
  const windowsStartIso = localDayOffsetStartIso(now, -(31 - 1))
  const dailyStartIso = localDayOffsetStartIso(now, -(days - 1))
  const fullStartIso = days > 31 ? dailyStartIso : windowsStartIso
  const fullEndIso = todayWindow.endAt

  // One bounded events query over the longest requested projection.
  const allEventsRows = dbQuery<StatsEventRow>(
    `SELECT e.type, e.data, e.created_at, ex.profile, ex.resolved_profile, COALESCE(t.template, ex_t.template) AS template
     FROM events e INDEXED BY idx_event_created_at
     LEFT JOIN executions ex ON e.execution_id = ex.id
     LEFT JOIN tasks t ON e.task_id = t.id
     LEFT JOIN tasks ex_t ON ex.task_id = ex_t.id
     WHERE e.type IN ('dispatch', 'turn_usage')
       AND e.created_at >= ? AND e.created_at < ?`,
    fullStartIso,
    fullEndIso,
  )

  // One bounded terminal+active task interval scan over the same window.
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
    fullStartIso,
    fullEndIso,
    now.toISOString(),
    fullEndIso,
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
      const data = parseJsonValue(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      bucket.inputTokens += fullInputTokens(data as JsonRecord)
      bucket.outputTokens += nonNegativeNumber((data as JsonRecord).output_tokens)
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
  }

  // --- TODAY RANKINGS: filter the full event set to today only ---
  const todayRows = allEventsRows.filter((row) => localDayKeyOf(row.created_at) === todayWindow.dayKey)

  // --- byProfile: group by execution profile ---
  const profileMap = new Map<string, { dispatchCount: number; inputTokens: number; outputTokens: number }>()
  for (const row of todayRows) {
    const profile = (row.profile && row.profile.trim()) ? row.profile.trim() : 'unknown'
    let g = profileMap.get(profile)
    if (!g) {
      g = { dispatchCount: 0, inputTokens: 0, outputTokens: 0 }
      profileMap.set(profile, g)
    }
    if (row.type === 'dispatch') {
      g.dispatchCount++
    } else if (row.type === 'turn_usage') {
      const data = parseJsonValue(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      g.inputTokens += fullInputTokens(data as JsonRecord)
      g.outputTokens += nonNegativeNumber((data as JsonRecord).output_tokens)
    }
  }

  const byProfile: ProfileRankingItem[] = [...profileMap.entries()]
    .map(([profile, g]) => ({
      profile,
      dispatchCount: g.dispatchCount,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.inputTokens + g.outputTokens,
    }))
    .sort((a, b) => {
      const diff = b.totalTokens - a.totalTokens
      if (diff !== 0) return diff
      return a.profile.localeCompare(b.profile)
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
      const data = parseJsonValue(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      g.inputTokens += fullInputTokens(data as JsonRecord)
      g.outputTokens += nonNegativeNumber((data as JsonRecord).output_tokens)
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

  // --- FIXED PERIOD WINDOWS: project 24h/7d/1mo in memory from the same scans
  const windows = buildWindows({
    todayWindow,
    windowsStartIso,
    windowsEndAt: fullEndIso,
    allEventsRows,
    taskIntervalRows,
    now,
    limit,
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
    recentRuns: readRecentTaskRunLedger(Math.min(limit, RECENT_RUNS_CAP)),
  }
}

/**
 * Bounded recent per-run ledger for the stats summary. Reuses the shared
 * run-metadata helper so each row's resolved dispatch and exact TaskUsage are
 * projected by the canonical DB-backed projection rather than recomputed here.
 * Ordering follows the existing indexed task recency (ended_at then created_at)
 * and the result is capped by RECENT_RUNS_CAP.
 */
function readRecentTaskRunLedger(recentLimit: number): TaskRunLedgerRow[] {
  const rows = dbQuery<{
    id: string
    template: string | null
    project: string | null
    status: string
    created_at: string
    ended_at: string | null
    definition_source: string | null
    started_at: string | null
  }>(
    `SELECT t.id AS id, t.template AS template, t.project AS project, t.status AS status,
            t.created_at AS created_at, t.ended_at AS ended_at, t.definition_source AS definition_source,
            ex.started_at AS started_at
     FROM tasks t
     LEFT JOIN (SELECT task_id, MIN(started_at) AS started_at FROM executions GROUP BY task_id) ex
       ON ex.task_id = t.id
     ORDER BY COALESCE(t.ended_at, t.created_at) DESC, t.created_at DESC
     LIMIT ?`,
    recentLimit,
  )

  return rows.map((row) => {
    const meta = readTaskRunMetadata(row.id)
    const ledger: TaskRunLedgerRow = {
      task_run_id: row.id,
      task: normalizeTaskName(row.template),
      source: taskSourceOf(row.definition_source),
      status: row.status,
      created_at: row.created_at,
      usage: meta.usage,
    }
    if (row.started_at) ledger.started_at = row.started_at
    if (row.ended_at) ledger.finished_at = row.ended_at
    if (meta.resolved) ledger.resolved = meta.resolved
    return ledger
  })
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
 * A turn_usage event contributes to the profile average TPS only when it
 * carries the exact three-field versioned contract: token_scope exactly
 * 'agent_turn', duration_scope exactly 'agent_turn', and tps_contract exactly
 * 'agent_turn_v1', with output_tokens an integer >= 0 and a finite, positive
 * duration_ms. The single weighted formula
 *   1000 * sum(output_tokens) / sum(duration_ms)
 * stays client-agnostic and applies only to the common contract; legacy and
 * unversioned events never contribute to the TPS numerator/denominator.
 */
function parseAgentTurnUsage(data: JsonRecord): { outputTokens: number; durationMs: number } | undefined {
  const outputTokens = data.output_tokens
  const durationMs = data.duration_ms
  const validOutputTokens = typeof outputTokens === 'number' && Number.isInteger(outputTokens) && outputTokens >= 0
  const validDurationMs = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
  const validContract = data.token_scope === 'agent_turn'
    && data.duration_scope === 'agent_turn'
    && data.tps_contract === 'agent_turn_v1'
  if (!validOutputTokens || !validDurationMs || !validContract) return undefined
  return { outputTokens, durationMs }
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
  now: Date
  limit: number
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
  options: { allEventsRows: StatsEventRow[]; taskIntervalRows: StatsTaskIntervalRow[]; limit: number },
): StatsWindowSummary {
  const startMs = new Date(startAt).getTime()
  const endMs = new Date(endAt).getTime()
  let dispatchCount = 0
  let totalTokens = 0
  const profileMap = new Map<
    string,
    { runCount: number; inputTokens: number; outputTokens: number; tpsOutputTokens: number; tpsDurationMs: number }
  >()

  for (const row of options.allEventsRows) {
    const tsMs = new Date(row.created_at).getTime()
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs >= endMs) continue

    if (row.type === 'dispatch') {
      dispatchCount++
      const profile = normalizeResolvedProfile(row.resolved_profile)
      if (!profile) continue
      const g = ensureWindowProfile(profileMap, profile)
      g.runCount++
    } else if (row.type === 'turn_usage') {
      const data = parseJsonValue(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const record = data as JsonRecord
      const inputTokens = fullInputTokens(record)
      const outputTokens = nonNegativeNumber(record.output_tokens)
      totalTokens += inputTokens + outputTokens
      const profile = normalizeResolvedProfile(row.resolved_profile)
      if (!profile) continue
      const g = ensureWindowProfile(profileMap, profile)
      g.inputTokens += inputTokens
      g.outputTokens += outputTokens
      const usage = parseAgentTurnUsage(record)
      if (usage) {
        g.tpsOutputTokens += usage.outputTokens
        g.tpsDurationMs += usage.durationMs
      }
    }
  }

  const byProfile: StatsWindowProfileRow[] = [...profileMap.entries()]
    .map(([profile, g]) => {
      const item: StatsWindowProfileRow = {
        profile,
        runCount: g.runCount,
        totalTokens: g.inputTokens + g.outputTokens,
      }
      if (g.tpsDurationMs > 0) {
        const averageTps = (1000 * g.tpsOutputTokens) / g.tpsDurationMs
        if (Number.isFinite(averageTps)) item.averageTps = averageTps
      }
      return item
    })
    .sort((a, b) => {
      const diff = b.totalTokens - a.totalTokens
      if (diff !== 0) return diff
      return a.profile.localeCompare(b.profile)
    })
    .slice(0, options.limit)

  const taskStats = buildTaskStats(startMs, endMs, options.taskIntervalRows, options.limit)

  return { period, startAt, endAt, dispatchCount, totalTokens, byProfile, taskStats }
}

function ensureWindowProfile(
  profileMap: Map<string, { runCount: number; inputTokens: number; outputTokens: number; tpsOutputTokens: number; tpsDurationMs: number }>,
  profile: string,
): { runCount: number; inputTokens: number; outputTokens: number; tpsOutputTokens: number; tpsDurationMs: number } {
  let g = profileMap.get(profile)
  if (!g) {
    g = { runCount: 0, inputTokens: 0, outputTokens: 0, tpsOutputTokens: 0, tpsDurationMs: 0 }
    profileMap.set(profile, g)
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

export interface TrustedSpeedSample {
  /** Resolved profile the samples were observed under. */
  resolvedProfile: string
  /** Number of valid trusted `agent_turn_v1` usage samples (NOT dispatch count). */
  sampleCount: number
  /** Average turns-per-second over the trusted usage samples. */
  tps: number
  /** ISO timestamp of the latest real trusted sample; never synthesized. */
  checkedAt: string
}

/**
 * Rolling 31-day trusted `agent_turn_v1` speed samples grouped by resolved
 * profile. Only `turn_usage` events whose exact three-field contract is
 * `agent_turn_v1` (reusing `parseAgentTurnUsage`) count as samples; plain
 * `dispatch` events and legacy/unversioned usage are excluded, so `sampleCount`
 * is the count of valid usage samples rather than dispatches. `checkedAt` is the
 * latest real sample timestamp, never fabricated. Existing stats (recentRuns,
 * windows, rankings) are untouched.
 */
export function readTrustedSpeedSamples31d(now = new Date()): TrustedSpeedSample[] {
  const window = localDayWindow(now)
  const startIso = localDayOffsetStartIso(now, -(31 - 1))
  const endIso = window.endAt
  const rows = dbQuery<StatsEventRow>(
    `SELECT e.type, e.data, e.created_at, ex.resolved_profile
     FROM events e INDEXED BY idx_event_created_at
     LEFT JOIN executions ex ON e.execution_id = ex.id
     WHERE e.type = 'turn_usage'
       AND e.created_at >= ? AND e.created_at < ?`,
    startIso,
    endIso,
  )
  const byProfile = new Map<string, { samples: number; outputTokens: number; durationMs: number; latestAt: string }>()
  for (const row of rows) {
    const data = parseJsonValue(row.data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const usage = parseAgentTurnUsage(data as JsonRecord)
    if (!usage) continue
    const profile = normalizeResolvedProfile(row.resolved_profile)
    if (!profile) continue
    const g = byProfile.get(profile) ?? { samples: 0, outputTokens: 0, durationMs: 0, latestAt: '' }
    g.samples++
    g.outputTokens += usage.outputTokens
    g.durationMs += usage.durationMs
    if (row.created_at > g.latestAt) g.latestAt = row.created_at
    byProfile.set(profile, g)
  }
  return [...byProfile.entries()].map(([resolvedProfile, g]) => ({
    resolvedProfile,
    sampleCount: g.samples,
    tps: g.durationMs > 0 ? (1000 * g.outputTokens) / g.durationMs : 0,
    checkedAt: g.latestAt,
  }))
}
