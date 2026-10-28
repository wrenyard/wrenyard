import { get as dbGet, getDb, query as dbQuery, run as dbRun, tx as dbTx } from '../db/connection.mts'
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
  StatsSummaryFreshness,
  StatsPeriod,
  StatsWindowSummary,
  StatsWindowProfileRow,
  StatsWindowTaskStats,
  TaskWindowRow,
} from '../protocol/methods/stats.mts'
import type { TaskResolvedDispatch, TaskUsage } from '../protocol/task-run-metadata.mts'

export type JsonRecord = Record<string, unknown>

/**
 * One pre-aggregated stats_event_rollup cell: the summed contribution of all
 * projected events of one type on one local day under one template/model
 * identity. `event_count` counts dispatch rows only; `input_tokens` is the
 * turn_usage u_input+u_cached sum or the effective gateway fb_input+fb_cached
 * sum (already gated by whole-run client-report flags and re-attributed by
 * the dirty-run reconcile); identity columns store '' for unattributed rows.
 */
interface StatsEventRollupRow {
  day_key: string
  type: string
  template: string
  provider: string
  model: string
  model_id: string
  event_count: number
  input_tokens: number
  output_tokens: number
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
  /** Exact persisted current execution id of the task run, when one exists. */
  executionId?: string
  /** Resolved dispatch mode of that execution ('gateway' | 'native'), when recorded. */
  executionMode?: 'native' | 'gateway'
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
  /**
   * Projection watermark ISO the snapshot was consistent up to; surfaced as
   * `freshness.asOf` when the entry is served stale during catchup.
   */
  asOf?: string
}

const summaryCache = new WeakMap<ForemanDatabase, Map<string, SummaryCacheEntry>>()

// ---------------------------------------------------------------------------
// Incremental stats projections
//
// stats.summary historically re-ran a 31-local-day MATERIALIZED event scan on
// every cache miss, so its in-memory stamp included total_changes() and any
// unrelated write forced a full recompute. The persisted projection tables
// (stats_event_projection, stats_task_interval, stats_dirty_runs,
// stats_projection_meta) hold the same per-row semantics pre-computed under a
// monotone events.id watermark. Relevant event inserts and task status
// transitions mark bounded dirty work in their own transaction; reads drain it
// in capped batches, so unrelated writes never rescale the work and the read
// path never materializes history.
// ---------------------------------------------------------------------------

/** Format version stored in stats_projection_meta; a mismatch resets and rebuilds the projection. */
const STATS_PROJECTION_FORMAT = '2'

/** Max events applied to the projection per drain batch; keeps read/startup bounded. */
const STATS_PROJECTION_BATCH_EVENTS = 512
/** Max dirty runs reconciled per drain batch. */
const STATS_PROJECTION_BATCH_RUNS = 64
/** Max dirty task intervals upserted per drain batch. */
const STATS_PROJECTION_BATCH_TASKS = 256

const SQL_PROJ_META_GET = `SELECT value FROM stats_projection_meta WHERE key = ?`
const SQL_PROJ_META_SET = `INSERT OR REPLACE INTO stats_projection_meta (key, value) VALUES (?, ?)`

/**
 * Pre-aggregated per-day rollup of projected events, keyed by local day,
 * event type, and the template/model identity the projection resolved. Rows
 * are folded in inside the same committed drain transaction that advances the
 * event watermark (and re-attributed in the dirty-run reconcile), so the
 * summary read composes day-granularity aggregates instead of scanning and
 * mapping every projected event row on each miss. Created lazily here because
 * the projection lifecycle owns it; a format reset wipes and rebuilds it.
 */
const SQL_EVENT_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS stats_event_rollup (
  day_key TEXT NOT NULL,
  type TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_key, type, template, provider, model, model_id)
)`

/**
 * Sealed days invalidated by a committed projection correction (a late event
 * drained into an already-sealed day_key, or a dirty-run fallback
 * re-attribution that moved fb_* on a sealed day). Rows are marked inside the
 * same committed drain transaction that changed the rollup, and re-sealed
 * from the committed rollup in bounded batches; the summary stamp reads the
 * pending count so a dirtied sealed day can never be served as fresh.
 */
const SQL_DIRTY_DAYS_DDL = `CREATE TABLE IF NOT EXISTS stats_dirty_days (
  day_key TEXT PRIMARY KEY
)`

/**
 * Missing (never-sealed) days whose first seal is deferred because their
 * contributing projection rows are not fully drained yet. Deferring keeps the
 * day out of stats_day_cache so markSealedDayDirty still activates for later
 * corrections, and the row is sealed from the committed projection by the
 * next bounded drain pass instead of publishing a partial first seal.
 */
const SQL_DEFERRED_DAYS_DDL = `CREATE TABLE IF NOT EXISTS stats_deferred_days (
  day_key TEXT PRIMARY KEY
)`

let eventRollupEnsured = false

function ensureEventRollup(): void {
  if (eventRollupEnsured) return
  dbRun(SQL_EVENT_ROLLUP_DDL)
  dbRun(SQL_DIRTY_DAYS_DDL)
  dbRun(SQL_DEFERRED_DAYS_DDL)
  eventRollupEnsured = true
}

/**
 * Mark a sealed day dirty inside the caller's committed transaction. No-op
 * when the day is not yet sealed, so missing-key sealing semantics are
 * unchanged. Advances the sealed_day_version stamp term atomically so the
 * summary cache invalidates even before the re-seal commits.
 */
function markSealedDayDirty(dayKey: string): void {
  const sealed = dbGet<{ day_key: string }>(`SELECT day_key FROM stats_day_cache WHERE day_key = ?`, dayKey)
  if (!sealed) return
  dbRun(`INSERT OR IGNORE INTO stats_dirty_days (day_key) VALUES (?)`, dayKey)
  writeProjectionMeta('sealed_day_version', String(Number(readProjectionMeta('sealed_day_version') ?? '0') + 1))
}

/** Fold one event's aggregate contribution into its day/type/identity rollup cell. */
function rollupEventContribution(row: {
  dayKey: string
  type: string
  template: string | null
  provider: string | null
  model: string | null
  modelId: string | null
  count: number
  inputTokens: number
  outputTokens: number
}): void {
  dbRun(
    `INSERT INTO stats_event_rollup (day_key, type, template, provider, model, model_id, event_count, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day_key, type, template, provider, model, model_id) DO UPDATE SET
       event_count = event_count + excluded.event_count,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
    row.dayKey,
    row.type,
    row.template ?? '',
    row.provider ?? '',
    row.model ?? '',
    row.modelId ?? '',
    row.count,
    row.inputTokens,
    row.outputTokens,
  )
}

function readProjectionMeta(key: string): string | undefined {
  return dbGet<{ value: string }>(SQL_PROJ_META_GET, key)?.value
}

function writeProjectionMeta(key: string, value: string): void {
  dbRun(SQL_PROJ_META_SET, key, value)
}

/** True while the cold backfill is still applying the historical event range. */
export function statsProjectionBackfilling(): boolean {
  return readProjectionMeta('backfilling') === '1'
}

