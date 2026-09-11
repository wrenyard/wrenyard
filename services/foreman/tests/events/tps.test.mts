import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { run as dbRun } from '../../lib/db/connection.mts'
import {
  estimateTps,
  readExecutionTpsSamples,
  readLocalSpeedSamples,
  readTaskTps,
} from '../../lib/events/tps.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

const BASE = Date.parse('2026-07-01T00:00:00.000Z')

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Seeds a completed successful execution; wall time is irrelevant to TPS. */
function seedExecution(params: {
  executionId: string
  taskId: string
  startedMs: number
  endedMs: number
  status?: string
}): void {
  dbRun(
    `INSERT INTO executions
       (id, task_id, profile, permission, cwd, prompt, status, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, 'default', 'edit', '/tmp', 'p', ?, ?, ?, ?, ?)`,
    params.executionId,
    params.taskId,
    params.status ?? 'done',
    iso(params.startedMs),
    iso(params.endedMs),
    iso(params.startedMs),
    iso(params.endedMs),
  )
}

function seedTask(taskId: string): void {
  dbRun(
    `INSERT INTO tasks (id, template, status, created_at, updated_at)
     VALUES (?, 'task', 'done', ?, ?)`,
    taskId,
    iso(BASE),
    iso(BASE),
  )
}

function seedDispatch(executionId: string, taskRunId: string, provider: string, model: string, client = 'claude'): void {
  dbRun(
    `INSERT INTO task_run_attempt_dispatch
       (execution_id, task_run_id, requested_agent_runtime, profile, client, provider, model, model_id, mode, created_at, updated_at)
     VALUES (?, ?, 'agent', 'p', ?, ?, ?, ?, 'native', ?, ?)`,
    executionId,
    taskRunId,
    client,
    provider,
    model,
    `${provider}/${model}`,
    iso(BASE),
    iso(BASE),
  )
}

interface UsageOptions {
  output: number
  durationMs?: number | null
  model?: string
  tokenScope?: string | null
  durationScope?: string | null
  tpsContract?: string | null
  seq?: number
}

/** Seeds a normalized response-paired usage event. */
function seedUsage(executionId: string, taskId: string, o: UsageOptions): void {
  const seq = o.seq ?? 0
  const data: Record<string, unknown> = {
    token_scope: o.tokenScope === undefined ? 'agent_turn' : o.tokenScope,
    duration_scope: o.durationScope === undefined ? 'agent_turn' : o.durationScope,
    tps_sampling_contract: o.tpsContract === undefined ? 'response_v1' : o.tpsContract,
    input_tokens: 10,
    output_tokens: o.output,
  }
  if (o.tpsContract === undefined && o.tokenScope === undefined && o.durationScope === undefined) {
    const first = BASE + seq * 20_000 + 1
    const sample: Record<string, unknown> = {
      response_id: `${executionId}-response-${seq}`,
      model: o.model ?? 'sonnet',
      output_tokens: o.output,
      first_token_at_ms: first,
    }
    if (o.durationMs !== null) sample.completed_at_ms = first + (o.durationMs ?? 10_000)
    data.tps_samples = [sample]
  }
  if (o.durationMs !== null && o.durationMs !== undefined) data.duration_ms = o.durationMs
  dbRun(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId,
    taskId,
    seq,
    iso(BASE),
    JSON.stringify(data),
    iso(BASE),
  )
}

function seedResponseUsage(executionId: string, taskId: string, samples: unknown[], seq = 0): void {
  dbRun(
    `INSERT INTO events (execution_id, task_id, seq, type, timestamp, data, created_at)
     VALUES (?, ?, ?, 'turn_usage', ?, ?, ?)`,
    executionId,
    taskId,
    seq,
    iso(BASE),
    JSON.stringify({ tps_sampling_contract: 'response_v1', tps_samples: samples }),
    iso(BASE),
  )
}

