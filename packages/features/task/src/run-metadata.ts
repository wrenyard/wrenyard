import { REASONING_EFFORTS } from '@wrenyard/providers/catalog'
import type {
  TaskAutoRoutingDecision,
  TaskReferencePricing,
  TaskResolvedDispatch,
  TaskResolvedSpeed,
  TaskUsage,
  TaskUsageCompleteness,
  ReasoningEffort,
} from '@wrenyard/protocol'

/**
 * Structural store port supplying the two read shapes this module needs. The
 * daemon injects its database helpers; nothing here opens a connection.
 */
export interface TaskRunMetadataStore {
  get<T>(sql: string, ...params: unknown[]): T | undefined
  query<T>(sql: string, ...params: unknown[]): T[]
}

/** One execution speed sample; mirrors only the fields projected here. */
export interface TaskRunMetadataTpsSample {
  taskId: string
  outputTokens: number
  durationMs: number
}

/** Task-level TPS aggregate; mirrors only the fields projected here. */
export interface TaskRunMetadataTps {
  tps: number
  outputTokens: number
  durationMs: number
}

/**
 * Injected IO port for every read this module performs: SQL reads through
 * `store`, plus the two TPS readers. Keeps the projection pure so the task
 * package never imports daemon database or event code.
 */
export interface TaskRunMetadataDeps {
  store: TaskRunMetadataStore
  readTaskTps: (taskId: string) => TaskRunMetadataTps | undefined
  readExecutionTpsSamples: (options: { taskIds: string[] }) => TaskRunMetadataTpsSample[]
}

/**
 * Legal reasoning-effort guard. Kept in this module because the shared
 * metadata vocabulary in `@wrenyard/protocol` is type-only; the level list
 * itself comes from the provider catalog.
 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

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
 * included, and a single scope-less turn_usage snapshot (a failed or cancelled
 * run whose client never claimed the trusted agent_turn contract) is displayed
 * as a partial snapshot while never upgrading completeness or summing several
 * unscoped rows. Unknown numerics are omitted, never zero-filled, and
 * historical incomplete dispatches are represented by omitting `resolved`
 * entirely rather than emitting a partial snapshot object.
 */
export interface TaskRecordedModelIdentity {
  provider: string
  model: string
}

export interface TaskRunResolvedUsage {
  resolved?: TaskResolvedDispatch
  /**
   * Internal recorded provider/model, independent of the strict resolved
   * snapshot. Present whenever an attempt persisted both identity fields, even
   * when pricing/speed made `resolved` unavailable. It is read from the
   * persisted dispatch row, or — only when no attempt recorded a dispatch
   * identity — from a successfully attributed gateway completion whose public
   * model is exactly `<provider>/<model>`. A requested policy/profile is never
   * a source.
   */
  recorded?: TaskRecordedModelIdentity
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
  reasoning_effort: string | null
  fast: number | null
  reference_pricing_input: number | null
  reference_pricing_output: number | null
  reference_pricing_cache: number | null
  reference_pricing_cache_write: number | null
  reference_pricing_source: string | null
  reference_pricing_checked_at: string | null
  auto_routing: string | null
}

