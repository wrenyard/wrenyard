import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { query as dbQuery, run as dbRun } from '../../lib/db/connection.mts'
import { readStatsSummary, readTodayStats } from '../../lib/events/stats-query.mts'
import type { StatsSummaryResult } from '../../lib/protocol/methods/stats.mts'
import { parseMethodResult } from '../../lib/protocol/validate.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

// Format a Date using local year/month/day components, matching how the
// production stats query derives its local-day window (stats-query.mts).
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// Convert a YYYY-MM-DD local calendar key into an ISO timestamp at local noon.
// Local noon always maps back to that same local day, regardless of timezone.
function localNoon(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0).toISOString()
}

function seedDispatch(dayKey: string, count: number, executionId?: string, taskId?: string): void {
  const baseDate = new Date(localNoon(dayKey))
  const row = dbQuery<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const baseSeq = row[0].next_seq
  for (let i = 0; i < count; i++) {
    const ts = new Date(baseDate.getTime() + i * 1000)
    dbRun(
      `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
       VALUES (?, ?, ?, 'dispatch', ?, NULL, ?)`,
      executionId ?? null,
      taskId ?? null,
      baseSeq + i,
      ts.toISOString(),
      ts.toISOString(),
    )
  }
}

function seedTurnUsage(dayKey: string, inputTokens: number, outputTokens: number, executionId?: string, taskId?: string): void {
  const ts = new Date(localNoon(dayKey))
  const row = dbQuery<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const seq = row[0].next_seq
  dbRun(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId ?? null,
    taskId ?? null,
    seq,
    ts.toISOString(),
    JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens }),
    ts.toISOString(),
  )
}

function seedCachedTurnUsage(
  dayKey: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  executionId?: string,
  taskId?: string,
): void {
  const ts = new Date(localNoon(dayKey))
  const row = dbQuery<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const seq = row[0].next_seq
  dbRun(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId ?? null,
    taskId ?? null,
    seq,
    ts.toISOString(),
    JSON.stringify({
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
    }),
    ts.toISOString(),
  )
}