/** One execution with a given output and paired generation durations. */
function seedSample(params: {
  taskId: string
  executionId: string
  provider: string
  model: string
  startedMs: number
  endedMs: number
  outputs: number[]
  client?: string
  status?: string
}): void {
  seedTask(params.taskId)
  seedExecution({
    executionId: params.executionId,
    taskId: params.taskId,
    startedMs: params.startedMs,
    endedMs: params.endedMs,
    status: params.status,
  })
  seedDispatch(params.executionId, params.taskId, params.provider, params.model, params.client)
  params.outputs.forEach((output, index) => {
    seedUsage(params.executionId, params.taskId, { output, model: params.model, seq: index })
  })
}

describe('readExecutionTpsSamples / TPS denominator', () => {
  it('uses paired generation time and ignores the large execution wall interval', () => {
    initTestDb()
    // The execution runs for 392914ms, while the paired samples total 8075ms.
    seedTask('task-hist')
    seedExecution({ executionId: 'exec-hist', taskId: 'task-hist', startedMs: BASE, endedMs: BASE + 392914 })
    seedDispatch('exec-hist', 'task-hist', 'anthropic', 'sonnet')
    seedUsage('exec-hist', 'task-hist', { output: 20000, durationMs: 4000, seq: 0 })
    seedUsage('exec-hist', 'task-hist', { output: 21094, durationMs: 4075, seq: 1 })

    const samples = readExecutionTpsSamples()
    assert.equal(samples.length, 1)
    const sample = samples[0]
    assert.equal(sample.outputTokens, 41094)
    assert.equal(sample.durationMs, 8075)
    assert.equal(sample.tps, (1000 * 41094) / 8075)
    assert.ok(Math.abs(sample.tps - 5089.0) < 0.1, `expected ~5089.0 TPS, got ${sample.tps}`)
    closeTestDb()
  })

  it('sums paired responses exactly once per execution', () => {
    initTestDb()
    seedTask('task-repeat')
    seedExecution({ executionId: 'exec-repeat', taskId: 'task-repeat', startedMs: BASE, endedMs: BASE + 10000 })
    seedDispatch('exec-repeat', 'task-repeat', 'anthropic', 'sonnet')
    seedUsage('exec-repeat', 'task-repeat', { output: 100, seq: 0 })
    seedUsage('exec-repeat', 'task-repeat', { output: 100, seq: 1 })
    seedUsage('exec-repeat', 'task-repeat', { output: 100, seq: 2 })

    const samples = readExecutionTpsSamples()
    assert.equal(samples.length, 1)
    assert.equal(samples[0].outputTokens, 300)
    // 300 / 30000ms -> 10 TPS.
    assert.equal(samples[0].durationMs, 30000)
    assert.equal(samples[0].tps, 10)
    closeTestDb()
  })

  it('omits failed, cancelled, and incomplete runs and runs without a complete dated interval', () => {
    initTestDb()
    seedSample({ taskId: 't-done', executionId: 'e-done', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [500] })
    seedSample({ taskId: 't-failed', executionId: 'e-failed', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [500], status: 'failed' })
    seedSample({ taskId: 't-cancelled', executionId: 'e-cancelled', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [500], status: 'cancelled' })
    // Running (incomplete) execution is excluded.
    seedSample({ taskId: 't-running', executionId: 'e-running', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [500], status: 'running' })
    // Done but no events at all: no sample.
    seedTask('t-noevent')
    seedExecution({ executionId: 'e-noevent', taskId: 't-noevent', startedMs: BASE, endedMs: BASE + 10000 })
    seedDispatch('e-noevent', 't-noevent', 'anthropic', 'sonnet')

    const samples = readExecutionTpsSamples()
    assert.equal(samples.length, 1)
    assert.equal(samples[0].executionId, 'e-done')
    closeTestDb()
  })

  it('does not use execution wall time as the denominator', () => {
    initTestDb()
    seedTask('task-native')
    // Execution ran 20000ms; paired generation totals 2000ms.
    seedExecution({ executionId: 'exec-native', taskId: 'task-native', startedMs: BASE, endedMs: BASE + 20000 })
    seedDispatch('exec-native', 'task-native', 'anthropic', 'sonnet')
    seedUsage('exec-native', 'task-native', { output: 1000, durationMs: 1000, seq: 0 })
    seedUsage('exec-native', 'task-native', { output: 1000, durationMs: 1000, seq: 1 })

    const samples = readExecutionTpsSamples()
    assert.equal(samples[0].durationMs, 2000)
    assert.equal(samples[0].tps, 1000)
    closeTestDb()
  })

  it('maps legacy codex/codex-spark provider ids to chatgpt without merging models', () => {
    initTestDb()
    seedSample({ taskId: 't-codex', executionId: 'e-codex', provider: 'codex', model: 'gpt-5', startedMs: BASE, endedMs: BASE + 10000, outputs: [500] })
    seedSample({ taskId: 't-spark', executionId: 'e-spark', provider: 'codex-spark', model: 'gpt-5', startedMs: BASE, endedMs: BASE + 10000, outputs: [500] })

    const samples = readExecutionTpsSamples()
    assert.equal(samples.length, 2)
    for (const sample of samples) assert.equal(sample.provider, 'chatgpt')
    // Distinct model versions are never merged.
    assert.deepEqual(samples.map((s) => s.model).sort(), ['gpt-5', 'gpt-5'])
    closeTestDb()
  })

  it('bounds samples by time window and by task id', () => {
    initTestDb()
    seedSample({ taskId: 't-a', executionId: 'e-a', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [500] })
    seedSample({ taskId: 't-b', executionId: 'e-b', provider: 'anthropic', model: 'sonnet', startedMs: BASE + 86400_000, endedMs: BASE + 86400_000 + 10000, outputs: [500] })

    const windowed = readExecutionTpsSamples({ startAt: iso(BASE), endAt: iso(BASE + 20000) })
    assert.equal(windowed.length, 1)
    assert.equal(windowed[0].executionId, 'e-a')

    const byTask = readExecutionTpsSamples({ taskId: 't-b' })
    assert.equal(byTask.length, 1)
    assert.equal(byTask[0].executionId, 'e-b')
    closeTestDb()
  })

  it('returns nothing when paired timing is not finite positive', () => {
    initTestDb()
    seedTask('task-zero')
    seedExecution({ executionId: 'exec-zero', taskId: 'task-zero', startedMs: BASE, endedMs: BASE })
    seedDispatch('exec-zero', 'task-zero', 'anthropic', 'sonnet')
    seedUsage('exec-zero', 'task-zero', { output: 500, durationMs: 0 })
    assert.equal(readExecutionTpsSamples().length, 0)
    closeTestDb()
  })

  it('ignores legacy unmarked events and never infers speed from them', () => {
    initTestDb()
    seedTask('task-scope')
    seedExecution({ executionId: 'exec-scope', taskId: 'task-scope', startedMs: BASE, endedMs: BASE + 10000 })
    seedDispatch('exec-scope', 'task-scope', 'anthropic', 'sonnet')
    seedUsage('exec-scope', 'task-scope', { output: 500, tokenScope: 'agent_turn_cumulative', seq: 0 })
    seedUsage('exec-scope', 'task-scope', { output: 500, tokenScope: 'model_output', seq: 1 })
    // Non-additive provenance invalidates the execution rather than under-counting.
    assert.equal(readExecutionTpsSamples().length, 0)
    closeTestDb()
  })

  it('uses a ratio of paired sums, not an arithmetic mean of response rates', () => {
    initTestDb()
    seedTask('task-ratio')
    seedExecution({ executionId: 'exec-ratio', taskId: 'task-ratio', startedMs: BASE, endedMs: BASE + 90000 })
    seedDispatch('exec-ratio', 'task-ratio', 'anthropic', 'sonnet')
    seedUsage('exec-ratio', 'task-ratio', { output: 300, durationMs: 10000, seq: 0 })
    seedUsage('exec-ratio', 'task-ratio', { output: 300, durationMs: 30000, seq: 1 })
    const sample = readExecutionTpsSamples()[0]
    assert.equal(sample.outputTokens, 600)
    assert.equal(sample.durationMs, 40000)
    assert.equal(sample.tps, 15)
    closeTestDb()
  })

  it('omits a response with missing timing without borrowing its tokens', () => {
    initTestDb()
    seedTask('task-missing-timing')
    seedExecution({ executionId: 'exec-missing-timing', taskId: 'task-missing-timing', startedMs: BASE, endedMs: BASE + 90000 })
    seedDispatch('exec-missing-timing', 'task-missing-timing', 'anthropic', 'sonnet')
    seedResponseUsage('exec-missing-timing', 'task-missing-timing', [
      { response_id: 'good', model: 'sonnet', output_tokens: 300, first_token_at_ms: BASE + 1, completed_at_ms: BASE + 10001 },
      { response_id: 'missing', model: 'sonnet', output_tokens: 9000 },
    ])
    const sample = readExecutionTpsSamples()[0]
    assert.equal(sample.outputTokens, 300)
    assert.equal(sample.durationMs, 10000)
    closeTestDb()
  })

  it('deduplicates identical response IDs and rejects conflicting duplicates', () => {
    initTestDb()
    seedTask('task-duplicates')
    seedExecution({ executionId: 'exec-dedup', taskId: 'task-duplicates', startedMs: BASE, endedMs: BASE + 90000 })
    seedDispatch('exec-dedup', 'task-duplicates', 'anthropic', 'sonnet')
    const response = { response_id: 'same', model: 'sonnet', output_tokens: 300, first_token_at_ms: BASE + 1, completed_at_ms: BASE + 10001 }
    seedResponseUsage('exec-dedup', 'task-duplicates', [response, response])
    seedResponseUsage('exec-dedup', 'task-duplicates', [response], 1)
    assert.equal(readExecutionTpsSamples()[0].outputTokens, 300)

    seedExecution({ executionId: 'exec-conflict', taskId: 'task-duplicates', startedMs: BASE, endedMs: BASE + 90000 })
    seedDispatch('exec-conflict', 'task-duplicates', 'anthropic', 'sonnet')
    seedResponseUsage('exec-conflict', 'task-duplicates', [response])
    seedResponseUsage('exec-conflict', 'task-duplicates', [{ ...response, output_tokens: 301 }], 1)
    assert.equal(readExecutionTpsSamples().some((sample) => sample.executionId === 'exec-conflict'), false)
    closeTestDb()
  })

  it('maps only registered provider wire identities, never a different or legacy model', () => {
    initTestDb()
    seedTask('wire-task')
    for (const [id, provider, wire] of [
      ['wire-good', 'codebuddy', 'deepseek-v4.1-flash-ioa'],
      ['wire-wrong-provider', 'other', 'deepseek-v4.1-flash-ioa'],
      ['wire-old', 'codebuddy', 'deepseek-v4-flash'],
    ]) {
      seedExecution({ executionId: id, taskId: 'wire-task', startedMs: BASE, endedMs: BASE + 90000 })
      seedDispatch(id, 'wire-task', provider, 'deepseek-v4.1-flash')
      seedResponseUsage(id, 'wire-task', [{ response_id: 'r1', model: wire, output_tokens: 500, first_token_at_ms: BASE + 1, completed_at_ms: BASE + 10001 }])
    }
    assert.deepEqual(readExecutionTpsSamples().map(sample => sample.executionId), ['wire-good'])
    closeTestDb()
  })

  it('rejects samples whose source model differs from dispatch model', () => {
    initTestDb()
    seedTask('task-model')
    seedExecution({ executionId: 'exec-model', taskId: 'task-model', startedMs: BASE, endedMs: BASE + 90000 })
    seedDispatch('exec-model', 'task-model', 'anthropic', 'sonnet')
    seedResponseUsage('exec-model', 'task-model', [{
      response_id: 'wrong-model', model: 'opus', output_tokens: 500,
      first_token_at_ms: BASE + 1, completed_at_ms: BASE + 10001,
    }])
    assert.equal(readExecutionTpsSamples().length, 0)
    closeTestDb()
  })
})