export function readTaskRunMetadata(taskRunId: string, deps: TaskRunMetadataDeps): TaskRunResolvedUsage {
  const telemetry = deps.store.get<{ usage_event_count: number } | undefined>(
    `SELECT usage_event_count FROM task_run_telemetry WHERE task_run_id = ?`,
    taskRunId,
  )

  // Build the attempt set from every execution for this task. The executions
  // table keys attempts by `id`; alias it to execution_id for a stable join
  // with usage events and dispatch snapshots.
  const attemptRows = deps.store.query<{ execution_id: string }>(
    `SELECT id AS execution_id FROM executions WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
    taskRunId,
  )

  const dispatchRows = deps.store.query<AttemptDispatchRow>(
    `SELECT execution_id, requested_agent_runtime, profile, client, provider,
            model, model_id, mode, protocol,
            speed_effective_tps, speed_source, speed_sample_count,
            speed_checked_at, speed_expected_tps_met, speed_degradation_reason,
            intelligence,
            reasoning_effort,
            fast,
            reference_pricing_input, reference_pricing_output, reference_pricing_cache,
            reference_pricing_cache_write,
            reference_pricing_source, reference_pricing_checked_at,
            auto_routing
     FROM task_run_attempt_dispatch WHERE task_run_id = ? ORDER BY created_at ASC, execution_id ASC`,
    taskRunId,
  )

  // Read every persisted turn_usage row for each execution attempt, ordered by
  // seq. A row is kept as a record even when its JSON or numerics are invalid,
  // so it can force coverage to incomplete rather than be silently dropped.
  const executionIds = attemptRows.map((a) => a.execution_id)
  const gatewayByExecution = readGatewayEvidence(executionIds, deps)
  const eventsByExecution = new Map<string, TurnUsageEvent[]>()
  for (const a of attemptRows) {
    eventsByExecution.set(a.execution_id, readExecutionEvents(a.execution_id, deps))
  }

  const taskTps = deps.readTaskTps(taskRunId)
  return projectTaskRunMetadata({
    attemptRows,
    dispatchRows,
    usageEventCount: telemetry?.usage_event_count ?? 0,
    eventsByExecution,
    gatewayByExecution,
    taskTps,
  })
}

/**
 * Batch variant of `readTaskRunMetadata`. Runs one bounded query per backing
 * table for the whole id set — telemetry counts, execution attempts (same
 * created_at/id ordering), dispatch snapshots, and turn_usage events ordered
 * by seq — groups rows by task/execution in memory, obtains every task's TPS
 * with a single readExecutionTpsSamples({taskIds}) call, then applies the same
 * projection per run. Returns a Map keyed by task run id; every requested id
 * is present, including tasks with no executions.
 */
export function readTaskRunMetadataBatch(taskRunIds: string[], deps: TaskRunMetadataDeps): Map<string, TaskRunResolvedUsage> {
  const result = new Map<string, TaskRunResolvedUsage>()
  if (taskRunIds.length === 0) return result
  const placeholders = taskRunIds.map(() => '?').join(', ')

  const telemetryByTask = new Map<string, number>()
  for (const row of deps.store.query<{ task_run_id: string; usage_event_count: number }>(
    `SELECT task_run_id, usage_event_count FROM task_run_telemetry WHERE task_run_id IN (${placeholders})`,
    ...taskRunIds,
  )) {
    telemetryByTask.set(row.task_run_id, row.usage_event_count)
  }

  const attemptsByTask = new Map<string, { execution_id: string }[]>()
  const attemptRows = deps.store.query<{ execution_id: string; task_id: string }>(
    `SELECT id AS execution_id, task_id FROM executions WHERE task_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    ...taskRunIds,
  )
  for (const row of attemptRows) {
    const bucket = attemptsByTask.get(row.task_id) ?? []
    bucket.push({ execution_id: row.execution_id })
    attemptsByTask.set(row.task_id, bucket)
  }

  const dispatchByTask = new Map<string, AttemptDispatchRow[]>()
  for (const row of deps.store.query<AttemptDispatchRow & { task_run_id: string }>(
    `SELECT task_run_id, execution_id, requested_agent_runtime, profile, client, provider,
            model, model_id, mode, protocol,
            speed_effective_tps, speed_source, speed_sample_count,
            speed_checked_at, speed_expected_tps_met, speed_degradation_reason,
            intelligence,
            reasoning_effort,
            fast,
            reference_pricing_input, reference_pricing_output, reference_pricing_cache,
            reference_pricing_cache_write,
            reference_pricing_source, reference_pricing_checked_at,
            auto_routing
     FROM task_run_attempt_dispatch WHERE task_run_id IN (${placeholders}) ORDER BY created_at ASC, execution_id ASC`,
    ...taskRunIds,
  )) {
    const bucket = dispatchByTask.get(row.task_run_id) ?? []
    bucket.push(row)
    dispatchByTask.set(row.task_run_id, bucket)
  }

  const executionIds = attemptRows.map((row) => row.execution_id)
  const gatewayByExecution = readGatewayEvidence(executionIds, deps)
  const eventsByExecution = new Map<string, TurnUsageEvent[]>()
  if (executionIds.length > 0) {
    const eventPlaceholders = executionIds.map(() => '?').join(', ')
    for (const row of deps.store.query<{ execution_id: string; data: string | null }>(
      `SELECT execution_id, data FROM events WHERE execution_id IN (${eventPlaceholders}) AND type = 'turn_usage' ORDER BY seq ASC`,
      ...executionIds,
    )) {
      const bucket = eventsByExecution.get(row.execution_id) ?? []
      bucket.push(parseTurnUsage(row.data))
      eventsByExecution.set(row.execution_id, bucket)
    }
  }
  // Same sum/rate semantics as readTaskTps: aggregate each task's samples and
  // keep only a finite positive tokens-per-second rate.
  const tpsByTask = new Map<string, TaskRunMetadataTps>()
  const samplesByTask = new Map<string, { outputTokens: number; durationMs: number }>()
  for (const sample of deps.readExecutionTpsSamples({ taskIds: taskRunIds })) {
    const totals = samplesByTask.get(sample.taskId) ?? { outputTokens: 0, durationMs: 0 }
    totals.outputTokens += sample.outputTokens
    totals.durationMs += sample.durationMs
    samplesByTask.set(sample.taskId, totals)
  }
  for (const [taskId, totals] of samplesByTask) {
    if (!Number.isSafeInteger(totals.outputTokens) || totals.outputTokens <= 0) continue
    if (!Number.isFinite(totals.durationMs) || totals.durationMs <= 0) continue
    const tps = (1000 * totals.outputTokens) / totals.durationMs
    if (Number.isFinite(tps) && tps > 0) {
      tpsByTask.set(taskId, { tps, outputTokens: totals.outputTokens, durationMs: totals.durationMs })
    }
  }

  for (const taskRunId of taskRunIds) {
    result.set(taskRunId, projectTaskRunMetadata({
      attemptRows: attemptsByTask.get(taskRunId) ?? [],
      dispatchRows: dispatchByTask.get(taskRunId) ?? [],
      usageEventCount: telemetryByTask.get(taskRunId) ?? 0,
      eventsByExecution,
      gatewayByExecution,
      taskTps: tpsByTask.get(taskRunId),
    }))
  }
  return result
}

