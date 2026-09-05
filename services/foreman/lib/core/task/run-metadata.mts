import { get as dbGet, query as dbQuery } from '../../db/connection.mts'
import type {
  TaskReferencePricing,
  TaskResolvedDispatch,
  TaskResolvedSpeed,
  TaskUsage,
  TaskUsageCompleteness,
} from '../../task-run-metadata-types.mts'

/**
 * Canonical, DB-backed projection of a task run's resolved dispatch and
 * reference usage. Delivery (status / output / wait) and the stats ledger both
 * call this single helper so the resolved/usage shape is computed exactly once
 * and never recomputed or guessed on the client.
 *
 * Every execution attempt linked to the task is aggregated. Each attempt's
 * reference cost is computed with that attempt's own captured model/pricing
 * snapshot and the raw turn_usage tokens persisted for its execution_id — never
 * by an even-split approximation across attempts. Failed/retry attempts are
 * included. Unknown numerics are omitted, never zero-filled, and historical
 * incomplete dispatches are represented by omitting `resolved` entirely rather
 * than emitting a partial snapshot object.
 */
export interface TaskRunResolvedUsage {
  resolved?: TaskResolvedDispatch
  usage: TaskUsage
}

interface AttemptDispatchRow {
  execution_id: string
  requested_agent_runtime: string | null
  profile: string | null
  client: string | null
  provider: string | null
  model: string | null
  model_id: string | null
  mode: string | null
  protocol: string | null
  speed_effective_tps: number | null
  speed_source: string | null
  speed_sample_count: number | null
  speed_checked_at: string | null
  speed_expected_tps_met: number | null
  speed_degradation_reason: string | null
  intelligence: string | null
  reference_pricing_input: number | null
  reference_pricing_output: number | null
  reference_pricing_cache: number | null
  reference_pricing_cache_write: number | null
  reference_pricing_source: string | null
  reference_pricing_checked_at: string | null
}

interface TelemetryRow {
  usage_event_count: number
  agent_turn_ms: number
  tps_complete: number
}

