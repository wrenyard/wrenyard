import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, initDb } from '../lib/db/connection.mts'
import { readTaskRunMetadata } from '../lib/core/task/run-metadata.mts'

const TS = '2026-01-01T00:00:00.000Z'

function withDb(fn: (db: ReturnType<typeof initDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-task-run-metadata-'))
  const dbPath = join(dir, 'wrenyard.db')
  const db = initDb(dbPath)
  try {
    fn(db)
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedTask(db: ReturnType<typeof initDb>, taskRunId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, template, status, retry_policy, created_at, updated_at)
     VALUES (?, 'task', 'done', 'side-effects', ?, ?)`,
  ).run(taskRunId, TS, TS)
}

function seedExecution(
  db: ReturnType<typeof initDb>,
  executionId: string,
  taskRunId: string,
): void {
  db.prepare(
    `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at, requested_agent_runtime)
     VALUES (?, ?, 'default', 'readonly', '/tmp', 'p', 'done', ?, ?, 'agent')`,
  ).run(executionId, taskRunId, TS, TS)
}

function seedTurnUsage(
  db: ReturnType<typeof initDb>,
  executionId: string,
  taskRunId: string,
  data: Record<string, unknown> = {},
  seq = 0,
): void {
  // Ordinary fixtures are explicitly trusted agent_turn scopes; each test may
  // override or delete fields and pass invalid unknown values.
  const full = {
    token_scope: 'agent_turn',
    duration_scope: 'agent_turn',
    tps_contract: 'agent_turn_v1',
    duration_ms: 1000,
    ...data,
  }
  db.prepare(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
  ).run(executionId, taskRunId, seq, TS, JSON.stringify(full), TS)
}

function seedTelemetry(
  db: ReturnType<typeof initDb>,
  taskRunId: string,
  opts: { usage_event_count?: number; agent_turn_ms?: number; tps_complete?: number; completeness?: string } = {},
): void {
  db.prepare(
    `INSERT INTO task_run_telemetry (task_run_id, usage_event_count, agent_turn_ms, tps_complete, completeness, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskRunId,
    opts.usage_event_count ?? 1,
    opts.agent_turn_ms ?? 1000,
    opts.tps_complete ?? 1,
    opts.completeness ?? 'complete',
    TS,
    TS,
  )
}

interface DispatchFields {
  requested_agent_runtime?: string
  profile?: string
  client?: string
  provider?: string
  model?: string
  model_id?: string
  mode?: string
  protocol?: string
  speed_effective_tps?: number
  speed_source?: string
  speed_sample_count?: number
  speed_checked_at?: string
  speed_expected_tps_met?: number
  speed_degradation_reason?: string
  intelligence?: string
  reference_pricing_input?: number | null
  reference_pricing_output?: number | null
  reference_pricing_cache?: number | null
  reference_pricing_cache_write?: number | null
  reference_pricing_source?: string
  reference_pricing_checked_at?: string
}

function seedDispatch(
  db: ReturnType<typeof initDb>,
  executionId: string,
  taskRunId: string,
  o: DispatchFields,
): void {
  db.prepare(
    `INSERT INTO task_run_attempt_dispatch
      (execution_id, task_run_id, requested_agent_runtime, profile, client, provider, model, model_id, mode, protocol,
       speed_effective_tps, speed_source, speed_sample_count, speed_checked_at, speed_expected_tps_met, speed_degradation_reason,
       intelligence, reference_pricing_input, reference_pricing_output, reference_pricing_cache, reference_pricing_cache_write,
       reference_pricing_source, reference_pricing_checked_at, created_at, updated_at)
     VALUES (@execution_id,@task_run_id,@requested_agent_runtime,@profile,@client,@provider,@model,@model_id,@mode,@protocol,
       @speed_effective_tps,@speed_source,@speed_sample_count,@speed_checked_at,@speed_expected_tps_met,@speed_degradation_reason,
       @intelligence,@reference_pricing_input,@reference_pricing_output,@reference_pricing_cache,@reference_pricing_cache_write,
       @reference_pricing_source,@reference_pricing_checked_at,@created_at,@updated_at)`,
  ).run({
    execution_id: executionId,
    task_run_id: taskRunId,
    requested_agent_runtime: o.requested_agent_runtime ?? 'agent',
    profile: o.profile ?? 'default',
    client: o.client ?? 'claude',
    provider: o.provider ?? 'anthropic',
    model: o.model ?? 'sonnet',
    model_id: o.model_id ?? 'claude-sonnet-4',
    mode: o.mode ?? 'native',
    protocol: o.protocol ?? null,
    speed_effective_tps: o.speed_effective_tps ?? 30,
    speed_source: o.speed_source ?? 'local_31d',
    speed_sample_count: o.speed_sample_count ?? 10,
    speed_checked_at: o.speed_checked_at ?? TS,
    speed_expected_tps_met: o.speed_expected_tps_met ?? 1,
    speed_degradation_reason: o.speed_degradation_reason ?? null,
    intelligence: o.intelligence ?? 'mid',
    reference_pricing_input: o.reference_pricing_input ?? null,
    reference_pricing_output: o.reference_pricing_output ?? null,
    reference_pricing_cache: o.reference_pricing_cache ?? null,
    reference_pricing_cache_write: o.reference_pricing_cache_write ?? null,
    reference_pricing_source: o.reference_pricing_source ?? 'catalog',
    reference_pricing_checked_at: o.reference_pricing_checked_at ?? TS,
    created_at: TS,
    updated_at: TS,
  })
}

function fullPricedDispatch(
  executionId: string,
  taskRunId: string,
  rates: { input: number; output: number; cache: number; cache_write: number },
): DispatchFields {
  return {
    requested_agent_runtime: 'agent',
    profile: 'default',
    client: 'claude',
    provider: 'anthropic',
    model: 'sonnet',
    model_id: 'claude-sonnet-4',
    mode: 'native',
    speed_effective_tps: 30,
    speed_source: 'local_31d',
    speed_sample_count: 10,
    speed_checked_at: TS,
    speed_expected_tps_met: 1,
    intelligence: 'mid',
    reference_pricing_input: rates.input,
    reference_pricing_output: rates.output,
    reference_pricing_cache: rates.cache,
    reference_pricing_cache_write: rates.cache_write,
    reference_pricing_source: 'catalog',
    reference_pricing_checked_at: TS,
  }
}

function setDispatchAutoRouting(db: ReturnType<typeof initDb>, executionId: string, value: string | null): void {
  db.prepare(
    `UPDATE task_run_attempt_dispatch SET auto_routing = ? WHERE execution_id = ?`,
  ).run(value, executionId)
}

test('two unequal attempts with different prices sum to exact USD', () => {
  withDb((db) => {
    const task = 'task-sum'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedExecution(db, 'e2', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 2000 })
    seedTurnUsage(db, 'e2', task, { input_tokens: 3000, cached_input_tokens: 1500, output_tokens: 1000 })
    seedTelemetry(db, task, { usage_event_count: 2, agent_turn_ms: 1000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    seedDispatch(db, 'e2', task, fullPricedDispatch('e2', task, { input: 2.0, output: 4.0, cache: 1.0, cache_write: 0.5 }))

    const { usage, resolved } = readTaskRunMetadata(task)

    // 1000*1 + 500*0.5 + 2000*2 = 5250 ; 3000*2 + 1500*1 + 1000*4 = 11500
    assert.ok(Math.abs((usage.reference_cost_usd ?? -1) - 0.01675) < 1e-12)
    assert.equal(usage.reference_cost_complete, true)
    assert.equal(usage.reference_cost_basis, 'catalog_reference')
    assert.equal(usage.attempt_count, 2)
    assert.ok(resolved)
    assert.equal(resolved!.mode, 'native')
    assert.equal(resolved!.intelligence, 'mid')
  })
})

test('a missing attempt snapshot makes reference_cost_complete false', () => {
  withDb((db) => {
    const task = 'task-missing-snapshot'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedExecution(db, 'e2', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 100, output_tokens: 50 })
    seedTurnUsage(db, 'e2', task, { input_tokens: 100, output_tokens: 50 })
    seedTelemetry(db, task, { usage_event_count: 2 })
    // Only e1 has a dispatch snapshot; e2 has usage but no snapshot.
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.reference_cost_complete, false)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.attempt_count, 2)
  })
})