function seedExecution(id: string, profile: string, taskId: string): void {
  dbRun(
    `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, 'edit', '/tmp', 'prompt', 'done', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    id,
    taskId,
    profile,
  )
}

function seedTask(id: string, template: string, dayKey: string, status: string): void {
  const endedAt = localNoon(dayKey)
  dbRun(
    `INSERT INTO tasks (id, template, status, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', ?)`,
    id,
    template,
    status,
    endedAt,
  )
}

function seedTaskInterval(id: string, template: string, status: string, createdIso: string, endedIso: string | null): void {
  dbRun(
    `INSERT INTO tasks (id, template, status, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    template,
    status,
    createdIso,
    createdIso,
    endedIso,
  )
}

function seedTaskWithProject(id: string, template: string, status: string, createdIso: string, endedIso: string | null, project: string | null, definitionSource: string | null): void {
  dbRun(
    `INSERT INTO tasks (id, template, project, definition_source, status, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    template,
    project,
    definitionSource,
    status,
    createdIso,
    createdIso,
    endedIso,
  )
}

function seedExecutionResolved(id: string, profile: string, resolvedProfile: string | null, taskId: string): void {
  dbRun(
    `INSERT INTO executions (id, task_id, profile, resolved_profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'edit', '/tmp', 'prompt', 'done', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    id,
    taskId,
    profile,
    resolvedProfile,
  )
}

/**
 * Seeds a persisted task_run_attempt_dispatch snapshot for an execution so the
 * row surfaces a canonical provider/model/model_id identity in today/window
 * model rankings. `taskRunId` must be an existing tasks.id. `client` is accepted
 * only for coverage and is never part of the grouping key.
 */
function seedAttemptDispatch(
  executionId: string,
  taskRunId: string,
  provider: string,
  model: string,
  modelId: string,
  client = 'codebuddy',
): void {
  const fixedTs = '2024-01-01T00:00:00.000Z'
  dbRun(
    `INSERT INTO task_run_attempt_dispatch (
       execution_id, task_run_id, requested_agent_runtime, profile, client, provider,
       model, model_id, mode, protocol, intelligence,
       speed_effective_tps, speed_source, speed_sample_count, speed_checked_at,
       speed_expected_tps_met,
       reference_pricing_input, reference_pricing_output,
       reference_pricing_source, reference_pricing_checked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', NULL, 'mid', ?, ?, ?, ?, 1, ?, ?, 'catalog', ?, ?, ?)`,
    executionId,
    taskRunId,
    'forge/codebuddy',
    provider,
    client,
    provider,
    model,
    modelId,
    45, 'catalog_default', 7, fixedTs,
    0.2, 1.2, fixedTs, fixedTs, fixedTs,
  )
}

/**
 * Seeds a completed task run that carries a full modern
 * task_run_attempt_dispatch snapshot (optionally with a persisted
 * auto_routing decision), so the run surfaces a `resolved` dispatch in the
 * recent ledger.
 */
function seedResolvedDispatchRun(params: {
  taskRunId: string
  template: string
  createdIso: string
  endedIso: string
  executionId: string
  profile: string
  client: string
  provider: string
  model: string
  modelId: string
  autoRoutingJson?: string | null
}): void {
  seedTaskWithProject(
    params.taskRunId, params.template, 'done',
    params.createdIso, params.endedIso, null, 'builtin',
  )
  // The task_run_attempt_dispatch FK references executions(id), so seed the
  // parent execution row (linked to the task) before the dispatch insert.
  seedExecutionResolved(params.executionId, params.profile, params.profile, params.taskRunId)
  const fixedTs = '2024-01-01T00:00:00.000Z'
  dbRun(
    `INSERT INTO task_run_attempt_dispatch (
       execution_id, task_run_id, requested_agent_runtime, profile, client, provider,
       model, model_id, mode, protocol, intelligence,
       speed_effective_tps, speed_source, speed_sample_count, speed_checked_at,
       speed_expected_tps_met,
       reference_pricing_input, reference_pricing_output,
       reference_pricing_cache, reference_pricing_cache_write,
       reference_pricing_source, reference_pricing_checked_at,
       auto_routing, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', NULL, 'mid', ?, ?, ?, ?, 1, ?, ?, NULL, NULL, 'catalog', ?, ?, ?, ?)`,
    params.executionId,
    params.taskRunId,
    'forge/codebuddy',
    params.profile,
    params.client,
    params.provider,
    params.model,
    params.modelId,
    45, 'catalog_default', 7, fixedTs,
    0.2, 1.2, fixedTs,
    params.autoRoutingJson ?? null,
    fixedTs, fixedTs,
  )
}

function seedAliasOnlyLegacyRun(taskRunId: string, template: string, createdIso: string, endedIso: string, resolvedProfile: string): void {
  seedTaskWithProject(taskRunId, template, 'done', createdIso, endedIso, null, null)
  dbRun(
    `INSERT INTO executions (id, task_id, profile, resolved_profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'edit', '/tmp', 'prompt', 'done', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    `exec-${taskRunId}`,
    taskRunId,
    'policy-legacy',
    resolvedProfile,
  )
  dbRun(
    `UPDATE tasks SET execution_id = ? WHERE id = ?`,
    `exec-${taskRunId}`,
    taskRunId,
  )
}

function seedUsageWithDuration(
  dayKey: string,
  inputTokens: number,
  outputTokens: number,
  durationMs: number | null,
  durationScope: string | null,
  executionId?: string,
  taskId?: string,
  tokenScope: string | null = null,
  tpsContract: string | null = null,
): void {
  const ts = new Date(localNoon(dayKey))
  const row = dbQuery<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const seq = row[0].next_seq
  const data: Record<string, unknown> = { input_tokens: inputTokens, output_tokens: outputTokens }
  if (durationMs !== null) data.duration_ms = durationMs
  if (durationScope !== null) data.duration_scope = durationScope
  if (tokenScope !== null) data.token_scope = tokenScope
  if (tpsContract !== null) data.tps_contract = tpsContract
  dbRun(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId ?? null,
    taskId ?? null,
    seq,
    ts.toISOString(),
    JSON.stringify(data),
    ts.toISOString(),
  )
}

function validWindow(period: '24h' | '7d' | '1mo'): Record<string, unknown> {
  return {
    period,
    startAt: '2026-07-19T00:00:00.000Z',
    endAt: '2026-07-20T00:00:00.000Z',
    dispatchCount: 0,
    totalTokens: 0,
    byProfile: [],
    taskStats: { totalDurationMs: 0, byTask: [], builtinTotalDurationMs: 0, byBuiltinTask: [] },
  }
}

function minimalSummaryBase(): Record<string, unknown> {
  return {
    source: 'sqlite',
    today: {
      dayKey: '2026-07-19',
      startAt: '2026-07-19T00:00:00.000Z',
      endAt: '2026-07-20T00:00:00.000Z',
      dispatchCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      outcomes: { done: 0, failed: 0, cancelled: 0 },
    },
    byProfile: [],
    byTask: [],
    daily: [],
  }
}

describe('stats-query readStatsSummary', () => {
  it('returns empty result for empty database', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    const result = readStatsSummary({ days: 3, limit: 10 }, now)
    assert.equal(result.source, 'sqlite')
    assert.equal(result.today.dayKey, today)
    assert.equal(result.today.dispatchCount, 0)
    assert.equal(result.today.inputTokens, 0)
    assert.equal(result.today.outputTokens, 0)
    assert.equal(result.today.totalTokens, 0)
    assert.deepEqual(result.today.outcomes, { done: 0, failed: 0, cancelled: 0 })
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 0)
    assert.equal(result.totalTaskDurationMs, 0)
    const emptyByTaskDuration = result.byTaskDuration
    assert.ok(emptyByTaskDuration, 'expected byTaskDuration array for the empty database')
    assert.equal(emptyByTaskDuration.length, 0)
    assert.equal(result.daily.length, 3)
    for (const day of result.daily) {
      assert.equal(day.dispatchCount, 0)
      assert.equal(day.inputTokens, 0)
      assert.equal(day.outputTokens, 0)
      assert.equal(day.totalTokens, 0)
    }
    closeTestDb()
  })

  it('has a created_at-leading index on events for bounded range scans', () => {
    initTestDb()
    const indexes = dbQuery<{ name: string }>(`SELECT name FROM pragma_index_list('events') WHERE origin != 'pk'`)
    const found = indexes.some((idx) => {
      const cols = dbQuery<{ name: string; seqno: number }>(
        `SELECT name, seqno FROM pragma_index_info(?) ORDER BY seqno`,
        idx.name,
      )
      return cols.length > 0 && cols[0].name === 'created_at'
    })
    assert.ok(found, 'Expected a non-pk index with created_at as the leading column for bounded range scans')

    // Verify the query plan uses idx_event_created_at for the actual stats.summary events query shape
    // (type IN filter, created_at bounds, and LEFT JOINs to executions/tasks)
    const plan = dbQuery<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT e.type, e.data, e.created_at, ex.profile, COALESCE(t.template, ex_t.template) AS template
       FROM events e INDEXED BY idx_event_created_at
       LEFT JOIN executions ex ON e.execution_id = ex.id
       LEFT JOIN tasks t ON e.task_id = t.id
       LEFT JOIN tasks ex_t ON ex.task_id = ex_t.id
       WHERE e.type IN ('dispatch', 'turn_usage')
         AND e.created_at >= ? AND e.created_at < ?`,
      '2024-01-01T00:00:00.000Z',
      '2024-01-02T00:00:00.000Z',
    )
    const usesIndex = plan.some((row) => row.detail.includes('idx_event_created_at'))
    assert.ok(usesIndex, 'Expected EXPLAIN QUERY PLAN to show idx_event_created_at for bounded created_at range scan on the stats.summary events query shape')
    closeTestDb()
  })

  it('counts dispatch-only events', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedDispatch(today, 5)
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.today.dispatchCount, 5)
    // Dispatch-only events carry no canonical model snapshot, so they are
    // omitted from the model ranking (overall today totals still count them).
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'unknown')
    assert.equal(result.byTask[0].dispatchCount, 5)
    assert.equal(result.daily.length, 1)
    closeTestDb()
  })

  it('accumulates token usage from turn_usage events', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTurnUsage(today, 100, 50)
    seedTurnUsage(today, 200, 75)
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.today.inputTokens, 300)
    assert.equal(result.today.outputTokens, 125)
    assert.equal(result.today.totalTokens, 425)
    // turn_usage-only rows carry no canonical model snapshot → omitted.
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].inputTokens, 300)
    assert.equal(result.byTask[0].outputTokens, 125)
    assert.equal(result.byTask[0].totalTokens, 425)
    closeTestDb()
  })

  it('aggregates cached-input partitions exactly once into today, daily, profile, task, and window totals', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-cache', 'commit', today, 'done')
    seedExecution('exec-cache', 'cur-grok', 'task-cache')
    seedDispatch(today, 1, 'exec-cache', 'task-cache')
    // Two cached events: input=40+120=160 each → today input 320
    seedCachedTurnUsage(today, 40, 120, 60, 'exec-cache', 'task-cache')
    seedCachedTurnUsage(today, 40, 120, 60, 'exec-cache', 'task-cache')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    // today: full input = (40+120)+(40+120) = 320; output 120
    assert.equal(result.today.inputTokens, 320)
    assert.equal(result.today.outputTokens, 120)
    assert.equal(result.today.totalTokens, 440)
    // daily bucket matches today
    const todayBucket = result.daily.find((d) => d.dayKey === today)
    assert.ok(todayBucket)
    assert.equal(todayBucket.inputTokens, 320)
    assert.equal(todayBucket.totalTokens, 440)
    // model ranking: no canonical dispatch snapshot seeded → omitted today
    assert.equal(result.byProfile.length, 0)
    // task grouping
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].inputTokens, 320)
    assert.equal(result.byTask[0].totalTokens, 440)
    // window totals: all three windows include today
    for (const w of result.windows ?? []) {
      assert.equal(w.totalTokens, 440, `${w.period} must include cached input exactly once`)
    }
    closeTestDb()
  })

  it('keeps legacy input_tokens-only usage unchanged and never adds total_tokens', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-legacy', 'commit', today, 'done')
    seedExecution('exec-legacy', 'claude', 'task-legacy')
    seedDispatch(today, 1, 'exec-legacy', 'task-legacy')
    // Legacy event reports input_tokens and total_tokens; the cache partition
    // is absent and total_tokens must never be added on top of the derived total.
    const ts = new Date(localNoon(today))
    dbRun(
      `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
       VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
      'exec-legacy', 'task-legacy', 1,
      ts.toISOString(),
      JSON.stringify({ input_tokens: 30, output_tokens: 20, total_tokens: 999 }),
      ts.toISOString(),
    )

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    assert.equal(result.today.inputTokens, 30, 'legacy input must remain unchanged')
    assert.equal(result.today.outputTokens, 20)
    assert.equal(result.today.totalTokens, 50, 'total is full input + output, never the reported total_tokens')
    closeTestDb()
  })

  it('computes terminal outcomes from tasks table', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('t1', 'commit', today, 'done')
    seedTask('t2', 'review', today, 'failed')
    seedTask('t3', 'deploy', today, 'done')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.deepEqual(result.today.outcomes, { done: 2, failed: 1, cancelled: 0 })
    closeTestDb()
  })

  it('uses provider-local model identity with the deprecated profile alias when no shared mapping exists', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-commit', 'commit', today, 'done')
    seedExecution('exec-1', 'coding', 'task-commit')
    seedAttemptDispatch('exec-1', 'task-commit', 'codebuddy', 'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash')
    seedDispatch(today, 1, 'exec-1', 'task-commit')
    seedTurnUsage(today, 50, 25, 'exec-1', 'task-commit')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].model, 'codebuddy/deepseek-v4-flash')
    assert.equal(result.byProfile[0].profile, 'codebuddy/deepseek-v4-flash')
    assert.equal(result.byProfile[0].dispatchCount, 1)
    assert.equal(result.byProfile[0].totalTokens, 75)
    closeTestDb()
  })

  it('groups by task template with unknown fallback and never uses run ids', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-commit', 'commit', today, 'done')
    seedExecution('exec-1', 'coding', 'task-commit')
    seedDispatch(today, 1, 'exec-1', 'task-commit')
    seedTurnUsage(today, 50, 25, 'exec-1', 'task-commit')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'commit')
    // Ensure no run id or execution id appears as task name
    assert.ok(!result.byTask[0].taskName.startsWith('exec-'))
    assert.ok(!result.byTask[0].taskName.startsWith('task-'))
    assert.equal(result.byTask[0].dispatchCount, 1)
    assert.equal(result.byTask[0].totalTokens, 75)
    closeTestDb()
  })

  it('applies ranking limit sorted by totalTokens descending', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDayKey(yesterdayDate)
    seedTask('task-1', 'task-a', today, 'done')
    seedTask('task-2', 'task-b', today, 'done')
    seedExecution('exec-1', 'profile-a', 'task-1')
    seedExecution('exec-2', 'profile-b', 'task-2')
    seedAttemptDispatch('exec-1', 'task-1', 'codebuddy', 'model-a', 'codebuddy/model-a')
    seedAttemptDispatch('exec-2', 'task-2', 'cursor', 'model-b', 'cursor/model-b')
    seedTurnUsage(today, 100, 0, 'exec-1', 'task-1')
    seedTurnUsage(yesterday, 5, 0, 'exec-2', 'task-2')
    const result = readStatsSummary({ days: 2, limit: 1 }, now)
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].model, 'codebuddy/model-a')
    assert.equal(result.byProfile[0].profile, 'codebuddy/model-a')
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'task-a')
    closeTestDb()
  })

  it('zero-fills daily with exactly `days` rows', () => {
    initTestDb()
    const result = readStatsSummary({ days: 3, limit: 10 })
    assert.equal(result.daily.length, 3)
    for (const day of result.daily) {
      assert.equal(day.dispatchCount, 0)
      assert.equal(day.totalTokens, 0)
    }
    closeTestDb()
  })

  it('respects days boundary at 1', () => {
    initTestDb()
    const now = new Date()
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.daily.length, 1)
    closeTestDb()
  })

  it('rejects days greater than maximum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 367, limit: 10 }),
      /Invalid days/,
    )
    closeTestDb()
  })

  it('rejects days less than minimum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 0, limit: 10 }),
      /Invalid days/,
    )
    assert.throws(
      () => readStatsSummary({ days: -5, limit: 10 }),
      /Invalid days/,
    )
    closeTestDb()
  })

  it('respects limit boundary at 1', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedDispatch(today, 1)
    const result = readStatsSummary({ days: 5, limit: 1 }, now)
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.daily.length, 5)
    closeTestDb()
  })

  it('respects limit boundary at 50', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    for (let i = 0; i < 55; i++) {
      seedTask(`task-${i}`, `task-${i}`, today, 'done')
      seedExecution(`exec-${i}`, `profile-${i}`, `task-${i}`)
      seedTurnUsage(today, 1, 0, `exec-${i}`, `task-${i}`)
    }
    const result = readStatsSummary({ days: 7, limit: 50 }, now)
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 50)
    closeTestDb()
  })

  it('applies deterministic tie ordering by model ascending', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-x', 'task-x', today, 'done')
    seedTask('task-y', 'task-y', today, 'done')
    seedExecution('exec-a', 'beta', 'task-x')
    seedExecution('exec-b', 'alpha', 'task-y')
    seedAttemptDispatch('exec-a', 'task-x', 'codebuddy', 'beta-model', 'codebuddy/beta-model')
    seedAttemptDispatch('exec-b', 'task-y', 'codebuddy', 'alpha-model', 'codebuddy/alpha-model')
    seedTurnUsage(today, 100, 0, 'exec-a', 'task-x')
    seedTurnUsage(today, 100, 0, 'exec-b', 'task-y')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byProfile.length, 2)
    assert.equal(result.byProfile[0].model, 'codebuddy/alpha-model')
    assert.equal(result.byProfile[0].profile, 'codebuddy/alpha-model')
    assert.equal(result.byProfile[1].model, 'codebuddy/beta-model')
    assert.equal(result.byProfile[1].profile, 'codebuddy/beta-model')
    closeTestDb()
  })

  it('applies deterministic tie ordering by taskName ascending', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-b', 'task-b', today, 'done')
    seedTask('task-a', 'task-a', today, 'done')
    seedExecution('exec-a', 'profile-a', 'task-b')
    seedExecution('exec-b', 'profile-b', 'task-a')
    seedTurnUsage(today, 100, 0, 'exec-a', 'task-b')
    seedTurnUsage(today, 100, 0, 'exec-b', 'task-a')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byTask.length, 2)
    assert.equal(result.byTask[0].taskName, 'task-a')
    assert.equal(result.byTask[1].taskName, 'task-b')
    closeTestDb()
  })

  it('omits rows whose canonical model identity is missing or blank', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-1', 't1', today, 'done')
    seedTask('task-2', 't2', today, 'done')
    seedTask('task-3', 't3', today, 'done')
    seedExecution('exec-1', '', 'task-1')
    seedExecution('exec-2', '   ', 'task-2')
    seedDispatch(today, 1, 'exec-1', 'task-1')
    seedDispatch(today, 1, 'exec-2', 'task-2')
    seedDispatch(today, 1, undefined, 'task-3')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    // No canonical dispatch snapshot → no eligible model ranking rows.
    assert.equal(result.byProfile.length, 0)
    closeTestDb()
  })

  it('treats null, blank, and whitespace template as unknown', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-1', '', today, 'done')
    seedTask('task-2', '  ', today, 'done')
    seedExecution('exec-1', 'p1', 'task-1')
    seedExecution('exec-2', 'p2', 'task-2')
    seedDispatch(today, 1, 'exec-1', 'task-1')
    seedDispatch(today, 1, 'exec-2', 'task-2')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'unknown')
    assert.equal(result.byTask[0].dispatchCount, 2)
    closeTestDb()
  })

  it('resolves task template from execution_id when task_id is null', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-link', 'deploy', today, 'done')
    seedExecution('exec-link', 'ops', 'task-link')
    seedDispatch(today, 1, 'exec-link', null as unknown as string)
    seedTurnUsage(today, 50, 25, 'exec-link', null as unknown as string)
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'deploy')
    assert.equal(result.byTask[0].dispatchCount, 1)
    assert.equal(result.byTask[0].totalTokens, 75)
    closeTestDb()
  })

  it('aggregates daily dispatch, tokens, and outcomes with zero fill', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const dayMinus2 = '2026-07-17'
    const dayMinus1 = '2026-07-18'
    const dayToday = '2026-07-19'
    // Seed data in three buckets: day-2, day-1, today
    seedTask('task-y-17', 'commit', dayMinus2, 'done')
    seedTask('task-r-18', 'review', dayMinus1, 'failed')
    seedTask('task-d-19a', 'deploy', dayToday, 'done')
    seedTask('task-d-19b', 'test', dayToday, 'cancelled')
    seedExecution('exec-17', 'profile-17', 'task-y-17')
    seedExecution('exec-18', 'profile-18', 'task-r-18')
    seedExecution('exec-19a', 'profile-19a', 'task-d-19a')
    seedExecution('exec-19b', 'profile-19b', 'task-d-19b')
    seedDispatch(dayMinus2, 2, 'exec-17', 'task-y-17')
    seedDispatch(dayMinus1, 1, 'exec-18', 'task-r-18')
    seedDispatch(dayToday, 3, 'exec-19a', 'task-d-19a')
    seedTurnUsage(dayMinus2, 100, 50, 'exec-17', 'task-y-17')
    seedTurnUsage(dayToday, 200, 75, 'exec-19a', 'task-d-19a')
    const result = readStatsSummary({ days: 3, limit: 10 }, fixedNow)
    assert.equal(result.daily.length, 3)
    // Day 1 (2026-07-17)
    assert.equal(result.daily[0].dayKey, '2026-07-17')
    assert.equal(result.daily[0].dispatchCount, 2)
    assert.equal(result.daily[0].inputTokens, 100)
    assert.equal(result.daily[0].outputTokens, 50)
    assert.equal(result.daily[0].totalTokens, 150)
    assert.deepEqual(result.daily[0].outcomes, { done: 1, failed: 0, cancelled: 0 })
    // Day 2 (2026-07-18) - tokens zero
    assert.equal(result.daily[1].dayKey, '2026-07-18')
    assert.equal(result.daily[1].dispatchCount, 1)
    assert.equal(result.daily[1].totalTokens, 0)
    assert.deepEqual(result.daily[1].outcomes, { done: 0, failed: 1, cancelled: 0 })
    // Day 3 (2026-07-19) - today
    assert.equal(result.daily[2].dayKey, '2026-07-19')
    assert.equal(result.daily[2].dispatchCount, 3)
    assert.equal(result.daily[2].totalTokens, 275)
    assert.deepEqual(result.daily[2].outcomes, { done: 1, failed: 0, cancelled: 1 })
    closeTestDb()
  })

  it('zero-fills daily buckets that have no events or outcomes', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-05T12:00:00.000Z')
    const result = readStatsSummary({ days: 7, limit: 10 }, fixedNow)
    assert.equal(result.daily.length, 7)
    assert.equal(result.daily[0].dayKey, '2026-06-29')
    assert.equal(result.daily[6].dayKey, '2026-07-05')
    for (const day of result.daily) {
      assert.equal(day.dispatchCount, 0)
      assert.equal(day.inputTokens, 0)
      assert.equal(day.outputTokens, 0)
      assert.equal(day.totalTokens, 0)
      assert.equal(day.outcomes, undefined)
    }
    closeTestDb()
  })

  it('compat: readTodayStats returns DailyStatsResponse unchanged', () => {
    initTestDb()
    const result = readTodayStats()
    assert.equal(result.source, 'sqlite')
    assert.equal(typeof result.dayKey, 'string')
    assert.equal(typeof result.startAt, 'string')
    assert.equal(typeof result.endAt, 'string')
    assert.equal(typeof result.dispatchCount, 'number')
    assert.equal(typeof result.totalTokens, 'number')
    closeTestDb()
  })

  it('uses defaults for missing params', () => {
    initTestDb()
    const result = readStatsSummary({})
    assert.equal(result.daily.length, 7)
    closeTestDb()
  })

  it('uses defaults for undefined params', () => {
    initTestDb()
    const result = readStatsSummary()
    assert.equal(result.daily.length, 7)
    closeTestDb()
  })

  it('respects days boundary at 366', () => {
    initTestDb()
    const result = readStatsSummary({ days: 366, limit: 10 })
    assert.equal(result.daily.length, 366)
    closeTestDb()
  })

  it('rejects days greater than maximum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 367, limit: 10 }),
      /Invalid days/,
    )
    closeTestDb()
  })

  it('rejects days less than minimum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 0, limit: 10 }),
      /Invalid days/,
    )
    assert.throws(
      () => readStatsSummary({ days: -5, limit: 10 }),
      /Invalid days/,
    )
    closeTestDb()
  })

  it('respects limit boundary at 1 again', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedDispatch(today, 1)
    const result = readStatsSummary({ days: 5, limit: 1 }, now)
    assert.equal(result.byProfile.length, 0)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.daily.length, 5)
    closeTestDb()
  })

  it('rejects limit greater than maximum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 1, limit: 51 }),
      /Invalid limit/,
    )
    closeTestDb()
  })

  it('rejects limit less than minimum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 1, limit: 0 }),
      /Invalid limit/,
    )
    assert.throws(
      () => readStatsSummary({ days: 1, limit: -1 }),
      /Invalid limit/,
    )
    closeTestDb()
  })

  it('byProfile and byTask only aggregate today, not the full lookback', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    // Data from yesterday
    seedTask('task-y', 'yesterday-task', '2026-07-18', 'done')
    seedExecution('exec-y', 'yesterday-profile', 'task-y')
    seedAttemptDispatch('exec-y', 'task-y', 'codebuddy', 'yesterday-model', 'codebuddy/yesterday-model')
    seedDispatch('2026-07-18', 5, 'exec-y', 'task-y')
    seedTurnUsage('2026-07-18', 500, 100, 'exec-y', 'task-y')
    // Data from today
    seedTask('task-t', 'today-task', '2026-07-19', 'done')
    seedExecution('exec-t', 'today-profile', 'task-t')
    seedAttemptDispatch('exec-t', 'task-t', 'cursor', 'today-model', 'cursor/today-model')
    seedDispatch('2026-07-19', 2, 'exec-t', 'task-t')
    seedTurnUsage('2026-07-19', 50, 10, 'exec-t', 'task-t')
    const result = readStatsSummary({ days: 2, limit: 10 }, fixedNow)
    // Rankings only contain today's data
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].model, 'cursor/today-model')
    assert.equal(result.byProfile[0].profile, 'cursor/today-model')
    assert.equal(result.byProfile[0].dispatchCount, 2)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].taskName, 'today-task')
    assert.equal(result.byTask[0].dispatchCount, 2)
    // Daily has both days with correct data
    assert.equal(result.daily.length, 2)
    assert.equal(result.daily[0].dayKey, '2026-07-18')
    assert.equal(result.daily[0].dispatchCount, 5)
    assert.equal(result.daily[1].dayKey, '2026-07-19')
    assert.equal(result.daily[1].dispatchCount, 2)
    closeTestDb()
  })

  it('aggregates today task lifecycle durations for terminal, active, and excluded tasks', () => {
    initTestDb()
    // Local component constructor: local noon on 2026-07-19 is stable in every TZ.
    const fixedNow = new Date(2026, 6, 19, 12, 0, 0)
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    // Terminal: started 09:00 local, ended 11:00 local → 2h
    seedTaskInterval(
      't-term', 'commit', 'done',
      new Date(todayStart.getTime() + 9 * hour).toISOString(),
      new Date(todayStart.getTime() + 11 * hour).toISOString(),
    )
    // Active running: started 08:00 local, ends at injected now → 4h
    seedTaskInterval(
      't-run', 'review', 'running',
      new Date(todayStart.getTime() + 8 * hour).toISOString(),
      null,
    )
    // Active queued: started 10:00 local → 2h
    seedTaskInterval(
      't-queue', 'deploy', 'queued',
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
      null,
    )
    // Terminal yesterday: ended before today, excluded
    const yesterdayEnd = new Date(todayStart.getTime() - hour)
    seedTaskInterval(
      't-stale', 'stale', 'done',
      new Date(yesterdayEnd.getTime() - hour).toISOString(),
      yesterdayEnd.toISOString(),
    )

    const result = readStatsSummary({ days: 1, limit: 10 }, fixedNow)
    assert.equal(result.totalTaskDurationMs, 8 * hour)
    const byTaskDuration = result.byTaskDuration
    assert.ok(byTaskDuration, 'expected byTaskDuration for the seeded terminal and active task intervals')
    assert.equal(byTaskDuration.length, 3)
    assert.deepEqual(byTaskDuration[0], { taskName: 'review', durationMs: 4 * hour })
    assert.deepEqual(byTaskDuration[1], { taskName: 'commit', durationMs: 2 * hour })
    assert.deepEqual(byTaskDuration[2], { taskName: 'deploy', durationMs: 2 * hour })
    closeTestDb()
  })

  it('clamps crossing task intervals to the current local day at midnight', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    // Running task created at 23:00 local yesterday: clamps to [todayStart, now]
    seedTaskInterval(
      't-cross', 'cross', 'running',
      new Date(todayStart.getTime() - hour).toISOString(),
      null,
    )
    const expectedClamped = fixedNow.getTime() - todayStart.getTime()

    const result = readStatsSummary({ days: 1, limit: 10 }, fixedNow)
    assert.equal(result.totalTaskDurationMs, expectedClamped)
    assert.deepEqual(result.byTaskDuration, [{ taskName: 'cross', durationMs: expectedClamped }])
    closeTestDb()
  })

  it('adds durations additively across parallel tasks and aggregates per template', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    seedTaskInterval(
      't-c1', 'commit', 'done',
      new Date(todayStart.getTime() + 9 * hour).toISOString(),
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
    )
    seedTaskInterval(
      't-c2', 'commit', 'done',
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
      new Date(todayStart.getTime() + 11 * hour).toISOString(),
    )
    seedTaskInterval(
      't-d1', 'deploy', 'done',
      new Date(todayStart.getTime() + 11 * hour).toISOString(),
      new Date(todayStart.getTime() + 11.5 * hour).toISOString(),
    )

    const result = readStatsSummary({ days: 1, limit: 10 }, fixedNow)
    assert.equal(result.totalTaskDurationMs, 2.5 * hour)
    const byTaskDuration = result.byTaskDuration
    assert.ok(byTaskDuration, 'expected byTaskDuration for the parallel terminal task intervals')
    assert.equal(byTaskDuration.length, 2)
    assert.deepEqual(byTaskDuration[0], { taskName: 'commit', durationMs: 2 * hour })
    assert.deepEqual(byTaskDuration[1], { taskName: 'deploy', durationMs: 0.5 * hour })
    closeTestDb()
  })

  it('normalizes blank and whitespace template to unknown', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    seedTaskInterval(
      't-blank', '', 'done',
      new Date(todayStart.getTime() + 9 * hour).toISOString(),
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
    )
    seedTaskInterval(
      't-ws', '   ', 'done',
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
      new Date(todayStart.getTime() + 11 * hour).toISOString(),
    )

    const result = readStatsSummary({ days: 1, limit: 10 }, fixedNow)
    const byTaskDuration = result.byTaskDuration
    assert.ok(byTaskDuration, 'expected byTaskDuration for the blank/whitespace template intervals')
    assert.equal(byTaskDuration.length, 1)
    assert.deepEqual(byTaskDuration, [{ taskName: 'unknown', durationMs: 2 * hour }])
    assert.equal(result.totalTaskDurationMs, 2 * hour)
    closeTestDb()
  })

  it('discards invalid and inverted task intervals', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    // Inverted: created after ended → span is empty after clamping
    seedTaskInterval(
      't-inv', 'inverted', 'done',
      new Date(todayStart.getTime() + 11 * hour).toISOString(),
      new Date(todayStart.getTime() + 9 * hour).toISOString(),
    )
    // Invalid created_at → unparseable, discarded
    seedTaskInterval(
      't-bad', 'garbage', 'done',
      'not-a-date',
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
    )
    // Valid baseline interval
    seedTaskInterval(
      't-ok', 'good', 'done',
      new Date(todayStart.getTime() + 8 * hour).toISOString(),
      new Date(todayStart.getTime() + 10 * hour).toISOString(),
    )

    const result = readStatsSummary({ days: 1, limit: 10 }, fixedNow)
    assert.equal(result.totalTaskDurationMs, 2 * hour)
    assert.deepEqual(result.byTaskDuration, [{ taskName: 'good', durationMs: 2 * hour }])
    closeTestDb()
  })

  it('applies stable ordering and limit while keeping the untruncated total', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000

    const seed = (id: string, name: string, hours: number): void => {
      seedTaskInterval(
        id, name, 'done',
        new Date(todayStart.getTime() + 8 * hour).toISOString(),
        new Date(todayStart.getTime() + (8 + hours) * hour).toISOString(),
      )
    }
    seed('t-a', 'a-task', 1)
    seed('t-b', 'b-task', 2)
    seed('t-c', 'c-task', 2)
    seed('t-d', 'd-task', 3)

    const result = readStatsSummary({ days: 1, limit: 2 }, fixedNow)
    const byTaskDuration = result.byTaskDuration
    assert.ok(byTaskDuration, 'expected byTaskDuration for the ranked task intervals')
    assert.equal(byTaskDuration.length, 2)
    assert.deepEqual(byTaskDuration[0], { taskName: 'd-task', durationMs: 3 * hour })
    assert.deepEqual(byTaskDuration[1], { taskName: 'b-task', durationMs: 2 * hour })
    // total aggregates all four tasks before the ranking limit is applied
    assert.equal(result.totalTaskDurationMs, (1 + 2 + 2 + 3) * hour)
    closeTestDb()
  })

  it('uses the ended_at index for the terminal task overlap read', () => {
    initTestDb()
    const indexes = dbQuery<{ name: string }>(`SELECT name FROM pragma_index_list('tasks') WHERE origin != 'pk'`)
    assert.ok(
      indexes.some((idx) => idx.name === 'idx_task_ended_at'),
      'Expected idx_task_ended_at on tasks for ended_at-bounded overlap scans',
    )
    const plan = dbQuery<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT t.template, t.created_at, t.ended_at
       FROM tasks t INDEXED BY idx_task_ended_at
       WHERE t.ended_at >= ? AND t.ended_at < ?
         AND t.status IN ('done','failed','cancelled','interrupted')`,
      '2026-07-19T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    )
    const usesIndex = plan.some((row) => row.detail.includes('idx_task_ended_at'))
    assert.ok(usesIndex, 'Expected EXPLAIN QUERY PLAN to show idx_task_ended_at for the terminal overlap scan')
    closeTestDb()
  })

  it('returns fixed 24h/7d/1mo windows in exact order with valid ranges for days=31', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const dayStart = (offsetDays: number): string => {
      const d = new Date(todayStart)
      d.setDate(d.getDate() + offsetDays)
      return d.toISOString()
    }
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const windows = result.windows
    assert.ok(windows, 'expected windows on every summary')
    assert.equal(windows.length, 3)
    assert.deepEqual(windows.map((w) => w.period), ['24h', '7d', '1mo'])
    assert.equal(windows[0].startAt, dayStart(0))
    assert.equal(windows[1].startAt, dayStart(-6))
    assert.equal(windows[2].startAt, dayStart(-30))
    for (const w of windows) {
      assert.equal(w.endAt, dayStart(1))
      assert.ok(w.startAt < w.endAt)
    }
    closeTestDb()
  })

  it('returns zeroed windows for an empty database', () => {
    initTestDb()
    const result = readStatsSummary({ days: 31, limit: 10 })
    const windows = result.windows
    assert.ok(windows)
    assert.equal(windows.length, 3)
    for (const w of windows) {
      assert.equal(w.dispatchCount, 0)
      assert.equal(w.totalTokens, 0)
      assert.equal(w.byProfile.length, 0)
      assert.equal(w.taskStats.totalDurationMs, 0)
      assert.equal(w.taskStats.byTask.length, 0)
      assert.equal(w.taskStats.builtinTotalDurationMs, 0)
      assert.equal(w.taskStats.byBuiltinTask.length, 0)
    }
    closeTestDb()
  })

  it('groups only canonical-model dispatches and omits identity-less rows while keeping totals', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-resolved', 'commit', today, 'done')
    seedExecutionResolved('exec-resolved', 'policy-a', 'coding', 'task-resolved')
    seedAttemptDispatch('exec-resolved', 'task-resolved', 'codebuddy', 'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash')
    seedDispatch(today, 2, 'exec-resolved', 'task-resolved')
    seedTurnUsage(today, 100, 50, 'exec-resolved', 'task-resolved')

    seedTask('task-unresolved', 'review', today, 'done')
    seedExecutionResolved('exec-unresolved', 'policy-b', null, 'task-unresolved')
    seedDispatch(today, 3, 'exec-unresolved', 'task-unresolved')
    seedTurnUsage(today, 20, 10, 'exec-unresolved', 'task-unresolved')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const windows = result.windows
    assert.ok(windows)
    for (const w of windows) {
      assert.equal(w.dispatchCount, 5, `${w.period} dispatchCount includes identity-less dispatches`)
      assert.equal(w.totalTokens, 180, `${w.period} totalTokens includes all usage`)
      assert.equal(w.byProfile.length, 1, `${w.period} groups only canonical-model dispatches`)
      assert.deepEqual(w.byProfile[0], { profile: 'codebuddy/deepseek-v4-flash', model: 'codebuddy/deepseek-v4-flash', runCount: 2, totalTokens: 150 })
    }
    closeTestDb()
  })

  it('computes weighted average TPS only from the exact agent_turn_v1 contract', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-tps', 'commit', today, 'done')
    seedExecutionResolved('exec-tps', 'policy-a', 'coding', 'task-tps')
    seedAttemptDispatch('exec-tps', 'task-tps', 'codebuddy', 'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash')
    // Valid agent_turn_v1 usage: contributes to the TPS numerator and denominator
    seedUsageWithDuration(today, 30, 2000, 4000, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    seedUsageWithDuration(today, 30, 1000, 1000, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    // Unversioned, wrong-token-scope, wrong-contract, other-scope, and
    // zero-duration usage still counts toward totalTokens but never averageTps.
    seedUsageWithDuration(today, 30, 500, 500, null, 'exec-tps', 'task-tps')
    seedUsageWithDuration(today, 30, 500, 500, 'model_output', 'exec-tps', 'task-tps')
    seedUsageWithDuration(today, 30, 500, 500, 'agent_turn', 'exec-tps', 'task-tps', 'model_output', 'agent_turn_v1')
    seedUsageWithDuration(today, 30, 500, 500, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v0')
    seedUsageWithDuration(today, 30, 500, 0, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const row = result.windows?.[0].byProfile[0]
    assert.ok(row)
    assert.equal(row.totalTokens, 30 * 7 + 2000 + 1000 + 500 * 5)
    // 1000 * (2000 + 1000) / (4000 + 1000) = 600
    assert.equal(row.averageTps, 600)
    closeTestDb()
  })

  it('omits averageTps when no valid agent_turn usage exists', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-notps', 'commit', today, 'done')
    seedExecutionResolved('exec-notps', 'policy-a', 'coding', 'task-notps')
    seedAttemptDispatch('exec-notps', 'task-notps', 'codebuddy', 'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash')
    seedTurnUsage(today, 100, 50, 'exec-notps', 'task-notps')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const row = result.windows?.[0].byProfile[0]
    assert.ok(row)
    assert.equal(row.totalTokens, 150)
    assert.equal('averageTps' in row, false)
    closeTestDb()
  })

  it('clamps task intervals per window with all and builtin totals and rankings', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const day = 24 * hour
    const iso = (ms: number): string => new Date(ms).toISOString()

    // builtin, today, 1h → every window
    seedTaskWithProject('t-now', 'now-task', 'done', iso(todayStart.getTime() + 9 * hour), iso(todayStart.getTime() + 10 * hour), null, 'builtin')
    // project, yesterday, 1h → 7d and 1mo only
    seedTaskWithProject('t-yest', 'yesterday-task', 'done', iso(todayStart.getTime() - day + 8 * hour), iso(todayStart.getTime() - day + 9 * hour), 'ws', 'project')
    // builtin, 10 days ago, 1h → 1mo only
    seedTaskWithProject('t-old', 'old-task', 'done', iso(todayStart.getTime() - 10 * day), iso(todayStart.getTime() - 10 * day + hour), null, 'builtin')
    // active builtin running since yesterday 23:00 → clamped to now in every window
    seedTaskWithProject('t-act', 'active-task', 'running', iso(todayStart.getTime() - hour), null, null, 'builtin')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const windows = result.windows
    assert.ok(windows)
    const [h24, d7, mo] = windows
    const activeMs = fixedNow.getTime() - todayStart.getTime()

    assert.equal(h24.taskStats.totalDurationMs, hour + activeMs)
    assert.equal(h24.taskStats.builtinTotalDurationMs, hour + activeMs)
    assert.equal(h24.taskStats.byTask.length, 2)
    assert.deepEqual(h24.taskStats.byTask[0], {
      taskId: 'active-task',
      source: 'builtin',
      runCount: 1,
      durationMs: activeMs,
      averageDurationMs: activeMs,
    })
    assert.equal(h24.taskStats.byTask[1].taskId, 'now-task')

    assert.equal(d7.taskStats.totalDurationMs, 3 * hour + activeMs)
    assert.equal(d7.taskStats.byTask.length, 3)

    assert.equal(mo.taskStats.totalDurationMs, 4 * hour + activeMs)
    assert.equal(mo.taskStats.builtinTotalDurationMs, 3 * hour + activeMs)
    assert.equal(mo.taskStats.byTask.length, 4)
    assert.equal(mo.taskStats.byBuiltinTask.length, 3)
    // builtin denominator is independent and equals the full builtin ranking sum
    assert.equal(mo.taskStats.builtinTotalDurationMs, mo.taskStats.byBuiltinTask.reduce((sum, row) => sum + row.durationMs, 0))
    closeTestDb()
  })

  it('reports legacy NULL definition_source as unknown without guessing from project', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()

    // Legacy rows predating definition_source keep project as the execution
    // target but NULL definition_source; they must surface as 'unknown' and
    // never be guessed as builtin just because of the execution project.
    seedTaskWithProject('t-legacy', 'legacy-task', 'done', iso(todayStart.getTime() + 9 * hour), iso(todayStart.getTime() + 10 * hour), 'ws', null)
    // A post-migration builtin bound to a non-null execution project must
    // still classify as builtin from its explicit definition_source.
    seedTaskWithProject('t-builtin-proj', 'builtin-task', 'done', iso(todayStart.getTime() + 10 * hour), iso(todayStart.getTime() + 11 * hour), 'ws', 'builtin')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const taskStats = result.windows?.[0].taskStats
    assert.ok(taskStats)
    // All-task totals include both sources; legacy unknown is never dropped.
    assert.equal(taskStats.totalDurationMs, 2 * hour)
    assert.equal(taskStats.byTask.length, 2)
    const bySource = new Map(taskStats.byTask.map((row) => [row.taskId, row.source]))
    assert.equal(bySource.get('legacy-task'), 'unknown')
    assert.equal(bySource.get('builtin-task'), 'builtin')
    // Only explicit builtin feeds builtin totals.
    assert.equal(taskStats.builtinTotalDurationMs, hour)
    assert.deepEqual(taskStats.byBuiltinTask, [{
      taskId: 'builtin-task',
      source: 'builtin',
      runCount: 1,
      durationMs: hour,
      averageDurationMs: hour,
    }])
    closeTestDb()
  })

  it('excludes same-id project overrides from builtin totals', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()

    // A project definition overrides the same-id builtin; the persisted
    // definition_source is 'project' and must not feed builtin totals.
    seedTaskWithProject('t-override', 'edit', 'done', iso(todayStart.getTime() + 8 * hour), iso(todayStart.getTime() + 10 * hour), 'app', 'project')
    // The fallback builtin with the same id runs unbound to the override.
    seedTaskWithProject('t-builtin', 'edit', 'done', iso(todayStart.getTime() + 10 * hour), iso(todayStart.getTime() + 11 * hour), null, 'builtin')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const taskStats = result.windows?.[0].taskStats
    assert.ok(taskStats)
    assert.equal(taskStats.totalDurationMs, 3 * hour)
    const projectRow = taskStats.byTask.find((row) => row.source === 'project')
    assert.deepEqual(projectRow, {
      taskId: 'edit',
      source: 'project',
      runCount: 1,
      durationMs: 2 * hour,
      averageDurationMs: 2 * hour,
    })
    assert.equal(taskStats.builtinTotalDurationMs, hour)
    assert.deepEqual(taskStats.byBuiltinTask, [{
      taskId: 'edit',
      source: 'builtin',
      runCount: 1,
      durationMs: hour,
      averageDurationMs: hour,
    }])
    closeTestDb()
  })

  it('applies stable window task ranking with full totals before limit', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    const seed = (id: string, name: string, hours: number): void => {
      seedTaskWithProject(id, name, 'done', iso(todayStart.getTime() + 8 * hour), iso(todayStart.getTime() + (8 + hours) * hour), null, 'builtin')
    }
    seed('t-a', 'a-task', 1)
    seed('t-b', 'b-task', 2)
    seed('t-c', 'c-task', 2)
    seed('t-d', 'd-task', 3)

    const result = readStatsSummary({ days: 31, limit: 2 }, fixedNow)
    const taskStats = result.windows?.[0].taskStats
    assert.ok(taskStats)
    assert.equal(taskStats.totalDurationMs, (1 + 2 + 2 + 3) * hour)
    assert.equal(taskStats.byTask.length, 2)
    assert.deepEqual(taskStats.byTask[0], { taskId: 'd-task', source: 'builtin', runCount: 1, durationMs: 3 * hour, averageDurationMs: 3 * hour })
    assert.deepEqual(taskStats.byTask[1], { taskId: 'b-task', source: 'builtin', runCount: 1, durationMs: 2 * hour, averageDurationMs: 2 * hour })
    closeTestDb()
  })

  it('sorts window profiles by totalTokens descending and applies the limit', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    const seedModel = (id: string, model: string, tokens: number): void => {
      seedTask(`task-${id}`, `task-${id}`, today, 'done')
      seedExecutionResolved(`exec-${id}`, `policy-${id}`, model, `task-${id}`)
      seedAttemptDispatch(`exec-${id}`, `task-${id}`, 'codebuddy', model, `codebuddy/${model}`)
      seedDispatch(today, 1, `exec-${id}`, `task-${id}`)
      seedTurnUsage(today, tokens, 0, `exec-${id}`, `task-${id}`)
    }
    seedModel('a', 'model-a', 100)
    seedModel('b', 'model-b', 300)
    seedModel('c', 'model-c', 200)

    const result = readStatsSummary({ days: 31, limit: 2 }, fixedNow)
    const byProfile = result.windows?.[0].byProfile
    assert.ok(byProfile)
    assert.equal(byProfile.length, 2)
    assert.deepEqual(byProfile[0], { profile: 'codebuddy/model-b', model: 'codebuddy/model-b', runCount: 1, totalTokens: 300 })
    assert.deepEqual(byProfile[1], { profile: 'codebuddy/model-c', model: 'codebuddy/model-c', runCount: 1, totalTokens: 200 })
    closeTestDb()
  })

  it('rejects malformed windows through the stats.summary result schema', () => {
    const valid = { ...minimalSummaryBase(), windows: [validWindow('24h'), validWindow('7d'), validWindow('1mo')] }
    assert.deepEqual(parseMethodResult('stats.summary', valid), valid)

    // The source enum accepts builtin, project, and unknown for legacy rows.
    const unknownRow = {
      taskId: 'x',
      source: 'unknown',
      runCount: 1,
      durationMs: 1,
      averageDurationMs: 1,
    }
    const withUnknown = {
      ...minimalSummaryBase(),
      windows: [{
        ...validWindow('24h'),
        taskStats: {
          totalDurationMs: 1,
          byTask: [unknownRow],
          builtinTotalDurationMs: 0,
          byBuiltinTask: [],
        },
      }, validWindow('7d'), validWindow('1mo')],
    }
    assert.deepEqual(parseMethodResult('stats.summary', withUnknown), withUnknown)

    const detailsOf = (err: unknown): string[] => {
      const data = (err as { data?: { details?: string[] } }).data
      return data?.details ?? []
    }
    const rejects = (payload: unknown, needle: string): void => {
      assert.throws(
        () => parseMethodResult('stats.summary', payload),
        (err: unknown) => detailsOf(err).some((detail) => detail.includes(needle)),
        `expected details to mention ${needle}`,
      )
    }

    // Wrong period value
    rejects(
      { ...minimalSummaryBase(), windows: [{ ...validWindow('24h'), period: '2d' }, validWindow('7d'), validWindow('1mo')] },
      'period',
    )
    // Wrong number of windows
    rejects(
      { ...minimalSummaryBase(), windows: [validWindow('24h'), validWindow('7d')] },
      'windows',
    )
    // Invalid task source enum
    rejects(
      {
        ...minimalSummaryBase(),
        windows: [{
          ...validWindow('24h'),
          taskStats: {
            totalDurationMs: 0,
            byTask: [{ taskId: 'x', source: 'built-in', runCount: 1, durationMs: 1, averageDurationMs: 1 }],
            builtinTotalDurationMs: 0,
            byBuiltinTask: [],
          },
        }, validWindow('7d'), validWindow('1mo')],
      },
      'source',
    )
    // Negative numeric value
    rejects(
      { ...minimalSummaryBase(), windows: [{ ...validWindow('24h'), dispatchCount: -1 }, validWindow('7d'), validWindow('1mo')] },
      'dispatchCount',
    )
  })

  it('preserves authoritative project context in recentRuns while keeping definition_source classification', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    // A post-migration project definition: exact project context must survive on the run row.
    seedTaskWithProject('r-proj', 'edit', 'done', iso(todayStart.getTime() + 9 * hour), iso(todayStart.getTime() + 10 * hour), 'ws', 'project')
    // A post-migration builtin: classified builtin and gains no project label of its own.
    seedTaskWithProject('r-builtin', 'commit', 'done', iso(todayStart.getTime() + 7 * hour), iso(todayStart.getTime() + 8 * hour), null, 'builtin')
    // A legacy row predating definition_source: classified unknown, never guessed from its project.
    seedTaskWithProject('r-legacy', 'review', 'done', iso(todayStart.getTime() + 5 * hour), iso(todayStart.getTime() + 6 * hour), 'ws', null)

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const runs = result.recentRuns
    assert.ok(runs, 'expected recentRuns for the seeded task runs')
    assert.equal(runs.length, 3)
    const byRunId = new Map(runs.map((run) => [run.task_run_id, run]))
    const projectRun = byRunId.get('r-proj')
    assert.ok(projectRun)
    assert.equal(projectRun.project, 'ws', 'project definitions carry their exact project context')
    assert.equal(projectRun.source, 'project')
    assert.equal(projectRun.task, 'edit')
    const builtinRun = byRunId.get('r-builtin')
    assert.ok(builtinRun)
    assert.equal(builtinRun.project, undefined, 'builtin rows keep no fabricated project label')
    assert.equal(builtinRun.source, 'builtin')
    assert.equal(builtinRun.task, 'commit')
    const legacyRun = byRunId.get('r-legacy')
    assert.ok(legacyRun)
    assert.equal(legacyRun.project, 'ws', 'legacy rows may still carry the execution project')
    assert.equal(legacyRun.source, 'unknown', 'legacy NULL definition_source stays unknown regardless of project')
    assert.equal(legacyRun.task, 'review')
    closeTestDb()
  })

  it('surfaces the exact persisted executions.resolved_profile for legacy runs while keeping full resolved preferred', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    const fixedTs = '2024-01-01T00:00:00.000Z'

    // Completed legacy run: a real execution with real usage and a persisted
    // executions.resolved_profile, but no task_run_attempt_dispatch row at all
    // (the run predates full dispatch snapshots).
    seedTaskWithProject(
      'r-legacy', 'legacy-task', 'done',
      iso(todayStart.getTime() + 9 * hour), iso(todayStart.getTime() + 10 * hour), null, null,
    )
    dbRun(
      `INSERT INTO executions (id, task_id, profile, resolved_profile, permission, cwd, prompt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'edit', '/tmp', 'prompt', 'done', ?, ?)`,
      'exec-legacy', 'r-legacy', 'policy-legacy', 'legacy-clean', fixedTs, fixedTs,
    )
    dbRun(
      `UPDATE tasks SET execution_id = 'exec-legacy' WHERE id = 'r-legacy'`,
    )
    const usageIso = iso(todayStart.getTime() + 9.5 * hour)
    dbRun(
      `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
       VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
      'exec-legacy', 'r-legacy', 1, usageIso,
      JSON.stringify({ token_scope: 'agent_turn', input_tokens: 100, output_tokens: 50 }),
      usageIso,
    )

    // Pre-dispatch failed run: no execution was ever created, so no profile.
    seedTaskWithProject(
      'r-none', 'failed-task', 'failed',
      iso(todayStart.getTime() + 5 * hour), iso(todayStart.getTime() + 6 * hour), null, 'project',
    )

    // Modern run: a full task_run_attempt_dispatch snapshot exists, so the
    // full resolved object must remain the preferred representation while the
    // additive scalar may also be present.
    seedTaskWithProject(
      'r-modern', 'modern-task', 'done',
      iso(todayStart.getTime() + 3 * hour), iso(todayStart.getTime() + 4 * hour), null, 'builtin',
    )
    dbRun(
      `INSERT INTO executions (id, task_id, profile, resolved_profile, permission, cwd, prompt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'edit', '/tmp', 'prompt', 'done', ?, ?)`,
      'exec-modern', 'r-modern', 'cb-dsf', 'cb-dsf', fixedTs, fixedTs,
    )
    dbRun(
      `UPDATE tasks SET execution_id = 'exec-modern' WHERE id = 'r-modern'`,
    )
    dbRun(
      `INSERT INTO task_run_attempt_dispatch (
         execution_id, task_run_id, requested_agent_runtime, profile, client, provider,
         model, model_id, mode, protocol, intelligence,
         speed_effective_tps, speed_source, speed_sample_count, speed_checked_at,
         speed_expected_tps_met,
         reference_pricing_input, reference_pricing_output,
         reference_pricing_source, reference_pricing_checked_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', NULL, 'mid', ?, ?, ?, ?, 1, ?, ?, 'catalog', ?, ?, ?)`,
      'exec-modern', 'r-modern', 'forge/codebuddy', 'cb-dsf', 'codebuddy', 'codebuddy',
      'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash',
      45, 'catalog_default', 7, fixedTs,
      0.2, 1.2, fixedTs, fixedTs, fixedTs,
    )

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const runs = result.recentRuns
    assert.ok(runs, 'expected recentRuns for the seeded task runs')
    assert.equal(runs.length, 3)
    const byRunId = new Map(runs.map((run) => [run.task_run_id, run]))

    const legacyRun = byRunId.get('r-legacy')
    assert.ok(legacyRun)
    assert.equal(
      legacyRun.resolved_profile,
      'legacy-clean',
      'legacy completed runs expose their exact persisted executions.resolved_profile',
    )
    assert.equal('resolved' in legacyRun, false, 'no full resolved is fabricated from the scalar')
    assert.equal(legacyRun.resolved, undefined)
    assert.equal(legacyRun.usage.completeness, 'partial')
    assert.equal(legacyRun.usage.input_tokens, 100)
    assert.equal(legacyRun.usage.output_tokens, 50)
    assert.equal(legacyRun.usage.attempt_count, 1)

    const noneRun = byRunId.get('r-none')
    assert.ok(noneRun)
    assert.equal(noneRun.resolved_profile, undefined, 'pre-dispatch runs without an execution stay profile-less')
    assert.equal('resolved' in noneRun, false)
    assert.equal('resolved_profile' in noneRun, false)

    const modernRun = byRunId.get('r-modern')
    assert.ok(modernRun)
    assert.ok(modernRun.resolved, 'modern full resolved snapshots remain preferred')
    assert.equal(modernRun.resolved.profile, 'cb-dsf')
    assert.equal(modernRun.resolved.model_id, 'codebuddy/deepseek-v4-flash')
    closeTestDb()
  })

  it('emits paired display names on recent runs only for an exact resolved provider/model match', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    seedResolvedDispatchRun({
      taskRunId: 'r-display', template: 'display-task',
      createdIso: iso(todayStart.getTime() + 8 * hour), endedIso: iso(todayStart.getTime() + 9 * hour),
      executionId: 'exec-display', profile: 'auto', client: 'codebuddy',
      provider: 'codebuddy', model: 'deepseek-v4-flash', modelId: 'codebuddy/deepseek-v4-flash',
    })
    const calls: Array<[string, string]> = []
    const result = readStatsSummary(
      { days: 31, limit: 10 },
      fixedNow,
      {
        resolveDisplayNames: (provider, model) => {
          calls.push([provider, model])
          if (provider === 'codebuddy' && model === 'deepseek-v4-flash') {
            return { provider_display_name: 'CodeBuddy', model_display_name: 'DeepSeek V4 Flash' }
          }
          return undefined
        },
      },
    )
    const run = result.recentRuns?.find((row) => row.task_run_id === 'r-display')
    assert.ok(run, 'expected recentRuns to include the seeded display run')
    assert.ok(run.resolved, 'display run must carry its full resolved dispatch')
    assert.equal(run.provider_display_name, 'CodeBuddy')
    assert.equal(run.model_display_name, 'DeepSeek V4 Flash')
    // Exactly once, with the exact canonical provider/model pair.
    assert.deepEqual(calls, [['codebuddy', 'deepseek-v4-flash']])
    closeTestDb()
  })

  it('emits neither display name when the resolver cannot map the exact provider or model', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    seedResolvedDispatchRun({
      taskRunId: 'r-unknown', template: 'unknown-model-task',
      createdIso: iso(todayStart.getTime() + 8 * hour), endedIso: iso(todayStart.getTime() + 9 * hour),
      executionId: 'exec-unknown', profile: 'auto', client: 'codebuddy',
      provider: 'codebuddy', model: 'missing-model', modelId: 'codebuddy/missing-model',
    })
    const calls: Array<[string, string]> = []
    const result = readStatsSummary(
      { days: 31, limit: 10 },
      fixedNow,
      {
        resolveDisplayNames: (provider, model) => {
          calls.push([provider, model])
          return undefined
        },
      },
    )
    const run = result.recentRuns?.find((row) => row.task_run_id === 'r-unknown')
    assert.ok(run)
    assert.ok(run.resolved)
    assert.equal(run.provider_display_name, undefined)
    assert.equal(run.model_display_name, undefined)
    assert.equal('provider_display_name' in run, false)
    assert.equal('model_display_name' in run, false)
    assert.deepEqual(calls, [['codebuddy', 'missing-model']])
    closeTestDb()
  })

  it('never invokes the display resolver for alias-only legacy rows without a resolved snapshot', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    seedAliasOnlyLegacyRun(
      'r-alias', 'alias-task',
      iso(todayStart.getTime() + 8 * hour), iso(todayStart.getTime() + 9 * hour),
      'legacy-clean',
    )
    const calls: Array<[string, string]> = []
    const result = readStatsSummary(
      { days: 31, limit: 10 },
      fixedNow,
      {
        resolveDisplayNames: (provider, model) => {
          calls.push([provider, model])
          return { provider_display_name: 'X', model_display_name: 'Y' }
        },
      },
    )
    const run = result.recentRuns?.find((row) => row.task_run_id === 'r-alias')
    assert.ok(run)
    assert.equal(run.resolved_profile, 'legacy-clean')
    assert.equal('resolved' in run, false)
    assert.equal('provider_display_name' in run, false)
    assert.equal('model_display_name' in run, false)
    assert.equal(calls.length, 0, 'alias-only rows carry no resolved snapshot, so the resolver must not run')
    closeTestDb()
  })

  it('never substitutes raw ids/client/profile for labels and auto_routing survives the ledger projection', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()
    const decision = {
      snapshot_id: 'snap-abc',
      selected_rank: 1,
      supply_class: 'confirmed_free' as const,
      quota_tier: 'healthy' as const,
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 1.5,
      routing_output_usd_per_million: 1.25,
      effective_cap_usd_per_million: 1.6,
      score: 9.5,
      reasons: ['rank-1'],
    }
    // The resolved snapshot keeps a run-syntax model_id and non-canonical
    // client/profile values; only the exact provider/model pair may drive labels.
    seedResolvedDispatchRun({
      taskRunId: 'r-safe', template: 'safe-task',
      createdIso: iso(todayStart.getTime() + 8 * hour), endedIso: iso(todayStart.getTime() + 9 * hour),
      executionId: 'exec-safe', profile: 'policy-x', client: 'cc-raw',
      provider: 'codebuddy', model: 'deepseek-v4-flash',
      modelId: 'codebuddy/deepseek-v4-flash:cc',
      autoRoutingJson: JSON.stringify(decision),
    })
    const calls: Array<[string, string]> = []
    const result = readStatsSummary(
      { days: 31, limit: 10 },
      fixedNow,
      {
        resolveDisplayNames: (provider, model) => {
          calls.push([provider, model])
          if (provider === 'codebuddy' && model === 'deepseek-v4-flash') {
            return { provider_display_name: 'CodeBuddy', model_display_name: 'DeepSeek V4 Flash' }
          }
          return undefined
        },
      },
    )
    const run = result.recentRuns?.find((row) => row.task_run_id === 'r-safe')
    assert.ok(run)
    assert.ok(run.resolved)
    assert.equal(run.resolved.client, 'cc-raw')
    assert.equal(run.resolved.profile, 'policy-x')
    assert.equal(run.resolved.model_id, 'codebuddy/deepseek-v4-flash:cc')
    assert.deepEqual(calls, [['codebuddy', 'deepseek-v4-flash']], 'resolver is fed the canonical provider/model pair only')
    assert.equal(run.provider_display_name, 'CodeBuddy')
    assert.equal(run.model_display_name, 'DeepSeek V4 Flash')
    // The persisted decision survives the ledger projection untouched.
    assert.deepEqual(run.resolved.auto_routing, decision)
    // The full summary (including recentRuns with paired labels and the
    // auto_routing decision) is valid on the stats wire path.
    assert.deepEqual(parseMethodResult('stats.summary', result), result)
    closeTestDb()
  })

  it('keeps one ledger row per run with tasks.ended_at authoritative and earliest started_at', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const todayStart = new Date(fixedNow.getFullYear(), fixedNow.getMonth(), fixedNow.getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()

    // Terminal runs carry distinct created_at/ended_at; active runs carry no
    // ended_at. created_at always deliberately differs from ended_at so no
    // created/updated fallback could satisfy the terminal finished_at asserts.
    const doneEnded = iso(todayStart.getTime() + 10 * hour)
    const failedEnded = iso(todayStart.getTime() + 6 * hour)
    const cancelledEnded = iso(todayStart.getTime() + 7.5 * hour)
    seedTaskWithProject('ledger-done', 'commit', 'done', iso(todayStart.getTime() + 8 * hour), doneEnded, null, 'builtin')
    seedTaskWithProject('ledger-failed', 'review', 'failed', iso(todayStart.getTime() + 5 * hour), failedEnded, null, 'builtin')
    seedTaskWithProject('ledger-cancelled', 'deploy', 'cancelled', iso(todayStart.getTime() + 7 * hour), cancelledEnded, null, 'builtin')
    seedTaskWithProject('ledger-running', 'build', 'running', iso(todayStart.getTime() + 11 * hour), null, null, 'builtin')
    seedTaskWithProject('ledger-queued', 'test', 'queued', iso(todayStart.getTime() + 12 * hour), null, null, 'builtin')

    // Two attempts on the same done run with different started_at values; the
    // earliest one must be projected onto the single ledger row. The queued run
    // deliberately has no execution at all.
    const doneEarliestStart = iso(todayStart.getTime() + 8.25 * hour)
    const runningStart = iso(todayStart.getTime() + 11.5 * hour)
    const seedExecStarted = (id: string, taskId: string, status: string, startedAt: string): void => {
      dbRun(
        `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'edit', '/tmp', 'prompt', ?, ?, ?, ?)`,
        id,
        taskId,
        'codebuddy',
        status,
        startedAt,
        startedAt,
        startedAt,
      )
    }
    seedExecStarted('exec-done-1', 'ledger-done', 'done', doneEarliestStart)
    seedExecStarted('exec-done-2', 'ledger-done', 'done', iso(todayStart.getTime() + 8.5 * hour))
    seedExecStarted('exec-failed', 'ledger-failed', 'failed', iso(todayStart.getTime() + 5.5 * hour))
    seedExecStarted('exec-cancelled', 'ledger-cancelled', 'cancelled', iso(todayStart.getTime() + 7.25 * hour))
    seedExecStarted('exec-running', 'ledger-running', 'running', runningStart)

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const runs = result.recentRuns
    assert.ok(runs, 'expected recentRuns for the seeded task runs')
    assert.equal(runs.length, 5)
    const byRunId = new Map(runs.map((run) => [run.task_run_id, run]))
    assert.equal(
      runs.filter((run) => run.task_run_id === 'ledger-done').length,
      1,
      'two executions must collapse to exactly one ledger row for the done run',
    )

    const doneRun = byRunId.get('ledger-done')
    assert.ok(doneRun)
    assert.equal(doneRun.status, 'done')
    assert.equal(doneRun.finished_at, doneEnded, 'done finished_at is the authoritative tasks.ended_at')
    assert.equal(doneRun.started_at, doneEarliestStart, 'started_at is the earliest execution.started_at across both attempts')
    assert.equal(doneRun.usage.attempt_count, 2, 'usage counts both attempts while the ledger keeps one row')

    const failedRun = byRunId.get('ledger-failed')
    assert.ok(failedRun)
    assert.equal(failedRun.status, 'failed')
    assert.equal(failedRun.finished_at, failedEnded, 'failed finished_at is the authoritative tasks.ended_at')

    const cancelledRun = byRunId.get('ledger-cancelled')
    assert.ok(cancelledRun)
    assert.equal(cancelledRun.status, 'cancelled')
    assert.equal(cancelledRun.finished_at, cancelledEnded, 'cancelled finished_at is the authoritative tasks.ended_at')

    const runningRun = byRunId.get('ledger-running')
    assert.ok(runningRun)
    assert.equal(runningRun.status, 'running')
    assert.equal('finished_at' in runningRun, false, 'running runs omit finished_at')
    assert.equal(runningRun.started_at, runningStart, 'running started_at is projected from its execution')

    const queuedRun = byRunId.get('ledger-queued')
    assert.ok(queuedRun)
    assert.equal(queuedRun.status, 'queued')
    assert.equal('finished_at' in queuedRun, false, 'queued runs omit finished_at')
    assert.equal('started_at' in queuedRun, false, 'queued runs without an execution omit started_at')
    closeTestDb()
  })

  it('merges explicit shared canonical identity across different provider route ids', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'codebuddy', 'kimi-k3', 'codebuddy/kimi-k3', 'codebuddy')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTurnUsage(today, 100, 50, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'kimi-coding', 'k3', 'kimi-coding/k3', 'claude')
    seedDispatch(today, 2, 'exec-b', 'task-b')
    seedTurnUsage(today, 200, 80, 'exec-b', 'task-b')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider, model) => ({
        provider_display_name: provider === 'codebuddy' ? 'CodeBuddy' : 'Kimi Coding',
        model_display_name: model === 'k3' ? 'Kimi K3' : 'Kimi-K3',
        stats_model_key: 'canonical:kimi-k3',
        stats_model_id: 'kimi-k3',
        stats_model_display_name: 'Kimi K3',
      }),
    })
    // Both today and every window surface one shared canonical Kimi K3 row.
    assert.equal(result.byProfile.length, 1, 'explicit canonical identity merges different provider route ids')
    const item = result.byProfile[0]
    assert.equal(item.model, 'kimi-k3')
    assert.equal(item.profile, 'kimi-k3')
    assert.equal(item.dispatchCount, 3, 'dispatches summed across providers')
    assert.equal(item.inputTokens, 300)
    assert.equal(item.outputTokens, 130)
    assert.equal(item.totalTokens, 430)
    for (const w of result.windows ?? []) {
      assert.equal(w.byProfile.length, 1)
      assert.equal(w.byProfile[0].model, 'kimi-k3')
      assert.equal(w.byProfile[0].runCount, 3)
      assert.equal(w.byProfile[0].totalTokens, 430)
    }
    closeTestDb()
  })

  it('keeps equal raw model ids provider-local unless both routes explicitly share a canonical identity', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'provider-a', 'same-id', 'provider-a/same-id')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'provider-b', 'same-id', 'provider-b/same-id')
    seedDispatch(today, 1, 'exec-b', 'task-b')

    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider) => ({
        provider_display_name: provider,
        model_display_name: 'Coincidental Label',
        // An un-namespaced key is rejected and cannot force unrelated routes
        // into the same group.
        stats_model_key: 'same-id',
        stats_model_id: 'same-id',
        stats_model_display_name: 'Coincidental Label',
      }),
    })
    assert.deepEqual(result.byProfile.map((row) => row.model).sort(), [
      'provider-a/same-id',
      'provider-b/same-id',
    ])
    assert.equal(result.windows?.[0].byProfile.length, 2)
    closeTestDb()
  })

  it('keeps dated and unversioned model routes separate even when display labels are equal', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'codebuddy', 'deepseek-v4-flash', 'codebuddy/deepseek-v4-flash')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTurnUsage(today, 100, 10, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'tokenhub', 'deepseek-v4-flash-202605', 'tokenhub/deepseek-v4-flash-202605')
    seedDispatch(today, 1, 'exec-b', 'task-b')
    seedTurnUsage(today, 100, 10, 'exec-b', 'task-b')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider, model) => {
        if ((provider === 'codebuddy' && model === 'deepseek-v4-flash')
          || (provider === 'tokenhub' && model === 'deepseek-v4-flash-202605')) {
          return { provider_display_name: provider, model_display_name: 'DeepSeek V4 Flash' }
        }
        return undefined
      },
    })
    assert.equal(result.byProfile.length, 2, 'dated and unversioned routes stay separate rows')
    const models = result.byProfile.map((r) => r.model).sort()
    assert.deepEqual(models, ['codebuddy/deepseek-v4-flash', 'tokenhub/deepseek-v4-flash-202605'])
    for (const r of result.byProfile) assert.equal(r.model_display_name, 'DeepSeek V4 Flash')
    closeTestDb()
  })

  it('omits missing or inconsistent identity without changing totals and never infers from resolved_profile or model_id', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    // Eligible: surfaces in the model rankings.
    seedTask('task-ok', 'ok', today, 'done')
    seedExecutionResolved('exec-ok', 'policy-ok', 'coding', 'task-ok')
    seedAttemptDispatch('exec-ok', 'task-ok', 'codebuddy', 'good-model', 'codebuddy/good-model')
    seedDispatch(today, 2, 'exec-ok', 'task-ok')
    seedTurnUsage(today, 100, 50, 'exec-ok', 'task-ok')
    // Inconsistent identity: model_id does not match provider/model → omitted.
    seedTask('task-bad', 'bad', today, 'done')
    seedExecutionResolved('exec-bad', 'policy-bad', 'coding', 'task-bad')
    seedAttemptDispatch('exec-bad', 'task-bad', 'codebuddy', 'bare-model', 'codebuddy/DIFFERENT-model')
    seedDispatch(today, 1, 'exec-bad', 'task-bad')
    seedTurnUsage(today, 20, 10, 'exec-bad', 'task-bad')
    // resolved_profile only (no dispatch snapshot): must not create a model row.
    seedTask('task-rp', 'rp', today, 'done')
    seedExecutionResolved('exec-rp', 'policy-rp', 'good-model', 'task-rp')
    seedDispatch(today, 1, 'exec-rp', 'task-rp')
    seedTurnUsage(today, 30, 15, 'exec-rp', 'task-rp')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    for (const w of result.windows ?? []) {
      assert.equal(w.dispatchCount, 4, 'overall dispatch count still includes omitted rows')
      assert.equal(w.totalTokens, 150 + 30 + 45, 'overall totalTokens still includes omitted usage')
      assert.equal(w.byProfile.length, 1, 'only the eligible model row surfaces')
      assert.deepEqual(w.byProfile[0], { profile: 'codebuddy/good-model', model: 'codebuddy/good-model', runCount: 2, totalTokens: 150 })
    }
    assert.equal(result.byProfile.length, 1)
    closeTestDb()
  })

  it('weighted TPS ignores failure, no-usage, zero-output, zero-duration, and invalid-contract samples', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-tps', 'tps', today, 'done')
    seedExecutionResolved('exec-tps', 'policy', 'coding', 'task-tps')
    seedAttemptDispatch('exec-tps', 'task-tps', 'codebuddy', 'm', 'codebuddy/m')
    // Valid contract: drives TPS (output 1000, duration 2000).
    seedUsageWithDuration(today, 10, 1000, 2000, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    // Zero-output valid contract: excluded from the TPS numerator/denominator.
    seedUsageWithDuration(today, 10, 0, 1000, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    // Zero-duration valid contract: excluded.
    seedUsageWithDuration(today, 10, 500, 0, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    // Invalid contract (v0): excluded.
    seedUsageWithDuration(today, 10, 500, 500, 'agent_turn', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v0')
    // Wrong token scope: excluded.
    seedUsageWithDuration(today, 10, 500, 500, 'model_output', 'exec-tps', 'task-tps', 'agent_turn', 'agent_turn_v1')
    // Plain turn_usage with no TPS contract: excluded from TPS, still in totalTokens.
    seedTurnUsage(today, 10, 500, 'exec-tps', 'task-tps')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow)
    const row = result.windows?.[0].byProfile[0]
    assert.ok(row)
    // totalTokens counts every turn_usage (including the zero-output sample); TPS excludes zero-output.
    assert.equal(row.totalTokens, 10 * 6 + 1000 + 0 + 500 * 4)
    // Only the single valid sample drives the weighted TPS: 1000 * 1000 / 2000 = 500.
    assert.equal(row.averageTps, 500)
    closeTestDb()
  })

  it('emits model_display_name only when every contributing provider resolves to the same model name', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'codebuddy', 'shared', 'codebuddy/shared')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'cursor', 'shared', 'cursor/shared')
    seedDispatch(today, 1, 'exec-b', 'task-b')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider, model) => {
        if (model !== 'shared') return undefined
        return {
          provider_display_name: provider === 'codebuddy' ? 'CodeBuddy' : 'Cursor',
          model_display_name: provider === 'codebuddy' ? 'Flash' : 'Different',
          stats_model_key: 'canonical:shared-v1',
          stats_model_id: 'shared-v1',
          stats_model_display_name: provider === 'codebuddy' ? 'Flash' : 'Different',
        }
      },
    })
    assert.equal(result.byProfile.length, 1)
    const item = result.byProfile[0]
    assert.equal('model_display_name' in item, false, 'conflicting provider model names suppress the model display name')
    assert.deepEqual(item.provider_display_names, ['CodeBuddy', 'Cursor'])
    const wrow = result.windows?.[0].byProfile[0]
    assert.ok(wrow)
    assert.equal('model_display_name' in wrow, false)
    assert.deepEqual(wrow.provider_display_names, ['CodeBuddy', 'Cursor'])
    closeTestDb()
  })

  it('emits model_display_name when all contributing providers resolve to the same model name', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'codebuddy', 'shared', 'codebuddy/shared')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'cursor', 'shared', 'cursor/shared')
    seedDispatch(today, 1, 'exec-b', 'task-b')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider, model) => {
        if (model !== 'shared') return undefined
        return {
          provider_display_name: provider === 'codebuddy' ? 'CodeBuddy' : 'Cursor',
          model_display_name: 'Flash',
          stats_model_key: 'canonical:shared-v1',
          stats_model_id: 'shared-v1',
          stats_model_display_name: 'Flash',
        }
      },
    })
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].model_display_name, 'Flash')
    assert.deepEqual(result.byProfile[0].provider_display_names, ['CodeBuddy', 'Cursor'])
    closeTestDb()
  })

  it('de-duplicates exact provider display names deterministically for a model', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-a', 'ta', today, 'done')
    seedExecution('exec-a', 'pa', 'task-a')
    seedAttemptDispatch('exec-a', 'task-a', 'codebuddy', 'm', 'codebuddy/m')
    seedDispatch(today, 1, 'exec-a', 'task-a')
    seedTask('task-b', 'tb', today, 'done')
    seedExecution('exec-b', 'pb', 'task-b')
    seedAttemptDispatch('exec-b', 'task-b', 'codebuddy', 'm', 'codebuddy/m')
    seedDispatch(today, 1, 'exec-b', 'task-b')
    const result = readStatsSummary({ days: 31, limit: 10 }, fixedNow, {
      resolveDisplayNames: (provider) => provider === 'codebuddy'
        ? { provider_display_name: 'CodeBuddy', model_display_name: 'M' }
        : undefined,
    })
    assert.equal(result.byProfile.length, 1)
    assert.deepEqual(result.byProfile[0].provider_display_names, ['CodeBuddy'], 'same provider name is de-duplicated')
    assert.equal(result.byProfile[0].model_display_name, 'M')
    assert.deepEqual(result.windows?.[0].byProfile[0].provider_display_names, ['CodeBuddy'])
    closeTestDb()
  })
})