function projectionWatermark(): number {
  const value = Number(readProjectionMeta('event_watermark') ?? '0')
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** Wipe all projection tables and reset the watermark; used on format mismatch. */
function resetStatsProjection(): void {
  dbTx(() => {
    dbRun(`DELETE FROM stats_event_projection`)
    dbRun(`DELETE FROM stats_task_interval`)
    dbRun(`DELETE FROM stats_dirty_runs`)
    dbRun(`DELETE FROM stats_event_rollup`)
    dbRun(`DELETE FROM stats_dirty_days`)
    dbRun(`DELETE FROM stats_deferred_days`)
    writeProjectionMeta('format', STATS_PROJECTION_FORMAT)
    writeProjectionMeta('event_watermark', '0')
    writeProjectionMeta('backfilling', '1')
  })
}

/** Ensure the projection format matches this build; returns whether the projection can serve reads. */
function ensureStatsProjection(): void {
  ensureEventRollup()
  if (readProjectionMeta('format') !== STATS_PROJECTION_FORMAT) resetStatsProjection()
}

/**
 * Mark bounded dirty projection work inside an existing write transaction.
 * Called only after a genuinely new row landed (events INSERT changes===1, or
 * a tasks transition whose UPDATE matched), so duplicate replays never enqueue
 * work. `taskRunId` is the canonical run a turn_usage/gateway event belongs to
 * when resolvable; marking it forces the bounded per-run fallback recompute.
 */
export function markStatsProjectionDirty(options: {
  taskRunId?: string | null
  taskTransition?: { taskRunId: string; status: string }
}): void {
  if (options.taskRunId) {
    dbRun(`INSERT OR IGNORE INTO stats_dirty_runs (task_run_id) VALUES (?)`, options.taskRunId)
  }
  if (options.taskTransition) {
    dbRun(`INSERT OR IGNORE INTO stats_dirty_runs (task_run_id) VALUES (?)`, options.taskTransition.taskRunId)
  }
}

const SQL_PROJ_PENDING_EVENTS = `SELECT e.id, e.type, e.created_at, e.execution_id, e.task_id, e.data
  FROM events e
  WHERE e.id > ? AND e.type IN ('dispatch','turn_usage','gateway.request.completed')
  ORDER BY e.id ASC
  LIMIT ?`

interface ProjectionEventRow {
  id: number
  type: string
  created_at: string
  execution_id: string | null
  task_id: string | null
  data: string | null
}

/**
 * Apply up to `batch` pending summary-relevant events to the projection.
 * Per-row semantics mirror the retired live scan: turn_usage partitions use
 * the cached-total/split union and an explicit zero counts as reported;
 * gateway completions contribute only status-200 measured partitions, and
 * whether each partition lands is resolved per-run at read time via the
 * dirty-run reconcile (stored as fb_* candidates gated by the run's current
 * has_* flags). Template/model identity is resolved per event row exactly as
 * the old CTE did.
 * Returns the number of event rows applied.
 */
function drainStatsProjectionEvents(batch: number): number {
  const watermark = projectionWatermark()
  const rows = dbQuery<ProjectionEventRow>(SQL_PROJ_PENDING_EVENTS, watermark, batch)
  if (rows.length === 0) return 0

  const executionIds = [...new Set(rows.map((r) => r.execution_id).filter((v): v is string => !!v))]
  const nestedExecIds = new Set<string>()
  const gatewayExecData = new Map<number, { status: number | undefined; executionId: string | undefined; usage: JsonRecord | undefined }>()
  for (const row of rows) {
    if (row.type !== 'gateway.request.completed') continue
    const parsed = parseJsonValue(row.data)
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {}
    if (record.schema_version !== 'foreman.event.v1') { gatewayExecData.set(row.id, { status: undefined, executionId: undefined, usage: undefined }); continue }
    const inner = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as JsonRecord : {}
    const executionId = nonBlankString(inner.executionId)
    if (executionId) nestedExecIds.add(executionId)
    const usage = inner.usage && typeof inner.usage === 'object' && !Array.isArray(inner.usage) ? inner.usage as JsonRecord : undefined
    gatewayExecData.set(row.id, {
      status: isMeasuredNumber(inner.status) ? inner.status as number : undefined,
      executionId,
      usage,
    })
  }

  const allExecIds = [...new Set([...executionIds, ...nestedExecIds])]
  const taskByExec = new Map<string, string>()
  if (allExecIds.length > 0) {
    const placeholders = allExecIds.map(() => '?').join(', ')
    for (const row of dbQuery<{ id: string; task_id: string | null }>(
      `SELECT id, task_id FROM executions WHERE id IN (${placeholders})`, ...allExecIds,
    )) {
      if (row.task_id) taskByExec.set(row.id, row.task_id)
    }
  }

  const taskIds = [...new Set([
    ...rows.map((r) => r.task_id).filter((v): v is string => !!v),
    ...[...taskByExec.values()],
  ])]
  const templateByTask = new Map<string, string | null>()
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(', ')
    for (const row of dbQuery<{ id: string; template: string | null }>(
      `SELECT id, template FROM tasks WHERE id IN (${placeholders})`, ...taskIds,
    )) {
      templateByTask.set(row.id, row.template)
    }
  }

  const dispatchIds = [...new Set(rows.map((r) =>
    r.type === 'gateway.request.completed'
      ? (gatewayExecData.get(r.id)?.executionId ?? r.execution_id)
      : r.execution_id,
  ).filter((v): v is string => !!v))]
  const identityByExec = new Map<string, { provider: string | null; model: string | null; model_id: string | null }>()
  if (dispatchIds.length > 0) {
    const placeholders = dispatchIds.map(() => '?').join(', ')
    for (const row of dbQuery<{ execution_id: string; provider: string | null; model: string | null; model_id: string | null }>(
      `SELECT execution_id, provider, model, model_id FROM task_run_attempt_dispatch WHERE execution_id IN (${placeholders})`,
      ...dispatchIds,
    )) {
      identityByExec.set(row.execution_id, row)
    }
  }

  dbTx(() => {
    const insert = getDb().prepare<unknown[]>(
      `INSERT OR REPLACE INTO stats_event_projection (
         event_id, day_key, created_at, type, task_run_id, template,
         provider, model, model_id,
         u_input, u_cached, u_output, fb_input, fb_cached, fb_output,
         cand_fb_input, cand_fb_cached, cand_fb_output
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      let uInput = 0
      let uCached = 0
      let uOutput = 0
      let candInput = 0
      let candCached = 0
      let candOutput = 0
      let taskRunId = row.task_id
      if (row.type === 'turn_usage') {
        const parsed = parseJsonValue(row.data)
        const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : undefined
        if (record) {
          uInput = nonNegativeNumber(record.input_tokens)
          uCached = normalizedCachedTokens(record)
          uOutput = nonNegativeNumber(record.output_tokens)
        }
      } else if (row.type === 'gateway.request.completed') {
        const gw = gatewayExecData.get(row.id)
        const nestedId = gw?.executionId
        if (nestedId) taskRunId = taskByExec.get(nestedId) ?? taskRunId
        if (gw?.status === 200 && gw.usage) {
          const gwIn = nonNegativeNumber(gw.usage.input)
          const gwCached = isMeasuredNumber(gw.usage.cachedInput) ? gw.usage.cachedInput as number : 0
          candInput = Math.max(gwIn - gwCached, 0)
          candCached = isMeasuredNumber(gw.usage.cachedInput) ? gw.usage.cachedInput as number : 0
          candOutput = nonNegativeNumber(gw.usage.output)
        }
      }
      if (!taskRunId && row.execution_id) taskRunId = taskByExec.get(row.execution_id) ?? null
      const template = taskRunId ? templateByTask.get(taskRunId) ?? null : null
      const dispatchExecId = row.type === 'gateway.request.completed'
        ? (gatewayExecData.get(row.id)?.executionId ?? row.execution_id)
        : row.execution_id
      const identity = dispatchExecId ? identityByExec.get(dispatchExecId) : undefined
      // Effective fb_* starts at the raw candidate gated by the run's stored
      // flags (unknown run = never reported = full fallback); the dirty-run
      // drain rewrites it whenever the flags change.
      const stored = taskRunId ? readStoredRunFlags(taskRunId) : undefined
      const fbInput = stored?.input ? 0 : candInput
      const fbCached = stored?.cached ? 0 : candCached
      const fbOutput = stored?.output ? 0 : candOutput
      const dayKey = localDayKeyOf(row.created_at)
      insert.run(
        row.id,
        dayKey,
        row.created_at,
        row.type,
        taskRunId ?? null,
        template,
        identity?.provider ?? null,
        identity?.model ?? null,
        identity?.model_id ?? null,
        uInput,
        uCached,
        uOutput,
        fbInput,
        fbCached,
        fbOutput,
        candInput,
        candCached,
        candOutput,
      )
      // Fold this event's effective contribution into the day rollup in the
      // same commit that advances the watermark, so the summary read composes
      // bounded per-day aggregates and a watermark advance is always atomic
      // with its aggregate update.
      rollupEventContribution({
        dayKey,
        type: row.type,
        template,
        provider: identity?.provider ?? null,
        model: identity?.model ?? null,
        modelId: identity?.model_id ?? null,
        count: row.type === 'dispatch' ? 1 : 0,
        inputTokens: row.type === 'turn_usage' ? uInput + uCached
          : row.type === 'gateway.request.completed' ? fbInput + fbCached : 0,
        outputTokens: row.type === 'turn_usage' ? uOutput
          : row.type === 'gateway.request.completed' ? fbOutput : 0,
      })
      // A committed event landing on an already-sealed day invalidates that
      // sealed aggregate; mark it dirty in this same transaction so the
      // bounded re-seal (and the stamp) see a consistent correction state.
      markSealedDayDirty(dayKey)
      // Only turn_usage rows can change a run's client-report flags, and a
      // gateway completion needs the run's flags resolved at least once; both
      // cases are covered by dirty-marking those two types here (a dispatch
      // never affects fallback attribution). turn_usage inserts also mark at
      // the writer site, so this is belt-and-suspenders for backfilled rows.
      if (taskRunId && (row.type === 'turn_usage' || row.type === 'gateway.request.completed')) {
        dbRun(`INSERT OR IGNORE INTO stats_dirty_runs (task_run_id) VALUES (?)`, taskRunId)
      }
    }
    const lastId = rows[rows.length - 1].id
    writeProjectionMeta('event_watermark', String(lastId))
  })
  return rows.length
}

interface DirtyRunFlags { input: boolean; cached: boolean; output: boolean }

/**
 * Recompute one run's whole-run client-report flags over all its executions'
 * turn_usage rows (bounded by run size, never by time): a valid non-negative
 * field — including an explicit zero — counts as reported; the cached
 * partition is the normalized total/split union.
 */
function readDirtyRunFlags(taskRunId: string): DirtyRunFlags {
  const flags: DirtyRunFlags = { input: false, cached: false, output: false }
  for (const row of dbQuery<{ data: string | null }>(
    `SELECT ev.data AS data
     FROM executions ex
     JOIN events ev ON ev.execution_id = ex.id AND ev.type = 'turn_usage'
     WHERE ex.task_id = ?`,
    taskRunId,
  )) {
    const parsed = parseJsonValue(row.data)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as JsonRecord
    if (isMeasuredNumber(record.input_tokens)) flags.input = true
    if (
      isMeasuredNumber(record.cached_input_tokens)
      || isMeasuredNumber(record.cache_read_input_tokens)
      || isMeasuredNumber(record.cache_creation_input_tokens)
    ) flags.cached = true
    if (isMeasuredNumber(record.output_tokens)) flags.output = true
    if (flags.input && flags.cached && flags.output) break
  }
  return flags
}

/** Persist a run's resolved client-report flags; a NULL row means fallback on all partitions. */
function writeDirtyRunFlags(taskRunId: string, flags: DirtyRunFlags): void {
  writeProjectionMeta(`run_flags:${taskRunId}`, `${flags.input ? 1 : 0}${flags.cached ? 1 : 0}${flags.output ? 1 : 0}`)
}

function readStoredRunFlags(taskRunId: string): DirtyRunFlags | undefined {
  const value = readProjectionMeta(`run_flags:${taskRunId}`)
  if (value === undefined || value.length !== 3) return undefined
  return { input: value[0] === '1', cached: value[1] === '1', output: value[2] === '1' }
}

/**
 * Drain up to `batch` dirty runs: recompute each run's client-report flags and
 * rewrite the effective fallback attribution of that run's projected gateway
 * events by adjusting their fb_* columns between the stored candidate values
 * and zero. Idempotent: equal flags recompute to a no-op UPDATE.
 * Returns runs reconciled.
 */
function drainStatsProjectionRuns(batch: number): number {
  const runs = dbQuery<{ task_run_id: string }>(
    `SELECT task_run_id FROM stats_dirty_runs ORDER BY rowid ASC LIMIT ?`, batch,
  )
  if (runs.length === 0) return 0
  dbTx(() => {
    const del = getDb().prepare<unknown[]>(`DELETE FROM stats_dirty_runs WHERE task_run_id = ?`)
    const updateFb = getDb().prepare<unknown[]>(
      `UPDATE stats_event_projection
       SET fb_input = ?, fb_cached = ?, fb_output = ?
       WHERE event_id = ?`,
    )
    const selectCand = getDb().prepare<unknown[]>(
      `SELECT event_id, day_key, template, provider, model, model_id,
              fb_input, fb_cached, fb_output,
              cand_fb_input, cand_fb_cached, cand_fb_output
       FROM stats_event_projection
       WHERE type = 'gateway.request.completed' AND task_run_id = ?`,
    )
    for (const { task_run_id: runId } of runs) {
      const flags = readDirtyRunFlags(runId)
      const prior = readStoredRunFlags(runId)
      writeDirtyRunFlags(runId, flags)
      if (!prior || prior.input !== flags.input || prior.cached !== flags.cached || prior.output !== flags.output) {
        // Re-attribute each projected gateway event's effective fallback
        // between its stored candidate values and zero under the new flags,
        // and apply the token delta to the day rollup so a late correction
        // keeps the pre-aggregated read path consistent.
        for (const event of selectCand.all(runId) as {
          event_id: number
          day_key: string
          template: string | null
          provider: string | null
          model: string | null
          model_id: string | null
          fb_input: number
          fb_cached: number
          fb_output: number
          cand_fb_input: number
          cand_fb_cached: number
          cand_fb_output: number
        }[]) {
          const newInput = flags.input ? 0 : event.cand_fb_input
          const newCached = flags.cached ? 0 : event.cand_fb_cached
          const newOutput = flags.output ? 0 : event.cand_fb_output
          updateFb.run(newInput, newCached, newOutput, event.event_id)
          const inputDelta = (newInput + newCached) - (event.fb_input + event.fb_cached)
          const outputDelta = newOutput - event.fb_output
          if (inputDelta !== 0 || outputDelta !== 0) {
            rollupEventContribution({
              dayKey: event.day_key,
              type: 'gateway.request.completed',
              template: event.template,
              provider: event.provider,
              model: event.model,
              modelId: event.model_id,
              count: 0,
              inputTokens: inputDelta,
              outputTokens: outputDelta,
            })
            // The whole-run fallback re-attribution changed a committed rollup
            // contribution; if that day is already sealed, mark it dirty in
            // this same transaction so its sealed row is rebuilt bounded.
            markSealedDayDirty(event.day_key)
          }
        }
      }
      del.run(runId)
    }
  })
  return runs.length
}

/** Backfill terminal task intervals for tasks that ended before the interval projection existed. */
function drainStatsProjectionTaskIntervals(batch: number): number {
  const rows = dbQuery<{ id: string; template: string | null; definition_source: string | null; status: string; created_at: string; ended_at: string }>(
    `SELECT t.id, t.template, t.definition_source, t.status, t.created_at, t.ended_at
     FROM tasks t
     WHERE t.status IN ('done','failed','cancelled','interrupted')
       AND t.ended_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM stats_task_interval s WHERE s.task_id = t.id)
     LIMIT ?`,
    batch,
  )
  if (rows.length === 0) return 0
  dbTx(() => {
    const insert = getDb().prepare<unknown[]>(
      `INSERT OR REPLACE INTO stats_task_interval (task_id, template, definition_source, status, created_at, effective_end)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      insert.run(row.id, row.template, row.definition_source, row.status, row.created_at, row.ended_at)
      // A committed interval on an already-sealed day invalidates its cached
      // terminal counts; mark it dirty in this same transaction so the
      // bounded re-seal recomputes from the full committed interval set once
      // the day's contributing projections are drained. INSERT OR IGNORE
      // makes the mark idempotent across replays.
      markSealedDayDirty(localDayKeyOf(row.ended_at))
    }
  })
  return rows.length
}

