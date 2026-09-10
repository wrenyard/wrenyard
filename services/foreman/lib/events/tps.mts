import { getDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import type { LocalSpeedSample } from '@wrenyard/catalog'
import { migrateProviderId } from '../config/chatgpt-migration.mts'

/**
 * Unified task-efficiency TPS.
 *
 * TPS means current-invocation output tokens divided by ACTUAL execution
 * elapsed milliseconds, measured from `executions.started_at` to
 * `executions.ended_at`. It is deliberately NOT native event `duration_ms`:
 * a single stable task-efficiency proxy that is comparable across clients.
 *
 * The persisted `turn_usage` events keep their additive token provenance and
 * their `token_scope`/`duration_scope`/`tps_contract` version tags, but those
 * tags only validate that the output tokens are additive agent-turn output.
 * The native `duration_ms` carried by those events is never used as a
 * denominator and never influences the produced rate.
 */

export interface ExecutionTpsSample {
  executionId: string
  taskId: string
  provider: string
  model: string
  modelId: string
  endedAt: string
  outputTokens: number
  durationMs: number
  tps: number
}

export interface TpsEstimate {
  tps: number
  sampleCount: number
  checkedAt: string
}

interface ExecutionSampleRow {
  executionId: string
  taskId: string | null
  startedAt: string | null
  endedAt: string | null
  provider: string | null
  model: string | null
  modelId: string | null
}

interface UsageDataRow {
  execution_id: string
  data: string | null
}

/** Trailing freshness window for local speed aggregation (31 days). */
const LOCAL_SPEED_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
/** Minimum per-execution output tokens eligible for the speed estimate. */
const MIN_SAMPLE_OUTPUT_TOKENS = 256
/** Minimum per-execution elapsed milliseconds eligible for the speed estimate. */
const MIN_SAMPLE_DURATION_MS = 5000
/** Maximum newest executions considered for the speed estimate. */
const MAX_SAMPLES = 50
/** Minimum samples required to publish an aggregate estimate. */
const MIN_SAMPLES = 3

export interface ReadExecutionTpsOptions {
  startAt?: string
  endAt?: string
  taskId?: string
}

/**
 * Reads completed, successful executions and ALL of their `turn_usage` events,
 * producing one sample per execution. An execution qualifies only when it is a
 * `done` run with finite positive stored `started_at`/`ended_at` elapsed and at
 * least one event that is additive agent-turn output carrying a safe integer
 * output >= 0.
 *
 * The versioned scopes (`token_scope=agent_turn`, `duration_scope=agent_turn`,
 * `tps_contract=agent_turn_v1`) validate additive token provenance only. Output
 * tokens are summed exactly once per execution while the whole execution time
 * is counted exactly once, so repeated usage never inflates the rate.
 *
 * Missing/failed/cancelled/incomplete runs produce no sample. Persisted events
 * are never modified.
 */
export function readExecutionTpsSamples(
  options: ReadExecutionTpsOptions = {},
  db?: ForemanDatabase,
): ExecutionTpsSample[] {
  const database = db ?? getDb()
  const conditions = ["e.status = 'done'", 'e.started_at IS NOT NULL', 'e.ended_at IS NOT NULL']
  const params: unknown[] = []
  if (options.startAt !== undefined) {
    conditions.push('e.ended_at >= ?')
    params.push(options.startAt)
  }
  if (options.endAt !== undefined) {
    conditions.push('e.ended_at < ?')
    params.push(options.endAt)
  }
  if (options.taskId !== undefined) {
    conditions.push('e.task_id = ?')
    params.push(options.taskId)
  }

  const executionRows = dbQueryOn<ExecutionSampleRow>(
    database,
    `SELECT e.id AS executionId, e.task_id AS taskId,
            e.started_at AS startedAt, e.ended_at AS endedAt,
            tra.provider AS provider, tra.model AS model, tra.model_id AS modelId
     FROM executions e
     INNER JOIN task_run_attempt_dispatch tra ON tra.execution_id = e.id
     WHERE ${conditions.join(' AND ')}`,
    params,
  )
  if (executionRows.length === 0) return []

  const executionIds = executionRows.map((row) => row.executionId)
  const usageRows = dbQueryOn<UsageDataRow>(
    database,
    `SELECT execution_id, data FROM events
     WHERE type = 'turn_usage' AND execution_id IN (${executionIds.map(() => '?').join(', ')})`,
    executionIds,
  )
  const outputByExecution = new Map<string, number>()
  const hasEventByExecution = new Map<string, boolean>()
  const validByExecution = new Map<string, boolean>()
  for (const row of usageRows) {
    if (!hasEventByExecution.has(row.execution_id)) hasEventByExecution.set(row.execution_id, true)
    const parsed = parseAdditiveOutput(row.data)
    // Any event on the execution that is not additive agent-turn output makes
    // the whole execution ineligible rather than silently under-counting.
    if (parsed === undefined) {
      validByExecution.set(row.execution_id, false)
      continue
    }
    if (!validByExecution.has(row.execution_id)) validByExecution.set(row.execution_id, true)
    outputByExecution.set(row.execution_id, (outputByExecution.get(row.execution_id) ?? 0) + parsed)
  }

  const samples: ExecutionTpsSample[] = []
  for (const row of executionRows) {
    // Validate the persisted identity before the one-time provider rename.
    if (row.modelId?.trim() !== `${row.provider?.trim()}/${row.model?.trim()}`) continue
    const provider = safeIdentity(row.provider, (value) => migrateProviderId(value))
    const model = safeIdentity(row.model)
    const modelId = safeIdentity(row.modelId)
    if (provider === undefined || model === undefined || modelId === undefined) continue
    if (hasEventByExecution.get(row.executionId) !== true) continue
    if (validByExecution.get(row.executionId) !== true) continue

    const startedMs = parseTimestampMs(row.startedAt)
    const endedMs = parseTimestampMs(row.endedAt)
    if (startedMs === undefined || endedMs === undefined) continue
    const durationMs = endedMs - startedMs
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue

    const outputTokens = outputByExecution.get(row.executionId) ?? 0
    if (!isSafeInteger(outputTokens) || outputTokens <= 0) continue

    const tps = ratePerSecond(outputTokens, durationMs)
    if (tps === undefined) continue

    samples.push({
      executionId: row.executionId,
      taskId: row.taskId ?? '',
      provider,
      model,
      modelId,
      endedAt: row.endedAt as string,
      outputTokens,
      durationMs,
      tps,
    })
  }
  return samples
}

/**
 * Median estimate of per-execution TPS over recent eligible samples.
 *
 * Only samples with >= 256 output tokens and >= 5000ms elapsed are considered;
 * the newest 50 by `endedAt` are kept and at least 3 must remain. The estimate
 * is the median of per-execution TPS (the average of the central pair for an
 * even count). Fewer than 3 usable samples yield undefined so a small sample
 * can never publish an aggregate.
 */
export function estimateTps(samples: readonly ExecutionTpsSample[]): TpsEstimate | undefined {
  const eligible = samples.filter((sample) =>
    sample.outputTokens >= MIN_SAMPLE_OUTPUT_TOKENS
    && sample.durationMs >= MIN_SAMPLE_DURATION_MS
    && Number.isFinite(sample.tps),
  )
  if (eligible.length < MIN_SAMPLES) return undefined

  const newest = [...eligible]
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    .slice(0, MAX_SAMPLES)
  if (newest.length < MIN_SAMPLES) return undefined

  const tps = median(newest.map((sample) => sample.tps))
  if (tps === undefined) return undefined
  const checkedAt = newest[0].endedAt
  return { tps, sampleCount: newest.length, checkedAt }
}

/**
 * Local speed samples for automatic routing, grouped by EXACT provider+model
 * across every client over the trailing 31 days (future-dated samples are
 * excluded). The injected resolver reads these directly; it never guesses
 * identity from a profile string.
 */
export function readLocalSpeedSamples(now: Date = new Date()): LocalSpeedSample[] {
  const startAt = new Date(now.getTime() - LOCAL_SPEED_WINDOW_MS).toISOString()
  const endAt = now.toISOString()
  const samples = readExecutionTpsSamples({ startAt, endAt })
  const grouped = new Map<string, ExecutionTpsSample[]>()
  for (const sample of samples) {
    const key = `${sample.provider}\u0000${sample.model}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(sample)
    else grouped.set(key, [sample])
  }

  const result: LocalSpeedSample[] = []
  for (const bucket of grouped.values()) {
    const estimate = estimateTps(bucket)
    if (!estimate) continue
    result.push({
      provider: bucket[0].provider,
      model: bucket[0].model,
      tps: estimate.tps,
      sampleCount: estimate.sampleCount,
      checkedAt: estimate.checkedAt,
    })
  }
  return result
}

export interface TaskTps {
  tps: number
  outputTokens: number
  durationMs: number
}

/**
 * Task-level TPS. Every attempt (execution) for the task must be done AND carry
 * a complete execution-based sample; otherwise undefined. Each attempt's output
 * and whole-execution elapsed are summed exactly once, and the rate is derived
 * from those corrected totals — never from the old native `duration_ms` sums or
 * from materialized telemetry timing.
 */
export function readTaskTps(taskId: string, db?: ForemanDatabase): TaskTps | undefined {
  const databases = db ?? getDb()
  const attempts = dbQueryOn<{ id: string; status: string }>(
    databases,
    `SELECT id, status FROM executions WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
    [taskId],
  )
  if (attempts.length === 0) return undefined
  if (attempts.some((attempt) => attempt.status !== 'done')) return undefined

  const samples = readExecutionTpsSamples({ taskId }, databases)
  const byExecution = new Map<string, ExecutionTpsSample>()
  for (const sample of samples) byExecution.set(sample.executionId, sample)

  let outputTokens = 0
  let durationMs = 0
  for (const attempt of attempts) {
    const sample = byExecution.get(attempt.id)
    // A done attempt with no complete sample makes the whole task TPS unknown.
    if (!sample) return undefined
    outputTokens += sample.outputTokens
    durationMs += sample.durationMs
  }
  const tps = ratePerSecond(outputTokens, durationMs)
  if (tps === undefined) return undefined
  return { tps, outputTokens, durationMs }
}

/**
 * Parses one persisted turn_usage payload into its additive agent-turn output
 * token count. Returns undefined when the payload is missing/invalid, is not
 * additive agent-turn output, or carries an unsafe/non-integer output. The
 * version tags validate token provenance only; native duration is ignored.
 */
function parseAdditiveOutput(value: string | null): number | undefined {
  if (value === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.token_scope !== 'agent_turn') return undefined
  if (record.duration_scope !== 'agent_turn') return undefined
  if (record.tps_contract !== 'agent_turn_v1') return undefined
  const output = record.output_tokens
  if (typeof output !== 'number' || !isSafeInteger(output) || output < 0) return undefined
  return output
}

/** Single rate validation helper: finite, positive tokens over finite positive ms. */
function ratePerSecond(outputTokens: number, durationMs: number): number | undefined {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) return undefined
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined
  const tps = (1000 * outputTokens) / durationMs
  return Number.isFinite(tps) && tps > 0 ? tps : undefined
}

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function parseTimestampMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function safeIdentity(value: string | null, map?: (value: string) => string): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return map ? map(trimmed) : trimmed
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function dbQueryOn<T>(database: ForemanDatabase, sql: string, params: unknown[]): T[] {
  return database.prepare<unknown[], T>(sql).all(...params)
}