describe('estimateTps', () => {
  function fakeSample(outputTokens: number, durationMs: number, endedAtMs: number, id: string) {
    return {
      executionId: id,
      taskId: 't',
      provider: 'anthropic',
      model: 'sonnet',
      modelId: 'anthropic/sonnet',
      endedAt: iso(endedAtMs),
      outputTokens,
      durationMs,
      tps: (1000 * outputTokens) / durationMs,
    }
  }

  it('requires at least 3 samples and excludes tiny outputs and short durations', () => {
    const tooFew = [
      fakeSample(1000, 10000, BASE, 'a'),
      fakeSample(1000, 10000, BASE + 1, 'b'),
    ]
    assert.equal(estimateTps(tooFew), undefined)

    const filtered = [
      fakeSample(1000, 10000, BASE, 'a'),
      fakeSample(1000, 10000, BASE + 1, 'b'),
      fakeSample(1000, 10000, BASE + 2, 'c'),
      // Excluded: output below 256.
      fakeSample(100, 10000, BASE + 3, 'tiny'),
      // Excluded: duration below 5000ms.
      fakeSample(5000, 4000, BASE + 4, 'short'),
    ]
    const estimate = estimateTps(filtered)
    assert.ok(estimate)
    assert.equal(estimate.sampleCount, 3)
    assert.equal(estimate.tps, 100)
    closeTestDb()
  })

  it('is robust to a huge/slow outlier because it is the median', () => {
    const samples = [
      fakeSample(1000, 10000, BASE, 'a'), // 100 TPS
      fakeSample(1200, 10000, BASE + 1, 'b'), // 120 TPS
      fakeSample(1100, 10000, BASE + 2, 'c'), // 110 TPS
      fakeSample(500, 1000_000, BASE + 3, 'outlier'), // 0.5 TPS with sufficient output
    ]
    const estimate = estimateTps(samples)
    assert.ok(estimate)
    // Median of [0.5, 100, 110, 120] -> average of central pair (100,110) = 105.
    assert.equal(estimate.tps, 105)
    closeTestDb()
  })

  it('keeps only the newest 50 samples by endedAt', () => {
    const samples = []
    for (let i = 0; i < 60; i++) {
      // Newest samples all 200 TPS; the oldest 10 would be 30 TPS if included.
      const tps = i < 10 ? 30 : 200
      samples.push(fakeSample(tps * 10, 10000, BASE + i * 1000, `s${i}`))
    }
    const estimate = estimateTps(samples)
    assert.ok(estimate)
    assert.equal(estimate.sampleCount, 50)
    assert.equal(estimate.tps, 200)
    closeTestDb()
  })

  it('averages the central pair for an even sample count', () => {
    const samples = [
      fakeSample(1000, 10000, BASE, 'a'), // 100
      fakeSample(2000, 10000, BASE + 1, 'b'), // 200
      fakeSample(3000, 10000, BASE + 2, 'c'), // 300
      fakeSample(4000, 10000, BASE + 3, 'd'), // 400
    ]
    const estimate = estimateTps(samples)
    assert.ok(estimate)
    assert.equal(estimate.tps, 250)
    closeTestDb()
  })
})