/** Max dirty sealed days re-sealed per drain pass; leftovers stay dirty for the next pass. */
const STATS_PROJECTION_BATCH_DIRTY_DAYS = 32

/**
 * Re-seal up to `batch` dirty sealed days from the committed projections:
 * dispatch/token totals come from stats_event_rollup for that one day_key
 * (already encoding the whole-run fallback partition semantics, including
 * late corrections), and terminal task outcomes from stats_task_interval
 * bounded to the day's window — the same buckets sealStatsDay fills, but
 * sourced from committed projections so a late correction is reflected.
 * Runs inside one committed transaction per call so a fresh read either
 * composes the corrected sealed row or still sees the day as dirty.
 * Returns days re-sealed.
 */
function drainStatsDirtySealedDays(batch: number): number {
  const dirty = dbQuery<{ day_key: string }>(
    `SELECT day_key FROM stats_dirty_days ORDER BY day_key ASC LIMIT ?`, batch,
  )
  if (dirty.length === 0) return 0
  const builtAt = new Date().toISOString()
  dbTx(() => {
    for (const { day_key: dayKey } of dirty) {
      upsertCommittedSealedDay(dayKey, builtAt)
      dbRun(`DELETE FROM stats_dirty_days WHERE day_key = ?`, dayKey)
    }
    writeProjectionMeta('sealed_day_version', String(Number(readProjectionMeta('sealed_day_version') ?? '0') + 1))
  })
  return dirty.length
}

