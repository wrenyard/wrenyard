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
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].profile, 'unknown')
    assert.equal(result.byProfile[0].dispatchCount, 5)
    assert.equal(result.byProfile[0].totalTokens, 0)
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
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].inputTokens, 300)
    assert.equal(result.byProfile[0].outputTokens, 125)
    assert.equal(result.byProfile[0].totalTokens, 425)
    assert.equal(result.byTask.length, 1)
    assert.equal(result.byTask[0].inputTokens, 300)
    assert.equal(result.byTask[0].outputTokens, 125)
    assert.equal(result.byTask[0].totalTokens, 425)
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

  it('groups by execution profile with unknown fallback', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-commit', 'commit', today, 'done')
    seedExecution('exec-1', 'coding', 'task-commit')
    seedDispatch(today, 1, 'exec-1', 'task-commit')
    seedTurnUsage(today, 50, 25, 'exec-1', 'task-commit')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].profile, 'coding')
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
    seedTurnUsage(today, 100, 0, 'exec-1', 'task-1')
    seedTurnUsage(yesterday, 5, 0, 'exec-2', 'task-2')
    const result = readStatsSummary({ days: 2, limit: 1 }, now)
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].profile, 'profile-a')
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
      () => readStatsSummary({ days: 32, limit: 10 }),
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
    assert.equal(result.byProfile.length, 1)
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
    assert.equal(result.byProfile.length, 50)
    assert.equal(result.byTask.length, 50)
    closeTestDb()
  })

  it('applies deterministic tie ordering by profile ascending', () => {
    initTestDb()
    const now = new Date()
    const today = localDayKey(now)
    seedTask('task-x', 'task-x', today, 'done')
    seedTask('task-y', 'task-y', today, 'done')
    seedExecution('exec-a', 'beta', 'task-x')
    seedExecution('exec-b', 'alpha', 'task-y')
    seedTurnUsage(today, 100, 0, 'exec-a', 'task-x')
    seedTurnUsage(today, 100, 0, 'exec-b', 'task-y')
    const result = readStatsSummary({ days: 1, limit: 10 }, now)
    assert.equal(result.byProfile.length, 2)
    assert.equal(result.byProfile[0].profile, 'alpha')
    assert.equal(result.byProfile[1].profile, 'beta')
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

  it('treats blank, whitespace, and missing-execution profile as unknown', () => {
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
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].profile, 'unknown')
    assert.equal(result.byProfile[0].dispatchCount, 3)
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

  it('respects days boundary at 31', () => {
    initTestDb()
    const result = readStatsSummary({ days: 31, limit: 10 })
    assert.equal(result.daily.length, 31)
    closeTestDb()
  })

  it('rejects days greater than maximum', () => {
    initTestDb()
    assert.throws(
      () => readStatsSummary({ days: 32, limit: 10 }),
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
    assert.equal(result.byProfile.length, 1)
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
    seedDispatch('2026-07-18', 5, 'exec-y', 'task-y')
    seedTurnUsage('2026-07-18', 500, 100, 'exec-y', 'task-y')
    // Data from today
    seedTask('task-t', 'today-task', '2026-07-19', 'done')
    seedExecution('exec-t', 'today-profile', 'task-t')
    seedDispatch('2026-07-19', 2, 'exec-t', 'task-t')
    seedTurnUsage('2026-07-19', 50, 10, 'exec-t', 'task-t')
    const result = readStatsSummary({ days: 2, limit: 10 }, fixedNow)
    // Rankings only contain today's data
    assert.equal(result.byProfile.length, 1)
    assert.equal(result.byProfile[0].profile, 'today-profile')
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

  it('groups only resolved profiles and omits NULL resolved_profile rows', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-resolved', 'commit', today, 'done')
    seedExecutionResolved('exec-resolved', 'policy-a', 'coding', 'task-resolved')
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
      assert.equal(w.dispatchCount, 5, `${w.period} dispatchCount includes unresolved dispatches`)
      assert.equal(w.totalTokens, 180, `${w.period} totalTokens includes all usage`)
      assert.equal(w.byProfile.length, 1, `${w.period} groups only resolved profiles`)
      assert.deepEqual(w.byProfile[0], { profile: 'coding', runCount: 2, totalTokens: 150 })
    }
    closeTestDb()
  })

  it('computes weighted average TPS only from the exact agent_turn_v1 contract', () => {
    initTestDb()
    const fixedNow = new Date('2026-07-19T12:00:00.000Z')
    const today = '2026-07-19'
    seedTask('task-tps', 'commit', today, 'done')
    seedExecutionResolved('exec-tps', 'policy-a', 'coding', 'task-tps')
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
    const seedProfile = (id: string, profile: string, tokens: number): void => {
      seedTask(`task-${id}`, `task-${id}`, today, 'done')
      seedExecutionResolved(`exec-${id}`, `policy-${id}`, profile, `task-${id}`)
      seedDispatch(today, 1, `exec-${id}`, `task-${id}`)
      seedTurnUsage(today, tokens, 0, `exec-${id}`, `task-${id}`)
    }
    seedProfile('a', 'profile-a', 100)
    seedProfile('b', 'profile-b', 300)
    seedProfile('c', 'profile-c', 200)

    const result = readStatsSummary({ days: 31, limit: 2 }, fixedNow)
    const byProfile = result.windows?.[0].byProfile
    assert.ok(byProfile)
    assert.equal(byProfile.length, 2)
    assert.deepEqual(byProfile[0], { profile: 'profile-b', runCount: 1, totalTokens: 300 })
    assert.deepEqual(byProfile[1], { profile: 'profile-c', runCount: 1, totalTokens: 200 })
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
})
