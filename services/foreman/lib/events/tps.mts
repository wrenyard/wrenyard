import { getDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import type { LocalSpeedSample } from '@wrenyard/catalog'
import { canonicalizeObservedProviderModelId } from '@wrenyard/providers'
import { migrateProviderId } from '../config/chatgpt-migration.mts'

/**
 * Unified response-paired TPS.
 *
 * TPS means paired generated output tokens divided by their paired generation
 * milliseconds. It is independent of execution wall time and native event
 * `duration_ms`, so tool waits do not change the speed estimate.
 *
 * The persisted `turn_usage` events keep their billing/accounting provenance,
 * but those fields never influence speed.
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
/** Minimum per-execution paired generation milliseconds eligible for speed. */
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
 * Reads completed, successful executions and their normalized response samples,
 * producing one sample per execution. An execution qualifies only when it is a
 * `done` run with a marked response sampling contract and at least one valid
 * paired response sample.
 *
 * Legacy accounting scopes remain available for billing but never influence
 * speed. Output tokens and generation time are summed from the same samples.
 *
 * Missing/failed/cancelled/incomplete runs produce no sample. Persisted events
 * are never modified.
 */
export function readExecutionTpsSamples(
  options: ReadExecutionTpsOptions = {},
  db?: ForemanDatabase,
): ExecutionTpsSample[] {
  const database = db ?? getDb()
  const conditions = ["e.status = 'done'", 'e.ended_at IS NOT NULL']
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
            e.ended_at AS endedAt,
            tra.provider AS provider, tra.model AS model, tra.model_id AS modelId
     FROM executions e
     INNER JOIN task_run_attempt_dispatch tra ON tra.execution_id = e.id
     WHERE ${conditions.join(' AND ')}`,
    params,
  )
  if (executionRows.length === 0) return []

  const executionById = new Map(executionRows.map((row) => [row.executionId, row]))
  const executionIds = executionRows.map((row) => row.executionId)
  const usageRows = dbQueryOn<UsageDataRow>(
    database,
    `SELECT execution_id, data FROM events
     WHERE type = 'turn_usage' AND execution_id IN (${executionIds.map(() => '?').join(', ')})`,
    executionIds,
  )
  const totalsByExecution = new Map<string, { outputTokens: number; durationMs: number }>()
  const seenByExecution = new Map<string, Map<string, ResponseSample>>()
  const invalidByExecution = new Set<string>()
  for (const row of usageRows) {
    const execution = executionById.get(row.execution_id)
    if (!execution) continue
    const parsed = parseResponseSamples(row.data, execution.model, execution.provider)
    if (parsed === undefined) continue
    if (parsed.invalid) invalidByExecution.add(row.execution_id)
    const seen = seenByExecution.get(row.execution_id) ?? new Map<string, ResponseSample>()
    for (const sample of parsed.samples) {
      const previous = seen.get(sample.responseId)
      if (previous) {
        if (!sameResponseSample(previous, sample)) invalidByExecution.add(row.execution_id)
        continue
      }
      seen.set(sample.responseId, sample)
      const current = totalsByExecution.get(row.execution_id) ?? { outputTokens: 0, durationMs: 0 }
      current.outputTokens += sample.outputTokens
      current.durationMs += sample.completedAtMs - sample.firstTokenAtMs
      totalsByExecution.set(row.execution_id, current)
    }
    seenByExecution.set(row.execution_id, seen)
  }

  const samples: ExecutionTpsSample[] = []
  for (const row of executionRows) {
    // Validate the persisted identity before the one-time provider rename.
    if (row.modelId?.trim() !== `${row.provider?.trim()}/${row.model?.trim()}`) continue
    const provider = safeIdentity(row.provider, (value) => migrateProviderId(value))
    const model = safeIdentity(row.model)
    const modelId = safeIdentity(row.modelId)
    if (provider === undefined || model === undefined || modelId === undefined) continue
    const endedMs = parseTimestampMs(row.endedAt)
    if (endedMs === undefined) continue
    if (invalidByExecution.has(row.executionId)) continue

    const totals = totalsByExecution.get(row.executionId)
    if (!totals || !isSafeInteger(totals.outputTokens) || totals.outputTokens <= 0) continue
    if (!Number.isFinite(totals.durationMs) || totals.durationMs <= 0) continue

    const tps = ratePerSecond(totals.outputTokens, totals.durationMs)
    if (tps === undefined) continue

    samples.push({
      executionId: row.executionId,
      taskId: row.taskId ?? '',
      provider,
      model,
      modelId,
      endedAt: row.endedAt as string,
      outputTokens: totals.outputTokens,
      durationMs: totals.durationMs,
      tps,
    })
  }
  return samples
}

/**
 * Median estimate of per-execution TPS over recent eligible samples.
 *
 * Only samples with >= 256 paired output tokens and >= 5000ms paired generation
 * time are considered;
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
 * a complete response-paired sample; otherwise undefined. Each attempt's paired
 * output and generation time are summed exactly once.
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
 * Parses one normalized response sampling payload. Invalid or incomplete
 * samples are omitted because adapters may omit responses lacking timing or
 * usage; tokens are never borrowed from an unpaired response.
 */
function parseResponseSamples(
  value: string | null,
  dispatchModel: string | null,
  provider: string | null,
): { samples: ResponseSample[]; invalid: boolean } | undefined {
  if (value === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.tps_sampling_contract !== 'response_v1') return undefined
  if (!Array.isArray(record.tps_samples)) return undefined
  const seen = new Map<string, ResponseSample>()
  let invalid = false
  for (const value of record.tps_samples) {
    const sample = parseResponseSample(value, dispatchModel, provider)
    if (sample === undefined) continue
    if (sample.mismatchedModel) {
      invalid = true
      continue
    }
    const previous = seen.get(sample.responseId)
    if (previous) {
      if (!sameResponseSample(previous, sample)) invalid = true
      continue
    }
    seen.set(sample.responseId, sample)
  }
  return { samples: [...seen.values()], invalid }
}

interface ResponseSample {
  responseId: string
  model: string
  outputTokens: number
  firstTokenAtMs: number
  completedAtMs: number
}

function parseResponseSample(value: unknown, dispatchModel: string | null, provider: string | null): (ResponseSample & { mismatchedModel?: false }) | { responseId: string; mismatchedModel: true } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const responseId = record.response_id
  const model = record.model
  const outputTokens = record.output_tokens
  const firstTokenAtMs = record.first_token_at_ms
  const completedAtMs = record.completed_at_ms
  if (typeof responseId !== 'string' || responseId.trim() === '') return undefined
  if (typeof model !== 'string' || model.trim() === '') return undefined
  if (typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return undefined
  if (typeof firstTokenAtMs !== 'number' || !Number.isFinite(firstTokenAtMs) || firstTokenAtMs <= 0) return undefined
  if (typeof completedAtMs !== 'number' || !Number.isFinite(completedAtMs) || completedAtMs <= firstTokenAtMs) return undefined
  const normalized = {
    responseId: responseId.trim(),
    model: canonicalizeObservedProviderModelId(provider ?? '', model.trim()),
    outputTokens,
    firstTokenAtMs,
    completedAtMs,
  }
  if (dispatchModel?.trim() !== normalized.model) return { responseId: normalized.responseId, mismatchedModel: true }
  return normalized
}

function sameResponseSample(a: ResponseSample, b: ResponseSample): boolean {
  return a.responseId === b.responseId
    && a.model === b.model
    && a.outputTokens === b.outputTokens
    && a.firstTokenAtMs === b.firstTokenAtMs
    && a.completedAtMs === b.completedAtMs
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