/**
 * Write one day's sealed row from the committed projections: dispatch/token
 * totals from stats_event_rollup for that one day_key (already encoding the
 * whole-run gateway/client partition, including late dirty-run corrections),
 * and terminal outcomes from stats_task_interval bounded to the day's window.
 * This is the single per-day accounting contract shared by every sealing
 * path — initial/missing/cold/rollover seal and dirty re-seal compose the
 * same committed row, so a first seal never underreports a day whose
 * projection already holds gateway fallback.
 */
function upsertCommittedSealedDay(dayKey: string, builtAt: string): void {
  const rollup = dbGet<{ dispatch_count: number; input_tokens: number; output_tokens: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'dispatch' THEN event_count ELSE 0 END), 0) AS dispatch_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM stats_event_rollup WHERE day_key = ?`,
    dayKey,
  )
  let done = 0
  let failed = 0
  let cancelled = 0
  const window = dayWindowFromDayKey(dayKey)
  if (window) {
    for (const row of dbQuery<{ status: string }>(
      `SELECT status FROM stats_task_interval
       WHERE effective_end >= ? AND effective_end < ?
         AND status IN ('done','failed','cancelled','interrupted')`,
      window.startAt,
      window.endAt,
    )) {
      if (row.status === 'done') done++
      else if (row.status === 'failed') failed++
      else cancelled++
    }
  }
  dbRun(
    SQL_SEAL_UPSERT_STATS_DAY,
    dayKey,
    rollup?.dispatch_count ?? 0,
    rollup?.input_tokens ?? 0,
    rollup?.output_tokens ?? 0,
    done,
    failed,
    cancelled,
    builtAt,
  )
}

/**
 * True while a day still has un-drained contributing projection work:
 * summary-relevant events in its local-day range above the watermark, a
 * pending terminal task interval ending that day, or a pending dirty-run
 * reconcile whose projected gateway/usage rows land on that day. A first
 * seal must not publish while any of these could still change the day's
 * committed aggregates.
 */
function sealedDayContributionIncomplete(dayKey: string): boolean {
  const window = dayWindowFromDayKey(dayKey)
  if (!window) return true
  const watermark = projectionWatermark()
  const pendingEvent = dbGet<{ one: number }>(
    `SELECT 1 AS one FROM events
     WHERE id > ? AND created_at >= ? AND created_at < ?
       AND type IN ('dispatch','turn_usage','gateway.request.completed')
     LIMIT 1`,
    watermark,
    window.startAt,
    window.endAt,
  )
  if (pendingEvent) return true
  const pendingInterval = dbGet<{ one: number }>(
    `SELECT 1 AS one FROM tasks t
     WHERE t.status IN ('done','failed','cancelled','interrupted')
       AND t.ended_at IS NOT NULL
       AND t.ended_at >= ? AND t.ended_at < ?
       AND NOT EXISTS (SELECT 1 FROM stats_task_interval s WHERE s.task_id = t.id)
     LIMIT 1`,
    window.startAt,
    window.endAt,
  )
  if (pendingInterval) return true
  const pendingRun = dbGet<{ one: number }>(
    `SELECT 1 AS one FROM stats_dirty_runs dr
     WHERE EXISTS (
       SELECT 1 FROM stats_event_projection p
       WHERE p.task_run_id = dr.task_run_id AND p.day_key = ?
     )
     LIMIT 1`,
    dayKey,
  )
  return !!pendingRun
}

/**
 * Seal up to `batch` deferred missing days whose contributing projection is
 * now complete, using the same committed-per-day contract as the dirty-day
 * re-seal. Days still incomplete stay deferred for the next pass.
 * Returns days re-checked.
 */
function drainStatsDeferredSealedDays(batch: number): number {
  const deferred = dbQuery<{ day_key: string }>(
    `SELECT day_key FROM stats_deferred_days ORDER BY day_key ASC LIMIT ?`, batch,
  )
  if (deferred.length === 0) return 0
  const builtAt = new Date().toISOString()
  dbTx(() => {
    for (const { day_key: dayKey } of deferred) {
      if (sealedDayContributionIncomplete(dayKey)) continue
      upsertCommittedSealedDay(dayKey, builtAt)
      dbRun(`DELETE FROM stats_deferred_days WHERE day_key = ?`, dayKey)
    }
  })
  return deferred.length
}

/**
 * Apply all pending bounded projection work: event rows above the watermark,
 * dirty-run flag reconciles, and terminal task interval backfill. Each phase
 * is capped; a large backlog simply leaves more for the next read or the
 * background backfill. Called on the summary miss path and by the cold
 * backfill loop. Dirty sealed days are re-sealed last so they observe the
 * rollup state this pass committed. Missing sealed days deferred by the
 * unified seal path are attempted last so their first seal reads this pass's
 * newly committed projection rows.
 */
export function drainStatsProjection(options: {
  maxEvents?: number
  maxRuns?: number
  maxTaskIntervals?: number
  maxDirtyDays?: number
  maxDeferredDays?: number
} = {}): { events: number; runs: number; taskIntervals: number; dirtyDays: number; deferredDays: number } {
  ensureStatsProjection()
  const events = drainStatsProjectionEvents(options.maxEvents ?? STATS_PROJECTION_BATCH_EVENTS)
  const runs = drainStatsProjectionRuns(options.maxRuns ?? STATS_PROJECTION_BATCH_RUNS)
  const taskIntervals = drainStatsProjectionTaskIntervals(options.maxTaskIntervals ?? STATS_PROJECTION_BATCH_TASKS)
  const dirtyDays = drainStatsDirtySealedDays(options.maxDirtyDays ?? STATS_PROJECTION_BATCH_DIRTY_DAYS)
  const deferredDays = drainStatsDeferredSealedDays(options.maxDeferredDays ?? STATS_PROJECTION_BATCH_DIRTY_DAYS)
  return { events, runs, taskIntervals, dirtyDays, deferredDays }
}

/** Number of still-pending projection event rows (backlog above the watermark). */
export function statsProjectionPendingEvents(): number {
  const watermark = projectionWatermark()
  return dbGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM events WHERE id > ? AND type IN ('dispatch','turn_usage','gateway.request.completed')`,
    watermark,
  )?.count ?? 0
}