test('cached full partition and read/write splits do not double-bill', () => {
  withDb((db) => {
    const task = 'task-cache'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, {
      input_tokens: 10,
      cached_input_tokens: 100,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 40,
      output_tokens: 5,
    })
    seedTelemetry(db, task, { usage_event_count: 1 })
    // cache=1.0, cache_write=0.5, input=1.0, output=2.0 (per million).
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 1.0, cache_write: 0.5 }))

    const { usage } = readTaskRunMetadata(task)

    // Creation (40) is priced at the cache_write rate and the remainder
    // (cached - creation = 60) at the generic cache rate; the full cached 100
    // is never added on top of the splits. input 10 + output 10 + creation 20 +
    // remainder 60 = 100 per million = 0.0001.
    assert.ok(Math.abs((usage.reference_cost_usd ?? -1) - 0.0001) < 1e-12)
    assert.equal(usage.reference_cost_complete, true)
  })
})

test('all known-zero usage emits $0 and complete', () => {
  withDb((db) => {
    const task = 'task-zero'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    })
    seedTelemetry(db, task, { usage_event_count: 1, agent_turn_ms: 1000, tps_complete: 1 })
    // dispatch carries only source/checked_at; no numeric rates are required
    // because every token component is an explicit zero.
    seedDispatch(db, 'e1', task, {
      requested_agent_runtime: 'agent',
      profile: 'default',
      client: 'claude',
      provider: 'anthropic',
      model: 'sonnet',
      model_id: 'claude-sonnet-4',
      mode: 'native',
      speed_effective_tps: 30,
      speed_source: 'local_31d',
      speed_sample_count: 10,
      speed_checked_at: TS,
      speed_expected_tps_met: 1,
      intelligence: 'mid',
      reference_pricing_input: null,
      reference_pricing_output: null,
      reference_pricing_cache: null,
      reference_pricing_cache_write: null,
      reference_pricing_source: 'catalog',
      reference_pricing_checked_at: TS,
    })

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.total_tokens, 0)
    assert.equal(usage.reference_cost_usd, 0)
    assert.equal(usage.reference_cost_complete, true)
    assert.equal(usage.reference_cost_basis, 'catalog_reference')
    assert.equal(usage.output_tps, 0)
    assert.equal(usage.tps_contract, 'agent_turn_v1')
    assert.equal(usage.agent_turn_ms, 1000)
  })
})