export function readTaskRunMetadata(taskRunId: string): TaskRunResolvedUsage {
  const telemetry = dbGet<TelemetryRow | undefined>(
    `SELECT usage_event_count, agent_turn_ms, tps_complete
     FROM task_run_telemetry WHERE task_run_id = ?`,
    taskRunId,
  )

  // Build the attempt set from every execution for this task. The executions
  // table keys attempts by `id`; alias it to execution_id for a stable join
  // with usage events and dispatch snapshots.
  const attemptRows = dbQuery<{ execution_id: string }>(
    `SELECT id AS execution_id FROM executions WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
    taskRunId,
  )

  const dispatchRows = dbQuery<AttemptDispatchRow>(
    `SELECT execution_id, requested_agent_runtime, profile, client, provider,
            model, model_id, mode, protocol,
            speed_effective_tps, speed_source, speed_sample_count,
            speed_checked_at, speed_expected_tps_met, speed_degradation_reason,
            intelligence,
            reference_pricing_input, reference_pricing_output, reference_pricing_cache,
            reference_pricing_cache_write,
            reference_pricing_source, reference_pricing_checked_at
     FROM task_run_attempt_dispatch WHERE task_run_id = ? ORDER BY created_at ASC, execution_id ASC`,
    taskRunId,
  )
  const dispatchByExecution = new Map<string, AttemptDispatchRow>()
  for (const d of dispatchRows) dispatchByExecution.set(d.execution_id, d)

  // Read every persisted turn_usage row for each execution attempt, ordered by
  // seq. A row is kept as a record even when its JSON or numerics are invalid,
  // so it can force coverage to incomplete rather than be silently dropped.
  const eventsByExecution = new Map<string, TurnUsageEvent[]>()
  for (const a of attemptRows) {
    eventsByExecution.set(a.execution_id, readExecutionEvents(a.execution_id))
  }

  const usageEventCount = telemetry?.usage_event_count ?? 0

  // --- Token projection -------------------------------------------------
  // Unavailable when there are no attempts or no additive event carries any
  // valid token partition. Otherwise 'complete' requires every attempt to have
  // at least one persisted row, every row to be additive agent_turn, and every
  // row to carry valid input, normalized cached total and output. Decoupled
  // from pricing and TPS completeness.
  let anyAdditiveValidToken = false
  let everyAttemptHasRow = attemptRows.length > 0
  let everyRowAdditive = true
  let everyRowFullTokens = true
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    if (events.length === 0) {
      everyAttemptHasRow = false
      continue
    }
    for (const e of events) {
      if (!e.additive) {
        everyRowAdditive = false
        continue
      }
      if (e.input !== undefined || e.cached !== undefined || e.output !== undefined) {
        anyAdditiveValidToken = true
      }
      if (e.input === undefined || e.cached === undefined || e.output === undefined) {
        everyRowFullTokens = false
      }
    }
  }

  let completeness: TaskUsageCompleteness
  if (attemptRows.length === 0 || !anyAdditiveValidToken) completeness = 'unavailable'
  else if (everyAttemptHasRow && everyRowAdditive && everyRowFullTokens) completeness = 'complete'
  else completeness = 'partial'

  const usage: TaskUsage = {
    completeness,
    attempt_count: attemptRows.length,
    usage_event_count: usageEventCount,
    reference_cost_complete: false,
  }

  // Per-field aggregates are emitted only when every attempt is covered, every
  // persisted event is additive, and every persisted event carries that exact
  // normalized field. A mixed event set may truthfully emit output_tokens while
  // omitting input_tokens. cached_input_tokens uses the normalized cached total;
  // read/creation aggregates are emitted only when each event has that split.
  let allInput = everyAttemptHasRow && everyRowAdditive
  let allCached = everyAttemptHasRow && everyRowAdditive
  let allOutput = everyAttemptHasRow && everyRowAdditive
  let allRead = everyAttemptHasRow && everyRowAdditive
  let allWrite = everyAttemptHasRow && everyRowAdditive
  let sumInput = 0
  let sumCached = 0
  let sumOutput = 0
  let sumRead = 0
  let sumWrite = 0
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    for (const e of events) {
      if (!e.additive) {
        allInput = allCached = allOutput = allRead = allWrite = false
        continue
      }
      if (e.input !== undefined) sumInput += e.input
      else allInput = false
      if (e.cached !== undefined) sumCached += e.cached
      else allCached = false
      if (e.output !== undefined) sumOutput += e.output
      else allOutput = false
      if (e.read !== undefined) sumRead += e.read
      else allRead = false
      if (e.write !== undefined) sumWrite += e.write
      else allWrite = false
    }
  }

  if (allInput) usage.input_tokens = sumInput
  if (allCached) usage.cached_input_tokens = sumCached
  if (allOutput) usage.output_tokens = sumOutput
  if (allRead) usage.cache_read_input_tokens = sumRead
  if (allWrite) usage.cache_creation_input_tokens = sumWrite
  if (allInput && allCached && allOutput) {
    usage.total_tokens = sumInput + sumCached + sumOutput
  }

  // --- TPS projection ---------------------------------------------------
  // Evaluated independently of token/cost completeness. Trusted only when every
  // persisted row carries trusted TPS evidence and telemetry agrees exactly.
  let tpsTrusted = attemptRows.length > 0
  let tpsEventCount = 0
  let sumDurationMs = 0
  let sumTpsOutput = 0
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    if (events.length === 0) {
      tpsTrusted = false
      continue
    }
    for (const e of events) {
      if (!e.tpsTrusted) {
        tpsTrusted = false
        continue
      }
      tpsEventCount++
      sumDurationMs += e.tpsDurationMs!
      sumTpsOutput += e.tpsOutput!
    }
  }
  const telemetryReady = telemetry != null
    && telemetry.tps_complete === 1
    && telemetry.usage_event_count === tpsEventCount
  if (tpsTrusted && telemetryReady) {
    usage.agent_turn_ms = sumDurationMs
    usage.output_tps = sumDurationMs > 0 ? (1000 * sumTpsOutput) / sumDurationMs : 0
    usage.tps_contract = 'agent_turn_v1'
  }

  // --- Cost projection --------------------------------------------------
  // Price every additive event in its own attempt with that attempt's captured
  // dispatch snapshot. A complete cost requires full per-event coverage,
  // internally consistent cache splits, and a finite nonnegative rate for every
  // positive token component. A partial sum is never exposed.
  let referenceCostUsd = 0
  let costComplete = attemptRows.length > 0
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    const dispatch = dispatchByExecution.get(a.execution_id)
    if (events.length === 0 || !dispatch) {
      costComplete = false
      continue
    }
    for (const e of events) {
      if (!e.additive || e.input === undefined || e.cached === undefined || e.output === undefined) {
        costComplete = false
        continue
      }
      const { cost, fullyPriced } = priceEvent(e, dispatch)
      if (!fullyPriced) costComplete = false
      referenceCostUsd += cost
    }
  }
  if (costComplete) {
    usage.reference_cost_usd = referenceCostUsd
    usage.reference_cost_basis = 'catalog_reference'
    usage.reference_cost_complete = true
  }

  // Resolved dispatch: the most recent attempt whose captured snapshot is
  // schema-valid and complete (all required identity/speed/intelligence/
  // pricing fields present). Historical incomplete dispatches are omitted
  // entirely rather than emitted as a partial object.
  let resolved: TaskResolvedDispatch | undefined
  for (let i = dispatchRows.length - 1; i >= 0; i--) {
    const candidate = toResolvedDispatch(dispatchRows[i])
    if (candidate) {
      resolved = candidate
      break
    }
  }

  return { resolved, usage }
}

function toResolvedDispatch(row: AttemptDispatchRow): TaskResolvedDispatch | undefined {
  const speed = toSpeed(row)
  const pricing = toPricing(row)
  if (!speed || !pricing) return undefined
  // All identity / speed / intelligence / pricing fields must form a full,
  // schema-valid snapshot; otherwise the dispatch is treated as historical and
  // incomplete and is omitted.
  if (
    !row.requested_agent_runtime
    || !row.profile
    || !row.client
    || !row.provider
    || !row.model
    || !row.model_id
    || !(row.mode === 'native' || row.mode === 'gateway')
    || !row.intelligence
  ) return undefined
  const resolved: TaskResolvedDispatch = {
    requested_agent_runtime: row.requested_agent_runtime,
    profile: row.profile,
    client: row.client,
    provider: row.provider,
    model: row.model,
    model_id: row.model_id,
    mode: row.mode === 'gateway' ? 'gateway' : 'native',
    speed,
    intelligence: row.intelligence,
    reference_pricing: pricing,
  }
  if (row.protocol) resolved.protocol = row.protocol
  return resolved
}

function toSpeed(row: AttemptDispatchRow): TaskResolvedSpeed | undefined {
  if (
    row.speed_effective_tps == null
    || !Number.isFinite(row.speed_effective_tps)
    || row.speed_effective_tps < 0
    || row.speed_source == null
    || (row.speed_source !== 'local_31d' && row.speed_source !== 'catalog_default')
    || row.speed_sample_count == null
    || !Number.isInteger(row.speed_sample_count)
    || row.speed_sample_count < 0
    || row.speed_checked_at == null
    || row.speed_checked_at === ''
    || row.speed_expected_tps_met == null
    || (row.speed_expected_tps_met !== 0 && row.speed_expected_tps_met !== 1)
  ) return undefined
  const speed: TaskResolvedSpeed = {
    effective_tps: row.speed_effective_tps,
    source: row.speed_source,
    sample_count: row.speed_sample_count,
    checked_at: row.speed_checked_at,
    expected_tps_met: row.speed_expected_tps_met === 1,
  }
  if (row.speed_degradation_reason) speed.degradation_reason = row.speed_degradation_reason
  return speed
}

function toPricing(row: AttemptDispatchRow): TaskReferencePricing | undefined {
  if (row.reference_pricing_source == null || row.reference_pricing_checked_at == null || row.reference_pricing_checked_at === '') return undefined
  const prices: (number | null)[] = [
    row.reference_pricing_input,
    row.reference_pricing_output,
    row.reference_pricing_cache,
    row.reference_pricing_cache_write,
  ]
  for (const v of prices) {
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return undefined
  }
  const pricing: TaskReferencePricing = {
    source: row.reference_pricing_source,
    checked_at: row.reference_pricing_checked_at,
  }
  if (row.reference_pricing_input != null) pricing.input_usd_per_million = row.reference_pricing_input
  if (row.reference_pricing_output != null) pricing.output_usd_per_million = row.reference_pricing_output
  if (row.reference_pricing_cache != null) pricing.cached_input_usd_per_million = row.reference_pricing_cache
  if (row.reference_pricing_cache_write != null) pricing.cache_write_input_usd_per_million = row.reference_pricing_cache_write
  return pricing
}

/**
 * A single turn_usage record with presence semantics. `additive` is true only
 * when token_scope === 'agent_turn'. `cached` is the normalized cached total
 * (full cached when present, otherwise read+creation when both splits are
 * valid). `tpsTrusted` holds independently of input/cache validity.
 */
interface TurnUsageEvent {
  additive: boolean
  input?: number
  cached?: number
  read?: number
  write?: number
  output?: number
  tpsTrusted: boolean
  tpsOutput?: number
  tpsDurationMs?: number
}

const EMPTY_TURN_EVENT: TurnUsageEvent = { additive: false, tpsTrusted: false }

/**
 * Read every persisted turn_usage row for one execution, ordered by seq. A row
 * whose JSON or scope is invalid is kept as a non-additive record so it can
 * force coverage to incomplete rather than be silently dropped.
 */
function readExecutionEvents(executionId: string): TurnUsageEvent[] {
  const rows = dbQuery<{ data: string | null }>(
    `SELECT data FROM events WHERE execution_id = ? AND type = 'turn_usage' ORDER BY seq ASC`,
    executionId,
  )
  return rows.map((row) => parseTurnUsage(row.data))
}

function parseTurnUsage(value: string | null): TurnUsageEvent {
  if (value === null) return EMPTY_TURN_EVENT
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return EMPTY_TURN_EVENT
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_TURN_EVENT
  const rec = parsed as Record<string, unknown>

  const additive = rec.token_scope === 'agent_turn'
  const input = additive ? readNonNegativeInteger(rec.input_tokens) : undefined
  const fullCached = additive ? readNonNegativeInteger(rec.cached_input_tokens) : undefined
  const readSplit = additive ? readNonNegativeInteger(rec.cache_read_input_tokens) : undefined
  const writeSplit = additive ? readNonNegativeInteger(rec.cache_creation_input_tokens) : undefined
  const output = additive ? readNonNegativeInteger(rec.output_tokens) : undefined

  // Normalized cached total: full cached when present, otherwise read+creation
  // only when both optional splits are valid, otherwise undefined. The full
  // cached value is never added on top of the splits.
  let cached: number | undefined
  if (fullCached !== undefined) cached = fullCached
  else if (readSplit !== undefined && writeSplit !== undefined) cached = readSplit + writeSplit

  // TPS evidence is trusted independently of input/cache validity.
  const durationMs = rec.duration_ms
  const tpsTrusted =
    additive
    && rec.duration_scope === 'agent_turn'
    && rec.tps_contract === 'agent_turn_v1'
    && output !== undefined
    && typeof durationMs === 'number'
    && Number.isFinite(durationMs)
    && durationMs > 0

  const ev: TurnUsageEvent = {
    additive,
    input,
    cached,
    read: readSplit,
    write: writeSplit,
    output,
    tpsTrusted,
  }
  if (tpsTrusted) {
    ev.tpsOutput = output
    ev.tpsDurationMs = durationMs as number
  }
  return ev
}

/**
 * Accept only finite integers >= 0. Missing and invalid values stay undefined
 * and are never coerced to 0.
 */
function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function validRate(rate: number | null): boolean {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0
}

/**
 * Price a single additive event with the dispatch snapshot captured for its own
 * execution attempt. A valid zero component needs no rate; a positive component
 * without a finite nonnegative rate makes the result not fully priced. With a
 * creation split, price creation at the cache_write rate and the (cached -
 * creation) remainder at the generic cache rate; the full cached partition is
 * never added on top of the splits. Without a creation split, price the full
 * cached partition at the generic cache rate.
 */
function priceEvent(e: TurnUsageEvent, d: AttemptDispatchRow): { cost: number; fullyPriced: boolean } {
  let cost = 0
  let fullyPriced = true

  if (e.input !== undefined) {
    if (e.input > 0 && !validRate(d.reference_pricing_input)) fullyPriced = false
    else if (e.input > 0) cost += (e.input * d.reference_pricing_input!) / 1_000_000
  }
  if (e.output !== undefined) {
    if (e.output > 0 && !validRate(d.reference_pricing_output)) fullyPriced = false
    else if (e.output > 0) cost += (e.output * d.reference_pricing_output!) / 1_000_000
  }

  if (e.cached !== undefined) {
    if (e.write !== undefined) {
      // creation split present: enforce internal consistency
      if (e.write > e.cached) {
        fullyPriced = false
      } else if (e.read !== undefined && e.read + e.write > e.cached) {
        fullyPriced = false
      } else {
        if (e.write > 0 && !validRate(d.reference_pricing_cache_write)) fullyPriced = false
        else if (e.write > 0) cost += (e.write * d.reference_pricing_cache_write!) / 1_000_000
        const remainder = e.cached - e.write
        if (remainder > 0) {
          if (!validRate(d.reference_pricing_cache)) fullyPriced = false
          else cost += (remainder * d.reference_pricing_cache!) / 1_000_000
        }
      }
    } else if (e.cached > 0) {
      if (!validRate(d.reference_pricing_cache)) fullyPriced = false
      else cost += (e.cached * d.reference_pricing_cache!) / 1_000_000
    }
  }

  return { cost, fullyPriced }
}