/** Real-yield delay between cold-backfill batches; keeps IPC/bot work responsive during the rebuild. */
const STATS_PROJECTION_BACKFILL_YIELD_MS = 5

let statsProjectionBackfillStopped = false

export function stopStatsProjectionBackfill(): void {
  statsProjectionBackfillStopped = true
}

/**
 * Bounded cold backfill / restart rebuild, modeled on the day-cache sealer:
 * applies the historical event range in capped batches, yielding via a real
 * setTimeout macrotask between them so IPC and bot work stay responsive
 * (setImmediate would only yield to the check phase, letting a multi-minute
 * rebuild starve the loop). A version
 * mismatch resets the projection and rebuilds from scratch; reads during
 * backfill compose the sealed days plus the partial projection. Marks the
 * projection fully caught up when the backlog is drained.
 */
export function startStatsProjectionBackfill(options: { isShuttingDown: () => boolean }): void {
  statsProjectionBackfillStopped = false
  void (async () => {
    try {
      ensureStatsProjection()
      while (!statsProjectionBackfillStopped && !options.isShuttingDown()) {
        const applied = drainStatsProjection({
          maxEvents: STATS_PROJECTION_BATCH_EVENTS,
          maxRuns: STATS_PROJECTION_BATCH_RUNS,
          maxTaskIntervals: STATS_PROJECTION_BATCH_TASKS,
        })
        if (applied.events === 0 && applied.runs === 0 && applied.taskIntervals === 0 && applied.dirtyDays === 0 && applied.deferredDays === 0) {
          writeProjectionMeta('backfilling', '0')
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STATS_PROJECTION_BACKFILL_YIELD_MS))
      }
    } catch (error) {
      writeDaemonLogNonFatal('stats projection backfill failed', error)
    }
  })()
}

/**
 * The stamp is derived entirely from projection reconciliation state plus the
 * stats-relevant non-projected inputs; it never probes MAX(events.id), so a
 * reasoning-only event insert cannot invalidate the summary. Terms: the
 * applied events.id watermark (a committed drain/catchup batch — including
 * one that lands no new raw row — always invalidates), the backfilling flag,
 * a bounded count of still-pending summary-relevant event rows above the
 * watermark (new dispatch/turn_usage/gateway inserts invalidate before the
 * drain runs), the pending dirty-run count, a bounded pending task-interval
 * count, indexed rowid maxima of the non-projected input tables
 * (tasks/executions/auxiliary_runs feed the live intervals, dispatch cohort
 * and the recent-run ledger), and the newest updated_at among still-active
 * tasks so queued/running transitions the projection does not cover also
 * invalidate, and the sealed-day reconciliation version (dirtied and
 * re-sealed days both advance it in the committing transaction, so a late
 * correction to a closed day always invalidates the cached summary).
 * total_changes is not used.
 */
function readSummaryStamp(): string {
  const row = dbGet<{ w: string; b: string; p: number; d: number; i: number; t: number; x: number; a: number; u: string; v: string; s: number; f: number }>(
    `SELECT (SELECT COALESCE(value, '0') FROM stats_projection_meta WHERE key = 'event_watermark') AS w,
            (SELECT COALESCE(value, '0') FROM stats_projection_meta WHERE key = 'backfilling') AS b,
            (SELECT COUNT(*) FROM (
              SELECT 1 FROM events
              WHERE id > CAST(COALESCE((SELECT value FROM stats_projection_meta WHERE key = 'event_watermark'), '0') AS INTEGER)
                AND type IN ('dispatch','turn_usage','gateway.request.completed')
              LIMIT ${STATS_PROJECTION_BATCH_EVENTS})) AS p,
            (SELECT COUNT(*) FROM stats_dirty_runs) AS d,
            (SELECT COUNT(*) FROM (
              SELECT 1 FROM tasks t
              WHERE t.status IN ('done','failed','cancelled','interrupted')
                AND t.ended_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM stats_task_interval s WHERE s.task_id = t.id)
              LIMIT ${STATS_PROJECTION_BATCH_TASKS})) AS i,
            (SELECT COALESCE(MAX(rowid), 0) FROM tasks) AS t,
            (SELECT COALESCE(MAX(rowid), 0) FROM executions) AS x,
            (SELECT COALESCE(MAX(rowid), 0) FROM auxiliary_runs) AS a,
            (SELECT COALESCE(MAX(updated_at), '') FROM tasks WHERE status IN ('queued','running')) AS u,
            (SELECT COALESCE(value, '0') FROM stats_projection_meta WHERE key = 'sealed_day_version') AS v,
            (SELECT COUNT(*) FROM stats_dirty_days) AS s,
            (SELECT COUNT(*) FROM stats_deferred_days) AS f`,
  )
  return row ? `${row.w}/${row.b}/${row.p}/${row.d}/${row.i}/${row.t}/${row.x}/${row.a}/${row.u}/${row.v}/${row.s}/${row.f}` : ''
}

