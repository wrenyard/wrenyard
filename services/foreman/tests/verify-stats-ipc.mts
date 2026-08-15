import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { INVALID_PARAMS } from '../lib/protocol/errors.mts'
import { registerCoreHandlers } from '../lib/server/handlers/core.mts'
import { RpcRouter } from '../lib/server/rpc-router.mts'
import { query, run } from '../lib/db/connection.mts'
import { closeTestDb, initTestDb } from './helpers/test-db.mts'

let router: RpcRouter
let requestCounter = 0

beforeEach(() => {
  requestCounter = 0
  initTestDb()
  router = new RpcRouter()
  registerCoreHandlers(router, {
    startedAt: Date.now(),
    workspaceRoot: process.cwd(),
  })
})

afterEach(() => {
  closeTestDb()
})

describe('stats.summary RPC smoke', () => {
  it('returns validated stats.summary payload and keeps today in sync with stats.today', async () => {
    const daySample = localNoonIso()

    const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
    const taskStartIso = new Date(dayStart.getTime() + 9 * 3600_000).toISOString()
    const taskEndIso = new Date(dayStart.getTime() + 11 * 3600_000).toISOString()
    seedTask('task-commit', 'commit', 'done', taskStartIso, taskEndIso)
    seedExecution('exec-verify', 'coding', 'task-commit')
    seedDispatch(daySample, 2, 'exec-verify', 'task-commit')
    seedTurnUsage(daySample, 120, 34, 'exec-verify', 'task-commit')

    const today = (await call('stats.today', {})) as {
      source: 'sqlite'
      dayKey: string
      startAt: string
      endAt: string
      dispatchCount: number
      inputTokens: number
      outputTokens: number
      totalTokens: number
    }
    const summary = (await call('stats.summary', { days: 2, limit: 5 })) as {
      source: 'sqlite'
      today: {
        dayKey: string
        startAt: string
        endAt: string
        dispatchCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        outcomes: { done: number; failed: number; cancelled: number }
      }
      byProfile: Array<{
        profile: string
        dispatchCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }>
      byTask: Array<{
        taskName: string
        dispatchCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }>
      totalTaskDurationMs: number
      byTaskDuration: Array<{ taskName: string; durationMs: number }>
      daily: Array<{
        dayKey: string
        dispatchCount: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }>
      windows: Array<{
        period: '24h' | '7d' | '1mo'
        startAt: string
        endAt: string
        dispatchCount: number
        totalTokens: number
        byProfile: Array<{
          profile: string
          runCount: number
          totalTokens: number
          averageTps?: number
        }>
        taskStats: {
          totalDurationMs: number
          byTask: Array<{
            taskId: string
            source: 'builtin' | 'project'
            runCount: number
            durationMs: number
            averageDurationMs: number
          }>
          builtinTotalDurationMs: number
          byBuiltinTask: Array<{
            taskId: string
            source: 'builtin' | 'project'
            runCount: number
            durationMs: number
            averageDurationMs: number
          }>
        }
      }>
    }

    assert.equal(summary.source, 'sqlite')
    assert.equal(summary.byProfile.length, 1)
    assert.deepEqual(summary.byProfile[0], {
      profile: 'coding',
      dispatchCount: 2,
      inputTokens: 120,
      outputTokens: 34,
      totalTokens: 154,
    })

    assert.equal(summary.byTask.length, 1)
    assert.equal(summary.byTask[0].taskName, 'commit')
    assert.equal(summary.byTask[0].dispatchCount, 2)
    assert.equal(summary.byTask[0].totalTokens, 154)

    // Seeded terminal interval: created 09:00 local, ended 11:00 local → 2h
    assert.equal(summary.totalTaskDurationMs, 2 * 3600_000)
    assert.deepEqual(summary.byTaskDuration, [{ taskName: 'commit', durationMs: 2 * 3600_000 }])

    assert.equal(summary.daily.length, 2)
    assert.equal(summary.today.dayKey, today.dayKey)
    assert.equal(summary.today.startAt, today.startAt)
    assert.equal(summary.today.endAt, today.endAt)
    assert.equal(summary.today.dispatchCount, today.dispatchCount)
    assert.equal(summary.today.inputTokens, today.inputTokens)
    assert.equal(summary.today.outputTokens, today.outputTokens)
    assert.equal(summary.today.totalTokens, today.totalTokens)
    assert.deepEqual(summary.today.outcomes, { done: 1, failed: 0, cancelled: 0 })
    assert.equal(summary.today.totalTokens, 154)

    // Fixed 24h/7d/1mo windows are always emitted in order with valid ranges
    assert.equal(summary.windows.length, 3)
    assert.deepEqual(summary.windows.map((w) => w.period), ['24h', '7d', '1mo'])
    const todayWindow = summary.windows[0]
    assert.equal(todayWindow.startAt, today.startAt)
    assert.equal(todayWindow.endAt, today.endAt)
    assert.equal(todayWindow.dispatchCount, today.dispatchCount)
    assert.equal(todayWindow.totalTokens, today.totalTokens)
    assert.deepEqual(todayWindow.byProfile, [{ profile: 'coding', runCount: 2, totalTokens: 154 }])
    assert.equal(todayWindow.taskStats.totalDurationMs, 2 * 3600_000)
    assert.equal(todayWindow.taskStats.builtinTotalDurationMs, 2 * 3600_000)
    assert.deepEqual(todayWindow.taskStats.byTask, [{
      taskId: 'commit',
      source: 'builtin',
      runCount: 1,
      durationMs: 2 * 3600_000,
      averageDurationMs: 2 * 3600_000,
    }])
  })

  it('classifies builtin, project, and unknown task sources through the validated IPC result', async () => {
    const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
    const hour = 3600_000
    const iso = (ms: number): string => new Date(ms).toISOString()

    // Builtin run bound to a non-null execution project: source must stay builtin.
    seedTaskWithSource('t-builtin-proj', 'explore', 'done', iso(dayStart.getTime() + 9 * hour), iso(dayStart.getTime() + 10 * hour), 'ure/service', 'builtin')
    // Same-id project override: source must be project, excluded from builtin.
    seedTaskWithSource('t-override', 'edit', 'done', iso(dayStart.getTime() + 10 * hour), iso(dayStart.getTime() + 11 * hour), 'app', 'project')
    // Legacy row predating definition_source: reported unknown without guessing.
    seedTaskWithSource('t-legacy', 'legacy', 'done', iso(dayStart.getTime() + 11 * hour), iso(dayStart.getTime() + 12 * hour), 'app', null)

    const summary = (await call('stats.summary', { days: 2, limit: 10 })) as {
      windows: Array<{
        taskStats: {
          byTask: Array<{ taskId: string; source: string; runCount: number; durationMs: number; averageDurationMs: number }>
          builtinTotalDurationMs: number
          byBuiltinTask: Array<{ taskId: string; source: string }>
        }
      }>
    }

    const taskStats = summary.windows[0].taskStats
    const bySource = new Map(taskStats.byTask.map((row) => [row.taskId, row.source]))
    assert.equal(bySource.get('explore'), 'builtin')
    assert.equal(bySource.get('edit'), 'project')
    assert.equal(bySource.get('legacy'), 'unknown')
    assert.equal(taskStats.byTask.length, 3)
    assert.equal(taskStats.builtinTotalDurationMs, hour)
    assert.deepEqual(taskStats.byBuiltinTask, [{ taskId: 'explore', source: 'builtin', runCount: 1, durationMs: hour, averageDurationMs: hour }])
  })

  it('returns INVALID_PARAMS for invalid stats.summary request values', async () => {
    const cases = [
      { days: 0 },
      { days: 32 },
      { limit: 0 },
      { limit: 100 },
      { days: '7' as unknown as number },
      { limit: '20' as unknown as number },
    ]

    for (const params of cases) {
      const response = await router.handleMessage({
        jsonrpc: '2.0',
        method: 'stats.summary',
        params,
        id: nextRequestId('invalid-stats-summary'),
      })

      const error = (response as { error?: { code: number } }).error
      assert(error, 'expected invalid params response')
      assert.equal(error.code, INVALID_PARAMS.code)
    }
  })
})