/**
 * Successful gateway completion facts used by both readers. `usage`/`measured`
 * carry the per-executionId usage sums that backfill partitions the client
 * never reported; `identity` keeps the persisted event id so the latest
 * attributed identity can be selected deterministically.
 */
interface GatewayEvidence {
  /** Summed usage partitions across successful completions. */
  usage: { input: number; output: number; cached: number }
  /** Per-partition measurement latch: true when at least one completion carried the field. */
  measured: { input: boolean; output: boolean; cached: boolean }
  identity?: { provider: string; model: string; eventId: number }
}

/**
 * Reads the successful gateway completions attributed to the given execution
 * ids in one bounded query. The predicate mirrors the partial expression index
 * (`likely(type = ...)` plus `json_extract(data, '$.data.executionId')`), so the
 * lookup stays indexed without naming the index.
 */
function readGatewayEvidence(executionIds: string[], deps: TaskRunMetadataDeps): Map<string, GatewayEvidence> {
  const result = new Map<string, GatewayEvidence>()
  if (executionIds.length === 0) return result
  const placeholders = executionIds.map(() => '?').join(', ')
  for (const row of deps.store.query<{ id: number; data: string | null }>(
    `SELECT id, data FROM events
     WHERE likely(type = 'gateway.request.completed') AND json_extract(data, '$.data.executionId') IN (${placeholders})
     ORDER BY id ASC`,
    ...executionIds,
  )) {
    const parsed = parseGatewayCompletion(row.data, row.id)
    if (!parsed) continue
    const evidence = result.get(parsed.executionId) ?? {
      usage: { input: 0, output: 0, cached: 0 },
      measured: { input: false, output: false, cached: false },
    }
    if (parsed.identity) evidence.identity = parsed.identity
    evidence.usage.input += parsed.usage.input
    evidence.usage.output += parsed.usage.output
    evidence.usage.cached += parsed.usage.cached
    if (parsed.measured.input) evidence.measured.input = true
    if (parsed.measured.output) evidence.measured.output = true
    if (parsed.measured.cached) evidence.measured.cached = true
    result.set(parsed.executionId, evidence)
  }
  return result
}

/**
 * Classifies one persisted gateway completion. Only a `foreman.event.v1`
 * envelope with a successful status (200) carries attributed facts; failed or
 * unparseable records are ignored rather than treated as unmeasured. A missing
 * or non-integer `usage.input` means input was not measured, while an explicit
 * numeric zero stays a genuine measurement.
 */