test('explicit input/output but missing cached stays partial and cost incomplete', () => {
  withDb((db) => {
    const task = 'task-partial'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    // No cached/read/write partitions present at all.
    seedTurnUsage(db, 'e1', task, { input_tokens: 100, output_tokens: 50 })
    seedTelemetry(db, task, { usage_event_count: 1, agent_turn_ms: 1000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.completeness, 'partial')
    assert.equal(usage.input_tokens, 100)
    assert.equal(usage.output_tokens, 50)
    assert.equal(usage.cached_input_tokens, undefined)
    assert.equal(usage.cache_read_input_tokens, undefined)
    assert.equal(usage.cache_creation_input_tokens, undefined)
    assert.equal(usage.total_tokens, undefined)
    // Present partitions alone are not claimed to be fully priced.
    assert.equal(usage.reference_cost_complete, false)
    assert.equal(usage.reference_cost_usd, undefined)
  })
})

test('empty turn_usage event with exact scopes but no tokens is unavailable', () => {
  withDb((db) => {
    const task = 'task-empty'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    // Exact agent_turn scopes/duration but no token fields.
    seedTurnUsage(db, 'e1', task, {})
    seedTelemetry(db, task, { usage_event_count: 0, agent_turn_ms: 1000, tps_complete: 1 })

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.completeness, 'unavailable')
    assert.equal(usage.input_tokens, undefined)
    assert.equal(usage.output_tokens, undefined)
    assert.equal(usage.cached_input_tokens, undefined)
    assert.equal(usage.total_tokens, undefined)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.reference_cost_complete, false)
    assert.equal(usage.agent_turn_ms, undefined)
    assert.equal(usage.output_tps, undefined)
    assert.equal(usage.tps_contract, undefined)
  })
})

test('output-only trusted event emits output and TPS but not input/cached/cost', () => {
  withDb((db) => {
    const task = 'task-output-only'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    // output valid, input/cache absent.
    seedTurnUsage(db, 'e1', task, { output_tokens: 50 })
    seedTelemetry(db, task, { usage_event_count: 1, agent_turn_ms: 1000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.completeness, 'partial')
    assert.equal(usage.output_tokens, 50)
    assert.equal(usage.input_tokens, undefined)
    assert.equal(usage.cached_input_tokens, undefined)
    assert.equal(usage.total_tokens, undefined)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.reference_cost_complete, false)
    // TPS trusted independently of input/cache/cost completeness.
    assert.equal(usage.agent_turn_ms, 1000)
    assert.ok(Math.abs((usage.output_tps ?? -1) - 50) < 1e-12)
    assert.equal(usage.tps_contract, 'agent_turn_v1')
  })
})