function localNoonIso(): string {
  const now = new Date()
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    10,
    0,
    0,
    0,
  ).toISOString()
}

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await router.handleMessage({
    jsonrpc: '2.0',
    method,
    params,
    id: nextRequestId(method),
  }) as { result?: unknown; error?: unknown }

  assert.equal(response.error, undefined, JSON.stringify(response.error))
  return response.result
}

function nextRequestId(method: string): string {
  requestCounter += 1
  return `${method}-${requestCounter}`
}

function seedExecution(id: string, profile: string, taskId: string): void {
  run(
    `INSERT INTO executions (id, task_id, profile, resolved_profile, permission, cwd, prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'edit', '/tmp', 'prompt', 'done', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    id,
    taskId,
    profile,
    profile,
  )
}

function seedTaskWithSource(id: string, template: string, status: string, createdIso: string, endedIso: string | null, project: string | null, definitionSource: string | null): void {
  run(
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

function seedTask(id: string, template: string, status: string, createdIso: string, endedIso: string | null): void {
  run(
    `INSERT INTO tasks (id, template, definition_source, status, created_at, updated_at, ended_at)
     VALUES (?, ?, 'builtin', ?, ?, ?, ?)`,
    id,
    template,
    status,
    createdIso,
    createdIso,
    endedIso,
  )
}

function seedDispatch(dayIso: string, count: number, executionId?: string, taskId?: string): void {
  const row = query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const baseSeq = row[0].next_seq

  for (let i = 0; i < count; i++) {
    const sequence = baseSeq + i
    run(
      `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
       VALUES (?, ?, ?, 'dispatch', ?, NULL, ?)`,
      executionId ?? null,
      taskId ?? null,
      sequence,
      dayIso,
      dayIso,
    )
  }
}

function seedTurnUsage(dayIso: string, inputTokens: number, outputTokens: number, executionId?: string, taskId?: string): void {
  const row = query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE execution_id IS ?`,
    executionId ?? null,
  )
  const sequence = row[0].next_seq
  run(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId ?? null,
    taskId ?? null,
    sequence,
    dayIso,
    JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens }),
    dayIso,
  )
}