function parseGatewayCompletion(
  value: string | null,
  eventId: number,
): {
  executionId: string
  usage: { input: number; output: number; cached: number }
  measured: { input: boolean; output: boolean; cached: boolean }
  identity?: { provider: string; model: string; eventId: number }
} | undefined {
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
  const rawData = envelope.data
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return undefined
  const data = rawData as Record<string, unknown>
  if (data.status !== 200) return undefined
  const executionId = typeof data.executionId === 'string' ? data.executionId.trim() : ''
  if (executionId === '') return undefined

  const rawUsage = data.usage
  const usage = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
    ? rawUsage as Record<string, unknown>
    : undefined
  // Gateway contract: `input` is the full measured input (it already includes
  // any cached portion), so `cachedInput` is summed separately and never added
  // on top of `input`.
  const inputValue = readNonNegativeInteger(usage?.input)
  const outputValue = readNonNegativeInteger(usage?.output)
  const cachedValue = readNonNegativeInteger(usage?.cachedInput)
  const usageSums = {
    input: inputValue ?? 0,
    output: outputValue ?? 0,
    cached: cachedValue ?? 0,
  }
  const measured = {
    input: inputValue !== undefined,
    output: outputValue !== undefined,
    cached: cachedValue !== undefined,
  }

  const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
  const publicModel = typeof data.publicModel === 'string' ? data.publicModel.trim() : ''
  let identity: { provider: string; model: string; eventId: number } | undefined
  if (provider !== '' && publicModel.startsWith(`${provider}/`)) {
    const model = publicModel.slice(provider.length + 1).trim()
    if (model !== '') identity = { provider, model, eventId }
  }
  return { executionId, usage: usageSums, measured, identity }
}

function isNonBlank(value: string | null): value is string {
  return value !== null && value.trim() !== ''
}