/**
 * Truthful reconciliation state of the persisted projection after the bounded
 * per-read drain. `fresh` means every committed projection batch is applied —
 * the composed snapshot is internally consistent. Otherwise the snapshot is
 * partial: `backfilling` reports the persisted flag or remaining backlog, and
 * `asOf` is the created_at of the last applied event (the read watermark),
 * omitted when nothing has been applied yet.
 */
function readStatsProjectionFreshness(): StatsSummaryFreshness {
  const watermark = projectionWatermark()
  const pendingEvents = statsProjectionPendingEvents()
  const pendingRuns = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stats_dirty_runs`)?.n ?? 0
  const pendingIntervals = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM tasks t
      WHERE t.status IN ('done','failed','cancelled','interrupted')
        AND t.ended_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stats_task_interval s WHERE s.task_id = t.id)
      LIMIT ?)`,
    STATS_PROJECTION_BATCH_TASKS,
  )?.n ?? 0
  const pendingDirtyDays = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stats_dirty_days`)?.n ?? 0
  const pendingDeferredDays = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stats_deferred_days`)?.n ?? 0
  const backfilling = statsProjectionBackfilling()
    || pendingEvents > 0 || pendingRuns > 0 || pendingIntervals > 0 || pendingDirtyDays > 0 || pendingDeferredDays > 0
  if (!backfilling) return { state: 'fresh' }
  const freshness: StatsSummaryFreshness = { state: 'backfilling', backfilling: true }
  if (watermark > 0) {
    const asOf = dbGet<{ created_at: string }>(`SELECT created_at FROM events WHERE id = ?`, watermark)?.created_at
    if (asOf) freshness.asOf = asOf
  }
  return freshness
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

const SQL_READ_SEALED_DAY_ROW = `SELECT day_key, dispatch_count, input_tokens, output_tokens, done_count, failed_count, cancelled_count, built_at
     FROM stats_day_cache WHERE day_key = ?`

function readSealedDayCacheRow(dayKey: string): StatsDayCacheRow | undefined {
  return dbGet<StatsDayCacheRow>(SQL_READ_SEALED_DAY_ROW, dayKey)
}

/** Existing sealed day_key values in [firstDayKey, beforeDayKey), lexicographic local-day order. */
function readSealedDayKeysInRange(firstDayKey: string, beforeDayKey: string): Set<string> {
  const rows = dbQuery<{ day_key: string }>(
    `SELECT day_key FROM stats_day_cache WHERE day_key >= ? AND day_key < ?`,
    firstDayKey,
    beforeDayKey,
  )
  return new Set(rows.map((row) => row.day_key))
}

function readSealedDayCacheRowsInRange(firstDayKey: string, beforeDayKey: string): Map<string, StatsDayCacheRow> {
  const rows = dbQuery<StatsDayCacheRow>(
    `SELECT day_key, dispatch_count, input_tokens, output_tokens, done_count, failed_count, cancelled_count, built_at
     FROM stats_day_cache WHERE day_key >= ? AND day_key < ?`,
    firstDayKey,
    beforeDayKey,
  )
  return new Map(rows.map((row) => [row.day_key, row]))
}

/** Missing closed day keys strictly before sealBeforeIso, oldest first, bounded to MAX_STATS_SUMMARY_DAYS. */
export function listMissingSealedDayKeys(sealBeforeIso: string, now = new Date()): string[] {
  const oldestStart = localDayOffsetStartIso(now, -(MAX_STATS_SUMMARY_DAYS - 1))
  const windows = closedDayWindows(oldestStart, sealBeforeIso)
  if (windows.length === 0) return []
  const beforeDayKey = localDayKeyOf(sealBeforeIso)
  const existing = readSealedDayKeysInRange(windows[0].dayKey, beforeDayKey)
  return windows.filter((day) => !existing.has(day.dayKey)).map((day) => day.dayKey)
}

function dayWindowFromDayKey(dayKey: string): StatsDayWindow | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return undefined
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  return { dayKey, startAt: start.toISOString(), endAt: end.toISOString() }
}