test('mixed two-event attempt sums output/cached but omits input/cost, keeps TPS', () => {
  withDb((db) => {
    const task = 'task-mixed'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 }, 0)
    seedTurnUsage(db, 'e1', task, { cached_input_tokens: 30, output_tokens: 40 }, 1)
    seedTelemetry(db, task, { usage_event_count: 2, agent_turn_ms: 2000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.input_tokens, undefined)
    assert.equal(usage.cached_input_tokens, 40)
    assert.equal(usage.output_tokens, 60)
    assert.equal(usage.total_tokens, undefined)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.reference_cost_complete, false)
    // Weighted TPS still present across both events.
    assert.equal(usage.agent_turn_ms, 2000)
    assert.ok(Math.abs((usage.output_tps ?? -1) - 30) < 1e-12)
    assert.equal(usage.tps_contract, 'agent_turn_v1')
  })
})

test('cumulative/wrong-scope event is not summed and does not upgrade completeness', () => {
  withDb((db) => {
    const task = 'task-cumulative'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { token_scope: 'agent_turn_cumulative', input_tokens: 999999, cached_input_tokens: 999999, output_tokens: 999999 }, 0)
    seedTurnUsage(db, 'e1', task, { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 }, 1)
    seedTelemetry(db, task, { usage_event_count: 1, agent_turn_ms: 1000, tps_complete: 0 })

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.completeness, 'partial')
    assert.equal(usage.input_tokens, undefined)
    assert.equal(usage.cached_input_tokens, undefined)
    assert.equal(usage.output_tokens, undefined)
    assert.equal(usage.total_tokens, undefined)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.reference_cost_complete, false)
    assert.equal(usage.agent_turn_ms, undefined)
    assert.equal(usage.output_tps, undefined)
    assert.equal(usage.tps_contract, undefined)
  })
})

test('invalid numeric token stays undefined, cost incomplete, output/TPS visible', () => {
  withDb((db) => {
    const task = 'task-invalid-num'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 'bad', cached_input_tokens: 100, output_tokens: 50 })
    seedTelemetry(db, task, { usage_event_count: 1, agent_turn_ms: 1000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.completeness, 'partial')
    assert.equal(usage.input_tokens, undefined)
    assert.equal(usage.cached_input_tokens, 100)
    assert.equal(usage.output_tokens, 50)
    assert.equal(usage.reference_cost_usd, undefined)
    assert.equal(usage.reference_cost_complete, false)
    // output/TPS remain visible for the trusted agent_turn_v1 contract.
    assert.equal(usage.agent_turn_ms, 1000)
    assert.ok(Math.abs((usage.output_tps ?? -1) - 50) < 1e-12)
    assert.equal(usage.tps_contract, 'agent_turn_v1')
  })
})

test('executions primary key is aliased to execution_id and joined', () => {
  withDb((db) => {
    const task = 'task-alias'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedExecution(db, 'e2', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20 })
    seedTurnUsage(db, 'e2', task, { input_tokens: 30, cached_input_tokens: 0, output_tokens: 40 })
    seedTelemetry(db, task, { usage_event_count: 2, agent_turn_ms: 1000, tps_complete: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    seedDispatch(db, 'e2', task, fullPricedDispatch('e2', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))

    const { usage } = readTaskRunMetadata(task)

    assert.equal(usage.attempt_count, 2)
    assert.equal(usage.input_tokens, 40)
    assert.equal(usage.output_tokens, 60)
    assert.equal(usage.reference_cost_complete, true)
  })
})

test('valid auto_routing payload reprojects onto the resolved automatic dispatch', () => {
  withDb((db) => {
    const task = 'task-ar-valid'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    const decision = {
      snapshot_id: 'snap-1',
      selected_rank: 0,
      supply_class: 'standard',
      quota_tier: 'healthy',
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 3,
      routing_output_usd_per_million: 2,
      effective_cap_usd_per_million: 4,
      score: 0.95,
      reasons: ['lowest reference price', 'healthy quota'],
    }
    setDispatchAutoRouting(db, 'e1', JSON.stringify(decision))

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'resolved dispatch must remain available')
    assert.equal(resolved!.model, 'sonnet')
    assert.equal(resolved!.mode, 'native')
    assert.deepEqual(resolved!.auto_routing, decision, 'valid decision must re-project exactly')
    assert.equal(usage.attempt_count, 1)
  })
})

test('NULL auto_routing behaves exactly like a legacy explicit dispatch', () => {
  withDb((db) => {
    const task = 'task-ar-null'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    setDispatchAutoRouting(db, 'e1', null)

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'resolved dispatch must stay available')
    assert.equal(resolved!.auto_routing, undefined, 'NULL payload must be omitted')
    assert.equal(resolved!.model, 'sonnet')
    assert.equal(usage.attempt_count, 1)
  })
})