/** Pure projection shared by the single-run and batch readers. */
function projectTaskRunMetadata(input: {
  attemptRows: { execution_id: string }[]
  dispatchRows: AttemptDispatchRow[]
  usageEventCount: number
  eventsByExecution: Map<string, TurnUsageEvent[]>
  gatewayByExecution: Map<string, GatewayEvidence>
  taskTps: TaskRunMetadataTps | undefined
}): TaskRunResolvedUsage {
  const { attemptRows, dispatchRows, usageEventCount, eventsByExecution, gatewayByExecution, taskTps } = input
  const dispatchByExecution = new Map<string, AttemptDispatchRow>()
  for (const d of dispatchRows) dispatchByExecution.set(d.execution_id, d)

  // --- Token projection -------------------------------------------------
  // A persisted row is TRUSTED only when it carries token_scope ===
  // 'agent_turn' (the additive agent-turn contract). A scope-less row is a
  // partial displayable snapshot and is accepted ONLY when it is the single
  // turn_usage record persisted for that execution/attempt, so captured
  // partitions from a failed or cancelled run stay visible without ever
  // summing several unscoped rows. An explicit cumulative/foreign scope, or a
  // malformed row, is excluded and contributes nothing.
  //
  // Unavailable when there are no attempts or no displayable event carries any
  // valid token partition. Otherwise 'complete' requires every attempt to have
  // at least one persisted row, every row to be trusted additive, and every
  // row to carry valid input, normalized cached total and output. Gateway
  // backfilled partitions do not count toward completeness: they carry no
  // client trust evidence, so 'partial' already describes the emitted usage.
  // Decoupled from pricing and TPS completeness.
  let anyDisplayableValidToken = false
  let everyAttemptHasRow = attemptRows.length > 0
  let everyRowTrusted = true
  let everyRowFullTokens = true
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    if (events.length === 0) {
      everyAttemptHasRow = false
      continue
    }
    for (const e of events) {
      if (!isDisplayableTurnUsage(e, events.length)) {
        everyRowTrusted = false
        continue
      }
      if (e.trust !== 'additive') everyRowTrusted = false
      if (e.input !== undefined || e.cached !== undefined || e.output !== undefined) {
        anyDisplayableValidToken = true
      }
      if (e.input === undefined || e.cached === undefined || e.output === undefined) {
        everyRowFullTokens = false
      }
    }
  }

  // Gateway coverage probe: a run may carry no client turn_usage rows at all
  // yet still be measurable through its attributed gateway completions, in
  // which case the emitted usage is useful (but not client-verified).
  let anyGatewayMeasured = false
  for (const a of attemptRows) {
    const evidence = gatewayByExecution.get(a.execution_id)
    if (evidence && (evidence.measured.input || evidence.measured.output || evidence.measured.cached)) {
      anyGatewayMeasured = true
      break
    }
  }

  let completeness: TaskUsageCompleteness
  if (attemptRows.length === 0 || (!anyDisplayableValidToken && !anyGatewayMeasured)) completeness = 'unavailable'
  else if (everyAttemptHasRow && everyRowTrusted && everyRowFullTokens) completeness = 'complete'
  else completeness = 'partial'

  const usage: TaskUsage = {
    completeness,
    attempt_count: attemptRows.length,
    usage_event_count: usageEventCount,
    reference_cost_complete: false,
  }

  // Per-field aggregates are emitted only for displayable events, and only
  // when every attempt is covered and every displayable event carries that
  // exact normalized field. A mixed event set may truthfully emit output_tokens
  // while omitting input_tokens. Any non-displayable row (an explicit
  // cumulative/foreign scope, a malformed row, or one of several unscoped rows)
  // blocks every field, so a partial snapshot is never summed into a
  // fabricated total. cached_input_tokens uses the normalized cached total;
  // read/creation aggregates are emitted only when each event has that split.
  let allInput = everyAttemptHasRow
  let allCached = everyAttemptHasRow
  let allOutput = everyAttemptHasRow
  let allRead = everyAttemptHasRow
  let allWrite = everyAttemptHasRow
  let sumInput = 0
  let sumCached = 0
  let sumOutput = 0
  let sumRead = 0
  let sumWrite = 0
  // Whether any displayable client event reported each partition. A partition
  // entirely absent from client events may be backfilled from summed gateway
  // usage below; a partially reported partition is never mixed with gateway
  // values.
  let anyClientInput = false
  let anyClientCached = false
  let anyClientOutput = false
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    for (const e of events) {
      if (!isDisplayableTurnUsage(e, events.length)) {
        allInput = allCached = allOutput = allRead = allWrite = false
        continue
      }
      if (e.input !== undefined) { sumInput += e.input; anyClientInput = true }
      else allInput = false
      if (e.cached !== undefined) { sumCached += e.cached; anyClientCached = true }
      else allCached = false
      if (e.output !== undefined) { sumOutput += e.output; anyClientOutput = true }
      else allOutput = false
      if (e.read !== undefined) sumRead += e.read
      else allRead = false
      if (e.write !== undefined) sumWrite += e.write
      else allWrite = false
    }
  }

  // Gateway fallback: a usage partition the client never reported anywhere in
  // the run is filled from the summed successful gateway completions for the
  // attempts that measured it. Client-reported partitions always win —
  // including an explicit zero — and a partition partially reported by clients
  // is never mixed with gateway sums. Fallback is per-attempt, so a run with
  // no client rows at all still resolves its gateway-only partitions.
  let sumGatewayInput = 0
  let sumGatewayOutput = 0
  let sumGatewayCached = 0
  let anyGatewayInput = false
  let anyGatewayOutput = false
  let anyGatewayCached = false
  for (const a of attemptRows) {
    const evidence = gatewayByExecution.get(a.execution_id)
    if (!evidence) continue
    sumGatewayInput += evidence.usage.input
    sumGatewayOutput += evidence.usage.output
    sumGatewayCached += evidence.usage.cached
    if (evidence.measured.input) anyGatewayInput = true
    if (evidence.measured.output) anyGatewayOutput = true
    if (evidence.measured.cached) anyGatewayCached = true
  }
  if (!anyClientInput && anyGatewayInput) {
    // Gateway `usage.input` is the full measured input and already includes
    // the cached portion, so the client-shaped input_tokens partition is the
    // uncached remainder; subtracting a client-reported cached partition is
    // avoided because an unrelated client cache total cannot be derived from
    // the gateway measurements.
    sumInput = Math.max(sumGatewayInput - sumGatewayCached, 0)
    allInput = true
  }
  if (!anyClientCached && anyGatewayCached) {
    sumCached = sumGatewayCached
    allCached = true
  }
  if (!anyClientOutput && anyGatewayOutput) {
    sumOutput = sumGatewayOutput
    allOutput = true
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
  // Shared approximate rate. `readTaskTps` aggregates every done attempt that
  // carries a measurable speed sample, so an attempt without observable
  // timing omits only its own contribution instead of hiding the run's speed.
  // There is no second metric.
  if (taskTps) {
    usage.generation_ms = taskTps.durationMs
    usage.output_tps = taskTps.tps
  }

  // --- Cost projection --------------------------------------------------
  // Price every displayable event in its own attempt with that attempt's
  // captured dispatch snapshot. `reference_cost_usd` is exposed whenever the
  // observed partitions are fully priced — so a scope-less partial snapshot
  // keeps its fully priced observed reference cost — while
  // `reference_cost_complete` stays false unless every attempt/event was
  // covered by trusted additive usage with complete partitions. A partially
  // priced sum is never exposed.
  let referenceCostUsd = 0
  let costTrustComplete = attemptRows.length > 0
  let costFullyPriced = attemptRows.length > 0
  for (const a of attemptRows) {
    const events = eventsByExecution.get(a.execution_id) ?? []
    const dispatch = dispatchByExecution.get(a.execution_id)
    if (events.length === 0 || !dispatch) {
      costTrustComplete = false
      costFullyPriced = false
      continue
    }
    for (const e of events) {
      if (!isDisplayableTurnUsage(e, events.length)) {
        costTrustComplete = false
        costFullyPriced = false
        continue
      }
      if (e.trust !== 'additive') costTrustComplete = false
      if (e.input === undefined || e.cached === undefined || e.output === undefined) {
        costTrustComplete = false
        costFullyPriced = false
        continue
      }
      const { cost, fullyPriced } = priceEvent(e, dispatch)
      if (!fullyPriced) {
        costTrustComplete = false
        costFullyPriced = false
      }
      referenceCostUsd += cost
    }
  }
  if (costFullyPriced) {
    usage.reference_cost_usd = referenceCostUsd
    usage.reference_cost_basis = 'catalog_reference'
  }
  usage.reference_cost_complete = costTrustComplete && costFullyPriced

  // --- Recorded identity ------------------------------------------------
  // Internal display identity, independent of the strict resolved snapshot.
  // A persisted dispatch row is authoritative; when no attempt recorded both
  // fields, only a successfully attributed gateway completion may supply the
  // pair, and only for an exact `<provider>/<model>` public model. Requested
  // policy/profile text is never consulted.
  let recorded: TaskRecordedModelIdentity | undefined
  for (let i = dispatchRows.length - 1; i >= 0; i--) {
    const row = dispatchRows[i]
    if (isNonBlank(row.provider) && isNonBlank(row.model)) {
      recorded = { provider: row.provider.trim(), model: row.model.trim() }
      break
    }
  }
  if (!recorded) {
    let latestEventId = -1
    for (const a of attemptRows) {
      const identity = gatewayByExecution.get(a.execution_id)?.identity
      if (identity !== undefined && identity.eventId > latestEventId) {
        latestEventId = identity.eventId
        recorded = { provider: identity.provider, model: identity.model }
      }
    }
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

  return { resolved, recorded, usage }
}

function toResolvedDispatch(row: AttemptDispatchRow): TaskResolvedDispatch | undefined {
  const speed = toSpeed(row)
  const pricing = toPricing(row)
  if (!speed || !pricing) return undefined
  // All identity / speed / intelligence / pricing fields must form a full,
  // schema-valid snapshot; otherwise the dispatch is treated as historical and
  // incomplete and is omitted. Only a NULL requested_agent_runtime is rejected
  // (an incomplete historical row); '' stays valid as automatic mode.
  if (
    row.requested_agent_runtime === null
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
  // Only a legal persisted reasoning-effort level is projected back into run
  // metadata. NULL (legacy rows) or any unknown value is omitted rather than invented.
  const reasoningEffort = toReasoningEffort(row.reasoning_effort)
  if (reasoningEffort) resolved.reasoningEffort = reasoningEffort
  // Explicit false must stay distinct from an absent preference, so only 1/0
  // are projected; NULL (legacy rows) and unknown values are omitted.
  if (row.fast === 1) resolved.fast = true
  else if (row.fast === 0) resolved.fast = false
  // Automatic attempts carry an optional routing decision. A missing, NULL,
  // malformed, incomplete, or tampered auto_routing payload is omitted without
  // invalidating the otherwise complete resolved dispatch.
  const autoRouting = parseAutoRoutingDecision(row.auto_routing)
  if (autoRouting) resolved.auto_routing = autoRouting
  return resolved
}

/**
 * Project a persisted reasoning-effort column back into run metadata only when it
 * is one of the legal ReasoningEffort values. NULL (legacy rows that predate the
 * column) and any other/unknown value are omitted; a historical reasoning-effort
 * level is never invented.
 */
function toReasoningEffort(raw: string | null): ReasoningEffort | undefined {
  return isReasoningEffort(raw) ? raw : undefined
}

function toSpeed(row: AttemptDispatchRow): TaskResolvedSpeed | undefined {
  if (
    row.speed_effective_tps == null
    || !Number.isFinite(row.speed_effective_tps)
    || row.speed_effective_tps < 0
    || row.speed_source == null
    || (row.speed_source !== 'local_31d' && row.speed_source !== 'provider_override' && row.speed_source !== 'catalog_default' && row.speed_source !== 'free_supply_floor' && row.speed_source !== 'cooldown')
    || row.speed_sample_count == null
    || !Number.isInteger(row.speed_sample_count)
    || row.speed_sample_count < 0
    || row.speed_expected_tps_met == null
    || (row.speed_expected_tps_met !== 0 && row.speed_expected_tps_met !== 1)
  ) return undefined
  const speed: TaskResolvedSpeed = {
    effective_tps: row.speed_effective_tps,
    source: row.speed_source,
    sample_count: row.speed_sample_count,
    expected_tps_met: row.speed_expected_tps_met === 1,
  }
  if (row.speed_checked_at) speed.checked_at = row.speed_checked_at
  if (row.speed_degradation_reason) speed.degradation_reason = row.speed_degradation_reason
  return speed
}

function toPricing(row: AttemptDispatchRow): TaskReferencePricing | undefined {
  const prices: (number | null)[] = [
    row.reference_pricing_input,
    row.reference_pricing_output,
    row.reference_pricing_cache,
    row.reference_pricing_cache_write,
  ]
  const hasPrice = prices.some((value) => value != null)
  const hasSource = Boolean(row.reference_pricing_source || row.reference_pricing_checked_at)
  if (!hasPrice && !hasSource) return undefined
  for (const v of prices) {
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return undefined
  }
  const pricing: TaskReferencePricing = {}
  if (row.reference_pricing_input != null) pricing.input_usd_per_million = row.reference_pricing_input
  if (row.reference_pricing_output != null) pricing.output_usd_per_million = row.reference_pricing_output
  if (row.reference_pricing_cache != null) pricing.cached_input_usd_per_million = row.reference_pricing_cache
  if (row.reference_pricing_cache_write != null) pricing.cache_write_input_usd_per_million = row.reference_pricing_cache_write
  if (row.reference_pricing_source) pricing.source = row.reference_pricing_source
  if (row.reference_pricing_checked_at) pricing.checked_at = row.reference_pricing_checked_at
  return pricing
}

/** The exact privacy-safe TaskAutoRoutingDecision DTO key set. */
const AUTO_ROUTING_DECISION_KEYS: ReadonlySet<string> = new Set([
  'snapshot_id',
  'selected_rank',
  'supply_class',
  'quota_state',
  'quota_coverage_complete',
  'reference_output_usd_per_million',
  'routing_output_usd_per_million',
  'effective_cap_usd_per_million',
  'score',
  'reasons',
])

/**
 * Type guard for a complete, schema-safe TaskAutoRoutingDecision parsed from
 * JSON. Accepts only the exact DTO key set with exact boolean / finite number /
 * string / string-array field types and the allowed supply_class / quota_state
 * enums, so arbitrary JSON (credentials, domains, raw provider errors) can
 * never be mistaken for or re-exposed as a routing decision.
 */
function isAutoRoutingDecision(record: Record<string, unknown>): record is TaskAutoRoutingDecision & Record<string, unknown> {
  const keys = Object.keys(record)
  if (keys.length !== AUTO_ROUTING_DECISION_KEYS.size + (record.scoring === undefined ? 0 : 1)) return false
  for (const key of keys) {
    if (key !== 'scoring' && !AUTO_ROUTING_DECISION_KEYS.has(key)) return false
  }
  if (record.scoring !== undefined) {
    const factors = record.scoring
    if (typeof factors !== 'object' || factors === null || Array.isArray(factors)) return false
    const values = factors as Record<string, unknown>
    if (Object.keys(values).length !== 5 || values.version !== 'normalized-v1') return false
    for (const key of ['price', 'speed', 'quota', 'intelligence']) {
      const value = values[key]
      if (!isFiniteNumber(value) || value < 0 || value > 1) return false
    }
  }
  return (
    typeof record.snapshot_id === 'string'
    && isFiniteNumber(record.selected_rank)
    && (record.supply_class === 'confirmed_free' || record.supply_class === 'standard')
    && (record.quota_state === 'abundant' || record.quota_state === 'sufficient'
      || record.quota_state === 'insufficient' || record.quota_state === 'exhausted')
    && typeof record.quota_coverage_complete === 'boolean'
    && isFiniteNumber(record.reference_output_usd_per_million)
    && isFiniteNumber(record.routing_output_usd_per_million)
    && isFiniteNumber(record.effective_cap_usd_per_million)
    && isFiniteNumber(record.score)
    && isStringArray(record.reasons)
  )
}

/**
 * Re-project a persisted auto_routing JSON payload into the privacy-safe
 * TaskAutoRoutingDecision DTO. NULL/absent, malformed, incomplete, and
 * extra-field payloads return undefined and are omitted from the resolved
 * dispatch, which otherwise stays complete. The re-projected object is built
 * field by field so no arbitrary JSON field is ever exposed.
 */
function parseAutoRoutingDecision(raw: string | null): TaskAutoRoutingDecision | undefined {
  if (raw === null || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (!isAutoRoutingDecision(record)) return undefined
  return {
    snapshot_id: record.snapshot_id,
    selected_rank: record.selected_rank,
    supply_class: record.supply_class,
    quota_state: record.quota_state,
    quota_coverage_complete: record.quota_coverage_complete,
    reference_output_usd_per_million: record.reference_output_usd_per_million,
    routing_output_usd_per_million: record.routing_output_usd_per_million,
    effective_cap_usd_per_million: record.effective_cap_usd_per_million,
    score: record.score,
    ...(record.scoring === undefined ? {} : { scoring: { ...record.scoring } }),
    reasons: [...record.reasons],
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * A single turn_usage record with presence semantics. `trust` is 'additive'
 * only when token_scope === 'agent_turn' (the fully trusted agent-turn
 * contract), 'unscoped' when the record carries no token_scope at all (a
 * partial displayable snapshot), and 'excluded' when it carries an explicit
 * cumulative/foreign scope or is malformed. `cached` is the normalized cached
 * total (full cached when present, otherwise read+creation when both splits are
 * valid).
 */
interface TurnUsageEvent {
  trust: 'additive' | 'unscoped' | 'excluded'
  input?: number
  cached?: number
  read?: number
  write?: number
  output?: number
}

const EXCLUDED_TURN_EVENT: TurnUsageEvent = { trust: 'excluded' }

/**
 * A persisted row contributes to the projected usage only when it is either
 * fully trusted additive usage, or the SINGLE scope-less snapshot recorded for
 * its execution/attempt. Every other row — an explicit cumulative/foreign
 * scope, a malformed row, or one of several unscoped rows — is excluded, so
 * unscoped usage is never summed into a fabricated total.
 */
function isDisplayableTurnUsage(event: TurnUsageEvent, eventCount: number): boolean {
  if (event.trust === 'additive') return true
  return event.trust === 'unscoped' && eventCount === 1
}

/**
 * Read every persisted turn_usage row for one execution, ordered by seq. A row
 * whose JSON or scope is invalid is kept as an excluded record so it can force
 * coverage to incomplete rather than be silently dropped.
 */
function readExecutionEvents(executionId: string, deps: TaskRunMetadataDeps): TurnUsageEvent[] {
  const rows = deps.store.query<{ data: string | null }>(
    `SELECT data FROM events WHERE execution_id = ? AND type = 'turn_usage' ORDER BY seq ASC`,
    executionId,
  )
  return rows.map((row) => parseTurnUsage(row.data))
}

function parseTurnUsage(value: string | null): TurnUsageEvent {
  if (value === null) return EXCLUDED_TURN_EVENT
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return EXCLUDED_TURN_EVENT
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EXCLUDED_TURN_EVENT
  const rec = parsed as Record<string, unknown>

  const trust = turnUsageTrust(rec)
  if (trust === 'excluded') return EXCLUDED_TURN_EVENT

  const input = readNonNegativeInteger(rec.input_tokens)
  const fullCached = readNonNegativeInteger(rec.cached_input_tokens)
  const readSplit = readNonNegativeInteger(rec.cache_read_input_tokens)
  const writeSplit = readNonNegativeInteger(rec.cache_creation_input_tokens)
  const output = readNonNegativeInteger(rec.output_tokens)

  // Normalized cached total: full cached when present, otherwise the sum of
  // whichever read/creation splits are defined (a lone split still counts).
  // The full cached value is never added on top of the splits.
  let cached: number | undefined
  if (fullCached !== undefined) cached = fullCached
  else if (readSplit !== undefined || writeSplit !== undefined) cached = (readSplit ?? 0) + (writeSplit ?? 0)

  return {
    trust,
    input,
    cached,
    read: readSplit,
    write: writeSplit,
    output,
  }
}

/**
 * Classify a persisted turn_usage record's provenance. Only the exact
 * 'agent_turn' scope is trusted additive usage. A record with no scope at all
 * (absent, null, or empty string) is an unscoped partial snapshot. Any other
 * explicit scope — including cumulative scopes such as
 * 'agent_turn_cumulative' — is excluded and never contributes.
 */
function turnUsageTrust(rec: Record<string, unknown>): TurnUsageEvent['trust'] {
  const scope = rec.token_scope
  if (scope === 'agent_turn') return 'additive'
  if (scope === undefined || scope === null || scope === '') return 'unscoped'
  return 'excluded'
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
 * Price a single displayable event with the dispatch snapshot captured for its
 * own execution attempt. A valid zero component needs no rate; a positive
 * component without a finite nonnegative rate makes the result not fully
 * priced. With a creation split, price creation at the cache_write rate and the
 * (cached - creation) remainder at the generic cache rate; the full cached
 * partition is never added on top of the splits. Without a creation split,
 * price the full cached partition at the generic cache rate.
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