describe('readLocalSpeedSamples', () => {
  it('groups exact provider+model across clients and is suitable resolver input', () => {
    initTestDb()
    // Same provider/model from two different clients must share one grouped sample.
    seedSample({ taskId: 't-c1', executionId: 'e-c1', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [1000], client: 'claude' })
    seedSample({ taskId: 't-c2', executionId: 'e-c2', provider: 'anthropic', model: 'sonnet', startedMs: BASE + 1000, endedMs: BASE + 11000, outputs: [1000], client: 'codex' })
    seedSample({ taskId: 't-c3', executionId: 'e-c3', provider: 'anthropic', model: 'sonnet', startedMs: BASE + 2000, endedMs: BASE + 12000, outputs: [1000], client: 'cursor' })
    // A different model is a separate group.
    seedSample({ taskId: 't-other', executionId: 'e-other', provider: 'anthropic', model: 'haiku', startedMs: BASE + 3000, endedMs: BASE + 13000, outputs: [1000], client: 'claude' })

    const now = new Date(BASE + 20000)
    const samples = readLocalSpeedSamples(now)
    const sonnet = samples.find((s) => s.model === 'sonnet')
    assert.ok(sonnet)
    assert.equal(sonnet.provider, 'anthropic')
    assert.equal(sonnet.tps, 100)
    assert.equal(sonnet.sampleCount, 3)
    // Shape matches the LocalSpeedSample the resolver consumes.
    assert.equal(typeof sonnet.checkedAt, 'string')
    closeTestDb()
  })

  it('excludes future-dated samples and samples older than 31 days', () => {
    initTestDb()
    const nowMs = BASE + 40 * 86400_000
    // Fresh sample.
    for (let i = 0; i < 3; i++) seedSample({ taskId: `t-fresh-${i}`, executionId: `e-fresh-${i}`, provider: 'anthropic', model: 'sonnet', startedMs: nowMs - 20000 - i * 1000, endedMs: nowMs - 10000 - i * 1000, outputs: [1000] })
    // Future-dated sample.
    seedSample({ taskId: 't-future', executionId: 'e-future', provider: 'anthropic', model: 'sonnet', startedMs: nowMs + 1000, endedMs: nowMs + 11000, outputs: [1000] })
    // Older than 31 days.
    seedSample({ taskId: 't-old', executionId: 'e-old', provider: 'anthropic', model: 'sonnet', startedMs: BASE, endedMs: BASE + 10000, outputs: [1000] })

    const samples = readLocalSpeedSamples(new Date(nowMs))
    const checkedAtMs = Date.parse(samples[0].checkedAt)
    assert.equal(samples.length, 1)
    assert.ok(checkedAtMs <= nowMs && checkedAtMs >= nowMs - 31 * 86400_000)
    assert.equal(samples[0].sampleCount, 3)
    closeTestDb()
  })
})

