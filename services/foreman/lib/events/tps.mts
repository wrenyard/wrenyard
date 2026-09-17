import { getDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import type { LocalSpeedSample } from '@wrenyard/catalog'
import { canonicalizeObservedProviderModelId } from '@wrenyard/providers'
import { migrateProviderId } from '../config/chatgpt-migration.mts'

/**
 * Unified approximate TPS (`tokenizer_v1`).
 *
 * TPS means cl100k_base tokens counted over only the actually observed
 * generation content, divided by exactly the generation milliseconds that
 * produced that content. It is independent of execution wall time and native
 * event `duration_ms`, so tool waits and completion latency never change the
 * speed estimate. Official usage/billing accounting is unchanged and never
 * influences speed.
 *
 * A `tokenizer_v1` sample pairs its observed-content token count with either
 * one scalar generation interval or the exact ordered vector of serial
 * model-generation windows behind that content (for example one aggregate
 * Cursor turn). Both shapes normalize to the same interval vector and summed
 * duration, so the persisted-execution, gateway, and task/local estimate paths
 * all divide summed tokens by the summed generation time. Historical
 * `response_v1` samples are never relabeled and are never read.
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

interface GatewayDataRow {
  execution_id: string
  data: string | null
}

/**
 * Extracts the persisted Foreman event envelope's nested `data` object.
 *
 * Daemon events are stored as
 * `{schema_version, refs, data: {...}}`; the sampler fields (`provider`,
 * `publicModel`, `status`, `tps_sampling_contract`, `tps_samples`) live inside
 * `data`, never at the top level. Legacy flat rows are rejected rather than
 * silently mis-attributed.
 */
function parseEnvelopeData(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const envelope = parsed as Record<string, unknown>
  if (envelope.schema_version !== 'foreman.event.v1') return undefined
  const nested = envelope.data
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined
  return nested as Record<string, unknown>
}

/** Normalizes a provider-prefixed sample id to its bare model component. */
function normalizeSampleModel(provider: string | null, model: string): string {
  const bare = provider && model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model
  const canonical = canonicalizeObservedProviderModelId(provider ?? '', bare.trim())
  return canonical
}

/** Trailing freshness window for local speed aggregation (31 days). */
const LOCAL_SPEED_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
/** Minimum per-execution output tokens eligible for the speed estimate. */
const MIN_SAMPLE_OUTPUT_TOKENS = 256
/** Minimum per-execution paired generation milliseconds eligible for speed. */
const MIN_SAMPLE_DURATION_MS = 5000
/** Minimum observable generation window: first to last nonempty delta. */
const MIN_WINDOW_MS = 100
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
 * Reads completed, successful executions and their normalized tokenizer_v1
 * samples, producing one sample per execution. An execution qualifies only
 * when it is a `done` run with at least one valid paired tokenizer_v1 sample;
 * unobservable or buffered windows are skipped without poisoning the
 * execution's other complete valid samples. Historical `response_v1`
 * histories produce no sample and are never relabeled.
 *
 * Legacy accounting scopes remain available for billing but never influence
 * speed. Tokens and generation time are summed from the same samples.
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
      current.durationMs += sample.durationMs
      totalsByExecution.set(row.execution_id, current)
    }
    seenByExecution.set(row.execution_id, seen)
  }

  // Gateway inference records attributed to an execution take precedence over
  // any client-recorded usage for the same execution: the gateway sample is
  // paired with the exact upstream response. The event payload carries only the
  // execution id — never the supervisor's private cached sequence state.
  const gatewayRows = dbQueryOn<GatewayDataRow>(
    database,
    `SELECT execution_id, data FROM events
     WHERE type = 'gateway.request.completed' AND json_extract(data, '$.data.executionId') IN (${executionIds.map(() => '?').join(', ')})`,
    executionIds,
  )
  const gatewayByExecution = new Map<string, { samples: ResponseSample[]; invalid: boolean }>()
  for (const row of gatewayRows) {
    const attribution = parseGatewayAttribution(row.data)
    if (!attribution) continue
    const execution = executionById.get(attribution.executionId)
    if (!execution) continue
    // A successful response is measurable only when it carries the
    // tokenizer_v1 contract and a sample vector. Unobservable responses —
    // failed requests, buffered streams, or legacy response_v1 histories —
    // contribute no sample and never poison the execution's other complete
    // valid measurements.
    if (attribution.status !== 200 || attribution.contract !== 'tokenizer_v1' || !Array.isArray(attribution.tpsSamples)) continue
    const bucket = gatewayByExecution.get(attribution.executionId) ?? { samples: [], invalid: false }
    // A measurable gateway attribution must carry a provider/public model that
    // matches the dispatch identity; the paired samples come from the nested
    // envelope data.
    const provider = typeof attribution.provider === 'string' ? attribution.provider.trim() : ''
    const publicModel = typeof attribution.publicModel === 'string' ? attribution.publicModel.trim() : ''
    if (provider === '' || publicModel === '' || provider !== execution.provider || publicModel !== `${execution.provider}/${execution.model}`) {
      bucket.invalid = true
      gatewayByExecution.set(attribution.executionId, bucket)
      continue
    }
    const parsed = parseResponseSamplesRecord(attribution.payload, execution.model, execution.provider)
    if (parsed === undefined || parsed.invalid) {
      bucket.invalid = true
    } else {
      for (const sample of parsed.samples) bucket.samples.push(sample)
    }
    gatewayByExecution.set(attribution.executionId, bucket)
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

    const gateway = gatewayByExecution.get(row.executionId)
    // A measurable gateway attribution is authoritative: its samples are used
    // exclusively and client samples for the same execution are never added on
    // top of them. A wrong identity or conflicting replay rejects the
    // execution, while merely unobservable gateway responses fall back to the
    // client-recorded samples instead of hiding the execution's speed.
    if (gateway) {
      if (gateway.invalid) continue
      if (gateway.samples.length > 0) {
        const totals = sumResponseSamples(gateway.samples)
        if (!totals) continue
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
        continue
      }
    }

    // Without measurable gateway samples, invalid client-recorded samples
    // still invalidate the execution.
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

interface GatewayAttribution {
  executionId: string
  status: unknown
  provider: unknown
  publicModel: unknown
  contract: unknown
  tpsSamples: unknown
  payload: Record<string, unknown>
}

/**
 * Classifies one persisted gateway completion envelope for attribution. The
 * nested `data.executionId` is only joined to known done executions by the
 * caller; every identity decision stays there. Only a status-200 response
 * carrying the `tokenizer_v1` contract and a sample vector is measurable —
 * failed, buffered, or legacy `response_v1` responses are unobservable and are
 * skipped by the caller rather than poisoning the execution. Wrong dispatch
 * identity and conflicting replay are still rejected by the caller.
 */
function parseGatewayAttribution(value: string | null): GatewayAttribution | undefined {
  const data = parseEnvelopeData(value)
  if (data === undefined) return undefined
  const rawId = data.executionId
  if (typeof rawId !== 'string' || rawId.trim() === '') return undefined
  return {
    executionId: rawId.trim(),
    status: data.status,
    provider: data.provider,
    publicModel: data.publicModel,
    contract: data.tps_sampling_contract,
    tpsSamples: data.tps_samples,
    payload: data,
  }
}

/** Sums valid paired samples; conflicting duplicate response ids invalidate the set. */
function sumResponseSamples(samples: ResponseSample[]): { outputTokens: number; durationMs: number } | undefined {
  const seen = new Map<string, ResponseSample>()
  let outputTokens = 0
  let durationMs = 0
  for (const sample of samples) {
    const previous = seen.get(sample.responseId)
    if (previous) {
      if (!sameResponseSample(previous, sample)) return undefined
      continue
    }
    seen.set(sample.responseId, sample)
    outputTokens += sample.outputTokens
    durationMs += sample.durationMs
  }
  if (!isSafeInteger(outputTokens) || outputTokens <= 0) return undefined
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined
  return { outputTokens, durationMs }
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
 * Task-level TPS. Every done attempt (execution) carrying a measurable
 * tokenizer_v1 sample contributes its paired tokens and generation time
 * exactly once; a done attempt without observable timing contributes nothing
 * rather than hiding the measurable attempts. Failed attempts are never
 * included because they produce no sample at all.
 */
export function readTaskTps(taskId: string, db?: ForemanDatabase): TaskTps | undefined {
  const databases = db ?? getDb()
  const samples = readExecutionTpsSamples({ taskId }, databases)
  if (samples.length === 0) return undefined

  let outputTokens = 0
  let durationMs = 0
  for (const sample of samples) {
    outputTokens += sample.outputTokens
    durationMs += sample.durationMs
  }
  const tps = ratePerSecond(outputTokens, durationMs)
  if (tps === undefined) return undefined
  return { tps, outputTokens, durationMs }
}

/**
 * Parses one normalized tokenizer sampling payload. Invalid or incomplete
 * samples are omitted because adapters may omit responses lacking observable
 * timing or content; tokens are never borrowed from an unpaired response.
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
  return parseResponseSamplesRecord(parsed as Record<string, unknown>, dispatchModel, provider)
}

function parseResponseSamplesRecord(
  record: Record<string, unknown>,
  dispatchModel: string | null,
  provider: string | null,
): { samples: ResponseSample[]; invalid: boolean } | undefined {
  if (record.tps_sampling_contract !== 'tokenizer_v1') return undefined
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

/**
 * One normalized tokenizer measurement. A sample carries either the scalar
 * paired interval (`firstTokenAtMs`/`completedAtMs`) or the exact aggregate
 * vector of serial model-generation windows (`windows`), never both. Both
 * shapes describe the same thing — the observed generation intervals behind
 * the sample's counted content — and are collapsed here into the interval
 * vector plus its summed duration, so every downstream aggregation path
 * shares one formula and no fake continuous interval is ever synthesized.
 */
interface ResponseSample {
  responseId: string
  model: string
  outputTokens: number
  /** Ordered paired generation intervals; a scalar sample yields one interval. */
  windows: ResponseWindow[]
  /** Sum of every window duration, the shared TPS denominator. */
  durationMs: number
}

interface ResponseWindow {
  firstTokenAtMs: number
  completedAtMs: number
}

/**
 * Normalizes one tokenizer sample to the interval vector. A sample must carry
 * exactly one recognized timing shape: the scalar `first_token_at_ms` /
 * `completed_at_ms` pair, or the `generation_windows` vector. Mixed scalar and
 * vector fields, a missing or empty vector, and any malformed, non-finite,
 * non-positive, unordered, overlapping, or unsafe-summing window reject the
 * entire sample — a valid subset is never retained alongside the whole token
 * count, so tokens are never attributed to unmeasured time. A skipped sample
 * never poisons the execution's other complete valid samples.
 */
function parseResponseSample(value: unknown, dispatchModel: string | null, provider: string | null): (ResponseSample & { mismatchedModel?: false }) | { responseId: string; mismatchedModel: true } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const responseId = record.response_id
  const model = record.model
  const outputTokens = record.output_tokens
  if (typeof responseId !== 'string' || responseId.trim() === '') return undefined
  if (typeof model !== 'string' || model.trim() === '') return undefined
  // A window exists only when nonempty content was observed, so a measurable
  // sample always counts at least one token.
  if (typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens <= 0) return undefined
  const hasScalar = record.first_token_at_ms !== undefined || record.completed_at_ms !== undefined
  const hasVector = record.generation_windows !== undefined
  if (hasScalar === hasVector) return undefined
  const windows = hasVector
    ? parseGenerationWindows(record.generation_windows)
    : parseScalarWindow(record.first_token_at_ms, record.completed_at_ms)
  if (windows === undefined) return undefined
  let durationMs = 0
  for (const window of windows) durationMs += window.completedAtMs - window.firstTokenAtMs
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return undefined
  const normalized = {
    responseId: responseId.trim(),
    model: normalizeSampleModel(provider, model),
    outputTokens,
    windows,
    durationMs,
  }
  if (dispatchModel?.trim() !== normalized.model) return { responseId: normalized.responseId, mismatchedModel: true }
  return normalized
}

/**
 * Normalizes the legacy scalar paired interval into a single window. The
 * boundaries are the first and last nonempty delta arrivals, so a measurable
 * window spans at least two distinct arrival timestamps and MIN_WINDOW_MS.
 */
function parseScalarWindow(firstTokenAtMs: unknown, completedAtMs: unknown): ResponseWindow[] | undefined {
  if (typeof firstTokenAtMs !== 'number' || !Number.isFinite(firstTokenAtMs) || firstTokenAtMs <= 0) return undefined
  if (typeof completedAtMs !== 'number' || !Number.isFinite(completedAtMs) || completedAtMs <= firstTokenAtMs) return undefined
  if (completedAtMs - firstTokenAtMs < MIN_WINDOW_MS) return undefined
  return [{ firstTokenAtMs, completedAtMs }]
}

/**
 * Normalizes the exact aggregate generation-window vector. The array must be
 * nonempty and every window must be a finite, positive, strictly forward,
 * ordered interval of at least MIN_WINDOW_MS that does not overlap or repeat
 * its predecessor; a window must also never begin before its predecessor's
 * completion, so the vector only ever describes genuinely separate serial
 * generations.
 */
function parseGenerationWindows(value: unknown): ResponseWindow[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const windows: ResponseWindow[] = []
  let previousCompletedAtMs: number | undefined
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    const firstTokenAtMs = record.first_token_at_ms
    const completedAtMs = record.completed_at_ms
    if (typeof firstTokenAtMs !== 'number' || !Number.isFinite(firstTokenAtMs) || firstTokenAtMs <= 0) return undefined
    if (typeof completedAtMs !== 'number' || !Number.isFinite(completedAtMs) || completedAtMs <= firstTokenAtMs) return undefined
    if (completedAtMs - firstTokenAtMs < MIN_WINDOW_MS) return undefined
    if (previousCompletedAtMs !== undefined && firstTokenAtMs < previousCompletedAtMs) return undefined
    windows.push({ firstTokenAtMs, completedAtMs })
    previousCompletedAtMs = completedAtMs
  }
  return windows
}

function sameResponseSample(a: ResponseSample, b: ResponseSample): boolean {
  if (a.responseId !== b.responseId || a.model !== b.model || a.outputTokens !== b.outputTokens) return false
  if (a.windows.length !== b.windows.length) return false
  for (let index = 0; index < a.windows.length; index += 1) {
    const left = a.windows[index]
    const right = b.windows[index]
    if (left.firstTokenAtMs !== right.firstTokenAtMs || left.completedAtMs !== right.completedAtMs) return false
  }
  return true
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