test('malformed auto_routing JSON is omitted without invalidating the resolved dispatch', () => {
  withDb((db) => {
    const task = 'task-ar-malformed'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    setDispatchAutoRouting(db, 'e1', '{not-json')

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'malformed payload must not invalidate the resolved dispatch')
    assert.equal(resolved!.auto_routing, undefined, 'malformed JSON must be omitted')
    assert.equal(resolved!.mode, 'native')
    assert.equal(usage.attempt_count, 1)
  })
})

test('incomplete auto_routing payload is omitted while resolved identity stays available', () => {
  withDb((db) => {
    const task = 'task-ar-incomplete'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    setDispatchAutoRouting(db, 'e1', JSON.stringify({ snapshot_id: 'snap-x', reasons: ['no other fields'] }))

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'incomplete payload must not invalidate the resolved dispatch')
    assert.equal(resolved!.auto_routing, undefined, 'incomplete JSON must be omitted')
    assert.equal(resolved!.model_id, 'claude-sonnet-4')
    assert.equal(usage.reference_cost_complete, true)
  })
})

test('extra-field auto_routing payload is omitted and never leaks arbitrary JSON', () => {
  withDb((db) => {
    const task = 'task-ar-extra'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    const smuggled = {
      snapshot_id: 'snap-t',
      selected_rank: 1,
      supply_class: 'confirmed_free',
      quota_tier: 'strained',
      quota_coverage_complete: false,
      quota_headroom_trusted: false,
      reference_output_usd_per_million: 5,
      routing_output_usd_per_million: 6,
      effective_cap_usd_per_million: 7,
      score: 0.5,
      reasons: ['only candidate'],
      injected_credential: 'sk-secret',
      raw_provider_error: 'authentication denied: user:pass@domain',
    }
    setDispatchAutoRouting(db, 'e1', JSON.stringify(smuggled))

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'tampered payload must not invalidate the resolved dispatch')
    assert.equal(resolved!.auto_routing, undefined, 'extra-field payload is not a schema-safe decision and must be omitted')
    const serialized = JSON.stringify(resolved)
    assert.equal(serialized.includes('sk-secret'), false, 'arbitrary JSON must never leak')
    assert.equal(serialized.includes('raw_provider_error'), false, 'provider error text must never leak')
    assert.equal(usage.attempt_count, 1)
  })
})

test('automatic dispatch persisted with requested_agent_runtime "" still resolves and keeps auto_routing', () => {
  withDb((db) => {
    const task = 'task-ar-auto-empty-runtime'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    // Automatic-mode persisted attempts legitimately carry '' requested_agent_runtime.
    seedDispatch(db, 'e1', task, {
      ...fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }),
      requested_agent_runtime: '',
    })
    const decision = {
      snapshot_id: 'snap-auto',
      selected_rank: 0,
      supply_class: 'standard',
      quota_tier: 'healthy',
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 3,
      routing_output_usd_per_million: 2,
      effective_cap_usd_per_million: 4,
      score: 0.95,
      reasons: ['lowest reference price'],
    }
    setDispatchAutoRouting(db, 'e1', JSON.stringify(decision))

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.ok(resolved, 'complete automatic row with empty requested_agent_runtime must resolve')
    assert.equal(resolved!.requested_agent_runtime, '')
    assert.equal(resolved!.model, 'sonnet')
    assert.equal(resolved!.mode, 'native')
    assert.deepEqual(resolved!.auto_routing, decision, 'valid automatic routing decision must round-trip')
    assert.equal(usage.attempt_count, 1)
  })
})

test('genuinely incomplete identity still omits resolved', () => {
  withDb((db) => {
    const task = 'task-incomplete-identity'
    seedTask(db, task)
    seedExecution(db, 'e1', task)
    seedTurnUsage(db, 'e1', task, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 })
    seedTelemetry(db, task, { usage_event_count: 1 })
    seedDispatch(db, 'e1', task, fullPricedDispatch('e1', task, { input: 1.0, output: 2.0, cache: 0.5, cache_write: 0.25 }))
    // Null out a required identity field; every other field stays complete.
    db.prepare('UPDATE task_run_attempt_dispatch SET client = NULL WHERE execution_id = ?').run('e1')

    const { usage, resolved } = readTaskRunMetadata(task)

    assert.equal(resolved, undefined, 'missing identity field must omit resolved')
    assert.equal(usage.attempt_count, 1)
  })
})