describe('readTaskTps', () => {
  it('sums each attempt once and derives the corrected rate without trusting native durations', () => {
    initTestDb()
    seedTask('task-sum')
    seedExecution({ executionId: 'e1', taskId: 'task-sum', startedMs: BASE, endedMs: BASE + 10000 })
    seedExecution({ executionId: 'e2', taskId: 'task-sum', startedMs: BASE + 10000, endedMs: BASE + 30000 })
    seedDispatch('e1', 'task-sum', 'anthropic', 'sonnet')
    seedDispatch('e2', 'task-sum', 'anthropic', 'sonnet')
    seedUsage('e1', 'task-sum', { output: 1000, durationMs: 10000 })
    seedUsage('e2', 'task-sum', { output: 2000, durationMs: 20000 })

    const tps = readTaskTps('task-sum')
    assert.ok(tps)
    assert.equal(tps.outputTokens, 3000)
    assert.equal(tps.durationMs, 30000)
    assert.equal(tps.tps, 100)
    closeTestDb()
  })

  it('returns undefined when any attempt is not done or lacks a complete sample', () => {
    initTestDb()
    seedTask('task-partial')
    seedExecution({ executionId: 'e1', taskId: 'task-partial', startedMs: BASE, endedMs: BASE + 10000 })
    seedExecution({ executionId: 'e2', taskId: 'task-partial', startedMs: BASE, endedMs: BASE + 10000, status: 'failed' })
    seedDispatch('e1', 'task-partial', 'anthropic', 'sonnet')
    seedDispatch('e2', 'task-partial', 'anthropic', 'sonnet')
    seedUsage('e1', 'task-partial', { output: 1000 })
    seedUsage('e2', 'task-partial', { output: 1000 })

    assert.equal(readTaskTps('task-partial'), undefined)

    // An attempt with no usage events also makes task TPS unknown.
    seedTask('task-missing-events')
    seedExecution({ executionId: 'e-only', taskId: 'task-missing-events', startedMs: BASE, endedMs: BASE + 10000 })
    seedExecution({ executionId: 'e-empty', taskId: 'task-missing-events', startedMs: BASE, endedMs: BASE + 10000 })
    seedDispatch('e-only', 'task-missing-events', 'anthropic', 'sonnet')
    seedDispatch('e-empty', 'task-missing-events', 'anthropic', 'sonnet')
    seedUsage('e-only', 'task-missing-events', { output: 1000 })
    assert.equal(readTaskTps('task-missing-events'), undefined)
    closeTestDb()
  })

  it('returns undefined for a task with no executions', () => {
    initTestDb()
    seedTask('task-none')
    assert.equal(readTaskTps('task-none'), undefined)
    closeTestDb()
  })
})