const SQL_SEAL_UPSERT_STATS_DAY = `INSERT OR REPLACE INTO stats_day_cache (day_key, dispatch_count, input_tokens, output_tokens, done_count, failed_count, cancelled_count, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

/** Seal one local calendar day of dispatch/turn_usage totals and terminal task outcomes. */
export function sealStatsDay(dayKey: string): void {
  sealStatsDaysInTransaction([dayKey])
}

/**
 * First-seal missing days through the same committed per-day contract the
 * dirty-day re-seal uses (stats_event_rollup + stats_task_interval), never
 * the legacy client-only raw scan: a day whose committed rollup already
 * carries whole-run gateway fallback (e.g. a cold-backfilled day with no
 * client usage) seals with those tokens instead of 0, and a later client
 * supersession corrects it through the same dirty-run/dirty-day path. A day
 * whose contributing projection is not yet drained is deferred to
 * stats_deferred_days instead of publishing a partial seal; the bounded
 * drain retries it on each pass until its contributions are complete.
 */
function sealStatsDaysInTransaction(dayKeys: string[]): void {
  if (dayKeys.length === 0) return
  ensureStatsProjection()
  const builtAt = new Date().toISOString()
  dbTx(() => {
    for (const dayKey of dayKeys) {
      if (!dayWindowFromDayKey(dayKey)) continue
      if (sealedDayContributionIncomplete(dayKey)) {
        dbRun(`INSERT OR IGNORE INTO stats_deferred_days (day_key) VALUES (?)`, dayKey)
        continue
      }
      upsertCommittedSealedDay(dayKey, builtAt)
    }
    writeProjectionMeta('sealed_day_version', String(Number(readProjectionMeta('sealed_day_version') ?? '0') + 1))
  })
}

const STATS_DAY_CACHE_SEAL_BATCH_SIZE = 32

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
      for (let offset = 0; offset < missing.length; offset += STATS_DAY_CACHE_SEAL_BATCH_SIZE) {
        if (statsDayCacheSealerStopped || options.isShuttingDown()) return
        const batch = missing.slice(offset, offset + STATS_DAY_CACHE_SEAL_BATCH_SIZE)
        try {
          sealStatsDaysInTransaction(batch)
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

export function readTodayStats(now = new Date()): DailyStatsResponse {
  const window = localDayWindow(now)
  const dispatchRow = dbGet<{ count: number }>(
    `SELECT COUNT(*) AS count
    FROM events INDEXED BY idx_event_type_created
    WHERE type = 'dispatch'
      AND created_at >= ?
      AND created_at < ?`,
    window.startAt,
    window.endAt,
  )
  const usageRows = dbQuery<{ execution_id: string | null; data: string | null }>(
    `SELECT execution_id, data
    FROM events INDEXED BY idx_event_type_created
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

  // Gateway fallback: when a task run's client turn_usage events never report
  // a partition anywhere in the run, every successful gateway completion
  // contributes its own measured partitions at its own created_at.
  // usage.input is the full gateway-measured input (it already includes the
  // cached portion), so the uncached remainder max(input - cachedInput, 0)
  // fills the input partition while usage.cachedInput fills the cached
  // partition independently.
  const gatewayRows = dbQuery<{ created_at: string; data: string | null }>(
    `SELECT created_at, data
    FROM events INDEXED BY idx_event_type_created
    WHERE type = 'gateway.request.completed'
      AND created_at >= ?
      AND created_at < ?
    ORDER BY created_at ASC, id ASC`,
    window.startAt,
    window.endAt,
  )
  interface GatewayCompletion {
    executionId: string
    uncached?: number
    cached?: number
    output?: number
  }
  const executions: { executionId: string; completions: GatewayCompletion[] }[] = []
  const completionByExecution = new Map<string, GatewayCompletion[]>()
  for (const row of gatewayRows) {
    const data = parseJsonValue(row.data)
    const record = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as JsonRecord).data
      : undefined
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const payload = record as JsonRecord
    if (payload.status !== 200) continue
    const executionId = typeof payload.executionId === 'string' ? payload.executionId.trim() : ''
    if (executionId === '') continue
    const usage = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
      ? payload.usage as JsonRecord
      : undefined
    const completion: GatewayCompletion = { executionId }
    if (usage && isMeasuredNumber(usage.cachedInput)) completion.cached = usage.cachedInput as number
    if (usage && isMeasuredNumber(usage.input)) {
      completion.uncached = Math.max((usage.input as number) - (completion.cached ?? 0), 0)
    }
    if (usage && isMeasuredNumber(usage.output)) completion.output = usage.output as number
    let bucket = completionByExecution.get(executionId)
    if (!bucket) {
      bucket = []
      completionByExecution.set(executionId, bucket)
      executions.push({ executionId, completions: bucket })
    }
    bucket.push(completion)
  }

  if (executions.length > 0) {
    // Resolve each execution to its canonical task run, then read that run's
    // whole client turn_usage set (bounded by execution ids, not time) so a
    // partition reported on any attempt — including an explicit zero — blocks
    // the gateway fallback for the entire run. The cached partition is the
    // normalized total/split union: a defined cached_input_tokens total or a
    // defined read/creation split counts as reported.
    const ids = executions.map((e) => e.executionId)
    const placeholders = ids.map(() => '?').join(', ')
    const runByExecution = new Map<string, string>()
    for (const row of dbQuery<{ id: string; task_id: string }>(
      `SELECT id, task_id FROM executions WHERE id IN (${placeholders})`,
      ...ids,
    )) {
      runByExecution.set(row.id, row.task_id)
    }
    const runIds = [...new Set(runByExecution.values())]
    const clientReported = new Map<string, { input: boolean; cached: boolean; output: boolean }>()
    if (runIds.length > 0) {
      const runPlaceholders = runIds.map(() => '?').join(', ')
      for (const row of dbQuery<{ task_id: string; data: string | null }>(
        `SELECT ex.task_id AS task_id, ev.data AS data
         FROM executions ex
         JOIN events ev ON ev.execution_id = ex.id AND ev.type = 'turn_usage'
         WHERE ex.task_id IN (${runPlaceholders})`,
        ...runIds,
      )) {
        const data = parseJsonValue(row.data)
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue
        const rec = data as JsonRecord
        const flags = clientReported.get(row.task_id) ?? { input: false, cached: false, output: false }
        if (isMeasuredNumber(rec.input_tokens)) flags.input = true
        if (
          isMeasuredNumber(rec.cached_input_tokens)
          || isMeasuredNumber(rec.cache_read_input_tokens)
          || isMeasuredNumber(rec.cache_creation_input_tokens)
        ) flags.cached = true
        if (isMeasuredNumber(rec.output_tokens)) flags.output = true
        clientReported.set(row.task_id, flags)
      }
    }
    const fallbackByRun = new Map<string, { input: number; output: number }>()
    for (const { executionId, completions } of executions) {
      const runId = runByExecution.get(executionId)
      if (!runId) continue
      const reported = clientReported.get(runId)
      const sums = fallbackByRun.get(runId) ?? { input: 0, output: 0 }
      for (const completion of completions) {
        if (!reported?.input && completion.uncached !== undefined) sums.input += completion.uncached
        if (!reported?.cached && completion.cached !== undefined) sums.input += completion.cached
        if (!reported?.output && completion.output !== undefined) sums.output += completion.output
      }
      fallbackByRun.set(runId, sums)
    }
    for (const sums of fallbackByRun.values()) {
      inputTokens += sums.input
      outputTokens += sums.output
    }
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

  const { result, freshness } = readStatsSummaryUncached(params, now, options, todayWindow)
  result.freshness = freshness
  if (freshness.state === 'fresh') {
    // Consistency contract: only fully-consistent snapshots enter the cache,
    // stored under the post-drain stamp so a drained projection does not turn
    // every read into a rebuild.
    const asOf = dbGet<{ created_at: string }>(
      `SELECT created_at FROM events WHERE id = ?`, projectionWatermark(),
    )?.created_at
    byKey.set(cacheKey, { stamp: readSummaryStamp(), cachedAtMs: now.getTime(), result: structuredClone(result), ...(asOf ? { asOf } : {}) })
    return result
  }
  // A partially-applied projection is never published as a fresh summary:
  // serve the last consistent snapshot when one exists (marked stale even
  // past its TTL), otherwise return the partial snapshot marked backfilling.
  // Incomplete results are never cached so they cannot masquerade as fresh.
  if (hit) {
    const stale = structuredClone(hit.result)
    stale.freshness = {
      state: 'stale',
      ...(freshness.backfilling ? { backfilling: true } : {}),
      ...(hit.asOf ? { asOf: hit.asOf } : {}),
    }
    return stale
  }
  return result
}

function readStatsSummaryUncached(
  params: { days?: number; limit?: number },
  now: Date,
  options: StatsQueryOptions,
  todayWindow: { dayKey: string; startAt: string; endAt: string },
): { result: StatsSummaryResult; freshness: StatsSummaryFreshness } {
  const days = params.days ?? 7
  const limit = params.limit ?? 20


  const dailyBuckets = buildDailyBuckets(now, days)

  // Keep the fixed 31-local-day period window while allowing the daily
  // activity projection to extend to a full year.
  const windowsStartIso = localDayOffsetStartIso(now, -(31 - 1))
  const dailyStartIso = localDayOffsetStartIso(now, -(days - 1))
  const sealBeforeDayKey = localDayKeyOf(windowsStartIso)
  const fullEndIso = todayWindow.endAt

  // Drain bounded pending projection work first so the composed snapshot
  // reflects the newest relevant writes without ever re-materializing history:
  // event rows above the events.id watermark, dirty runs needing a per-run
  // fallback reconcile, terminal task intervals awaiting projection, and
  // dirty sealed days awaiting bounded re-seal. Each phase is capped; a
  // backlog simply leaves the remainder to the background backfill or the
  // next read. The drain must run before the sealed rows below are read so a
  // just-re-sealed day is composed from its corrected aggregate.
  drainStatsProjection()

  // Daily chart days strictly before the 31-day live window are served from
  // sealed per-day totals (lazy seal on read); rankings and fixed windows stay live.
  const sealedBucketKeys = dailyBuckets.filter((bucket) => bucket.dayKey < sealBeforeDayKey).map((b) => b.dayKey)
  if (sealedBucketKeys.length > 0) {
    const firstBucketKey = sealedBucketKeys[0]
    const existingKeys = readSealedDayKeysInRange(firstBucketKey, sealBeforeDayKey)
    const missingKeys = sealedBucketKeys.filter((dayKey) => !existingKeys.has(dayKey))
    if (missingKeys.length > 0) sealStatsDaysInTransaction(missingKeys)
    const sealedRows = readSealedDayCacheRowsInRange(firstBucketKey, sealBeforeDayKey)
    for (const bucket of dailyBuckets) {
      if (bucket.dayKey >= sealBeforeDayKey) continue
      const sealed = sealedRows.get(bucket.dayKey)
      if (sealed) applySealedTotalsToBucket(bucket, sealed)
    }
  }

  // Truthful reconciliation state of what the drain just committed; a
  // remaining backlog marks the composed snapshot backfilling instead of
  // letting it pass as a fresh complete summary.
  const freshness = readStatsProjectionFreshness()

  // Composed live-window event aggregates come from the persisted per-day
  // rollup the bounded drain maintains atomically with the event watermark:
  // one pre-aggregated row per (local day, event type, template, model
  // identity) carries the same token/identity semantics the retired 31-day
  // MATERIALIZED scan produced, with gateway fallback already gated per-run
  // by the reconciled client-report flags. Every window boundary is
  // day-aligned, so the read composes day-granularity aggregates and never
  // maps individual event rows.
  const eventRollupRows = dbQuery<StatsEventRollupRow>(
    `SELECT day_key, type, template, provider, model, model_id,
            event_count, input_tokens, output_tokens
     FROM stats_event_rollup
     WHERE day_key >= ? AND day_key <= ?`,
    sealBeforeDayKey,
    todayWindow.dayKey,
  )

  // Terminal task intervals come from the persisted projection; still-active
  // rows stay live (status-indexed) because their effective end is now().
  const taskIntervalRows = dbQuery<StatsTaskIntervalRow>(
    `SELECT template, created_at, effective_end, status, project, definition_source
     FROM (
       SELECT s.template AS template, s.created_at AS created_at, s.effective_end AS effective_end, s.status AS status, t.project AS project, s.definition_source AS definition_source
       FROM stats_task_interval s
       LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.effective_end >= ? AND s.effective_end < ?
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

  for (const row of eventRollupRows) {
    const bucket = bucketByDayKey.get(row.day_key)
    if (!bucket) continue

    if (row.type === 'dispatch') {
      bucket.dispatchCount += row.event_count
    }
    bucket.inputTokens += row.input_tokens
    bucket.outputTokens += row.output_tokens
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

  // --- TODAY RANKINGS: filter the day rollup to today only ---
  const todayRows = eventRollupRows.filter((row) => row.day_key === todayWindow.dayKey)

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
      g.dispatchCount += row.event_count
    }
    g.inputTokens += row.input_tokens
    g.outputTokens += row.output_tokens
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
    const taskName = normalizeTaskName(row.template === '' ? null : row.template)
    let g = taskMap.get(taskName)
    if (!g) {
      g = { dispatchCount: 0, inputTokens: 0, outputTokens: 0 }
      taskMap.set(taskName, g)
    }
    if (row.type === 'dispatch') {
      g.dispatchCount += row.event_count
    }
    g.inputTokens += row.input_tokens
    g.outputTokens += row.output_tokens
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
    eventRollupRows,
    taskIntervalRows,
    tpsSamples,
    now,
    limit,
    resolveDisplayNames: options.resolveDisplayNames,
  })

  return {
    result: {
      source: 'sqlite',
      today,
      byProfile,
      byTask,
      daily: dailyBuckets,
      totalTaskDurationMs,
      byTaskDuration,
      windows,
      recentRuns: readRecentTaskRunLedger(Math.min(limit, RECENT_RUNS_CAP), options.resolveDisplayNames),
    },
    freshness,
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
    execution_id: string | null
  }>(
    // The MIN(started_at) probe runs per already-selected recent task row via
    // idx_exec_task_meta instead of grouping every execution in the table; the
    // inner SELECT fixes the same ORDER BY + LIMIT candidate set first, and the
    // outer ORDER BY restores it because subquery ordering is not guaranteed to
    // propagate through the joins.
    `SELECT t.id AS id, t.template AS template, t.project AS project, t.status AS status,
            t.created_at AS created_at, t.ended_at AS ended_at, t.definition_source AS definition_source,
            t.summary AS summary,
            t.execution_id AS execution_id,
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
    // Execution identity/mode the renderer needs to key live-usage reads:
    // the exact persisted current execution id plus its resolved dispatch
    // mode, emitted only when actually known.
    if (row.execution_id && row.execution_id.trim() !== '') ledger.executionId = row.execution_id
    if (meta.resolved?.mode === 'native' || meta.resolved?.mode === 'gateway') {
      ledger.executionMode = meta.resolved.mode
    }
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

/** True when the field holds a defined finite non-negative number (explicit zero counts). */
function isMeasuredNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Full input for a turn_usage event is the untrusted input_tokens plus the
 * cached input partition the client reported. Cursor exposes
 * cached_input_tokens as the total cached-input partition, of which
 * cache_read_input_tokens and cache_creation_input_tokens are the read/write
 * split; Grok-style events may only carry the read/creation split fields, so a
 * missing total falls back to summing the defined splits (a lone split still
 * counts). Legacy events that only report input_tokens are unchanged. The
 * cache partition is counted exactly once here; a valid total is never added
 * on top of the splits, and a separate total_tokens field is never added
 * either because that would double count the same input.
 */
function fullInputTokens(record: JsonRecord): number {
  return nonNegativeNumber(record.input_tokens) + normalizedCachedTokens(record)
}

/** Defined cached_input_tokens total wins (explicit zero counts); otherwise the sum of defined read/creation splits. */
function normalizedCachedTokens(record: JsonRecord): number {
  if (isMeasuredNumber(record.cached_input_tokens)) return record.cached_input_tokens as number
  return nonNegativeNumber(record.cache_read_input_tokens) + nonNegativeNumber(record.cache_creation_input_tokens)
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
  eventRollupRows: StatsEventRollupRow[]
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
    eventRollupRows: StatsEventRollupRow[]
    taskIntervalRows: StatsTaskIntervalRow[]
    tpsSamples: ExecutionTpsSample[]
    limit: number
    resolveDisplayNames?: TaskRunDisplayNameResolver
  },
): StatsWindowSummary {
  const startMs = new Date(startAt).getTime()
  const endMs = new Date(endAt).getTime()
  // Every window spec is local-day aligned, so a day-rollup row belongs to the
  // window iff its day_key falls inside [startAt, endAt).
  const startDayKey = localDayKeyOf(startAt)
  const endDayKey = localDayKeyOf(new Date(endMs - 1).toISOString())
  let dispatchCount = 0
  let totalTokens = 0
  // Group by an explicit shared identity or a namespaced provider-local one;
  // `profile` is later emitted as the legacy alias equal to the model. Ineligible
  // rows are omitted from model rankings but still counted in totals.
  const modelMap = new Map<string, WindowModelAccumulator>()

  for (const row of options.eventRollupRows) {
    if (row.day_key < startDayKey || row.day_key > endDayKey) continue

    const persisted = eligibleModelIdentity(row)
    if (row.type === 'dispatch') {
      dispatchCount += row.event_count
    }
    totalTokens += row.input_tokens + row.output_tokens
    if (!persisted) continue
    const identity = resolveStatsModelIdentity(persisted, options.resolveDisplayNames)
    const g = ensureWindowModel(modelMap, identity)
    recordModelDisplay(g, identity)
    if (row.type === 'dispatch') {
      g.runCount += row.event_count
    } else {
      g.inputTokens += row.input_tokens
      g.outputTokens += row.output_tokens
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
