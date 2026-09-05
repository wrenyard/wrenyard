import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatsSnapshot } from '../src/stats-snapshot.js';

const today = {
  dayKey: '2026-08-28',
  startAt: '2026-08-27T16:00:00.000Z',
  endAt: '2026-08-28T16:00:00.000Z',
  dispatchCount: 12,
  inputTokens: 3_000,
  outputTokens: 900,
  totalTokens: 3_900,
  source: 'sqlite',
} as const;

test('stats snapshot projects bounded summary data for Desktop', async () => {
  const snapshot = await buildStatsSnapshot(async (method, params) => {
    assert.equal(method, 'stats.summary');
    assert.deepEqual(params, { days: 365, limit: 20 });
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 9, failed: 1, cancelled: 1, running: 1 } },
      daily: [{ ...today, outcomes: { done: 9, failed: 1, cancelled: 1 } }],
      byProfile: [{ profile: 'kimi', dispatchCount: 8, inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
      byTask: [{ taskName: 'edit', dispatchCount: 6, inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
      windows: [{
        period: '24h',
        startAt: today.startAt,
        endAt: today.endAt,
        dispatchCount: 12,
        totalTokens: 3_900,
        byProfile: [{ profile: 'kimi', runCount: 8, totalTokens: 3_000, averageTps: 12.5 }],
        taskStats: {
          totalDurationMs: 120_000,
          byTask: [{ taskId: 'edit', source: 'builtin', runCount: 6, durationMs: 80_000, averageDurationMs: 13_333 }],
          builtinTotalDurationMs: 80_000,
          byBuiltinTask: [],
        },
      }],
    };
  });

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.source, 'summary');
  assert.deepEqual(snapshot.byProfile, [{ name: 'kimi', dispatchCount: 8, totalTokens: 3 }]);
  assert.deepEqual(snapshot.byTask, [{ name: 'edit', dispatchCount: 6, totalTokens: 3 }]);
  assert.equal(snapshot.windows[0].totalDurationMs, 120_000);
  assert.equal(snapshot.windows[0].builtinTotalDurationMs, 80_000);
  assert.equal(snapshot.windows[0].byTask[0].averageDurationMs, 13_333);
  assert.deepEqual(snapshot.windows[0].byBuiltinTask, []);
});

test('stats snapshot falls back to stats.today when summary is unavailable', async () => {
  const calls: string[] = [];
  const snapshot = await buildStatsSnapshot(async (method) => {
    calls.push(method);
    if (method === 'stats.summary') throw new Error('method unavailable');
    return today;
  });

  assert.deepEqual(calls, ['stats.summary', 'stats.today']);
  assert.equal(snapshot.source, 'today');
  assert.deepEqual(snapshot.today, {
    dayKey: today.dayKey,
    startAt: today.startAt,
    endAt: today.endAt,
    dispatchCount: today.dispatchCount,
    inputTokens: today.inputTokens,
    outputTokens: today.outputTokens,
    totalTokens: today.totalTokens,
  });
  assert.equal(snapshot.daily.length, 1);
  assert.deepEqual(snapshot.windows, []);
});

test('stats snapshot rejects malformed projections and caps renderer arrays', async () => {
  const snapshot = await buildStatsSnapshot(async (method) => {
    if (method === 'stats.today') return { ...today, totalTokens: -1 };
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
      daily: Array.from({ length: 400 }, (_, index) => ({ ...today, dayKey: `day-${index}` })),
      byProfile: Array.from({ length: 100 }, (_, index) => ({ profile: `p-${index}`, dispatchCount: 1, totalTokens: 1 })),
      byTask: [],
      windows: [],
    };
  });

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.daily.length, 365);
  assert.equal(snapshot.byProfile.length, 20);

  const unavailable = await buildStatsSnapshot(async () => ({ ...today, source: 'memory' }));
  assert.deepEqual(unavailable, {
    status: 'unavailable',
    source: 'unavailable',
    today: null,
    daily: [],
    byProfile: [],
    byTask: [],
    windows: [],
    recentTaskRuns: [],
  });
});

test('stats snapshot maps recentRuns without inventing calculations', async () => {
  const snapshot = await buildStatsSnapshot(async (method) => {
    if (method === 'stats.today') throw new Error('method unavailable');
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
      daily: [],
      byProfile: [],
      byTask: [],
      windows: [],
      recentRuns: [
        {
          task_run_id: 'run-1',
          task: 'edit',
          source: 'builtin',
          status: 'done',
          started_at: '2026-08-28T10:00:00.000Z',
          finished_at: '2026-08-28T10:01:00.000Z',
          resolved: {
            client: 'codebuddy',
            provider: 'kimi',
            profile: 'kimi',
            model: 'kimi-k2',
            model_id: 'kimi/kimi-k2',
            speed: { effective_tps: 18.5, source: 'local_31d', sample_count: 31, expected_tps_met: true },
          },
          usage: {
            completeness: 'complete',
            attempt_count: 1,
            usage_event_count: 2,
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 900,
            total_tokens: 900,
            agent_turn_ms: 48000,
            output_tps: 18.75,
            tps_contract: 'agent_turn_v1',
            reference_cost_usd: 0.0123,
            reference_cost_complete: true,
            reference_cost_basis: 'local-31d',
          },
        },
        {
          task_run_id: 'run-2',
          task: 'build',
          source: 'project',
          status: 'failed',
          resolved_profile: 'unknown',
          resolved: { speed: { effective_tps: 9, source: 'catalog_default', sample_count: null, expected_tps_met: false, degradation_reason: 'cold-start' } },
          usage: {
            completeness: 'partial',
            attempt_count: 3,
            usage_event_count: 1,
            output_tokens: 120,
            total_tokens: 220,
            output_tps: 4.2,
            reference_cost_usd: 0.0044,
            reference_cost_complete: false,
          },
        },
        {
          task_run_id: 'run-3',
          task: 'legacy',
          source: 'unknown',
          status: 'done',
          usage: {
            completeness: 'unavailable',
            attempt_count: 1,
            usage_event_count: 0,
            reference_cost_usd: 0,
            reference_cost_complete: false,
          },
        },
      ],
    };
  });

  assert.equal(snapshot.source, 'summary');
  assert.equal(snapshot.recentTaskRuns.length, 3);

  const complete = snapshot.recentTaskRuns[0];
  assert.equal(complete.taskRunId, 'run-1');
  assert.equal(complete.taskId, 'edit');
  assert.equal(complete.taskName, undefined);
  assert.equal(complete.source, 'builtin');
  assert.equal(complete.status, 'done');
  assert.equal(complete.resolvedProfile, 'kimi');
  assert.equal(complete.resolvedModel, 'kimi-k2');
  assert.equal(complete.resolvedClient, 'codebuddy');
  assert.equal(complete.resolvedProvider, 'kimi');
  assert.equal(complete.resolvedModelId, 'kimi/kimi-k2');
  assert.deepEqual(complete.speed, { effectiveTps: 18.5, source: 'local_31d', sampleCount: 31, expectedTpsMet: true });
  assert.equal(complete.usage.completeness, 'complete');
  assert.equal(complete.usage.referenceCostComplete, true);
  // numeric zero is preserved, not omitted
  assert.equal(complete.usage.inputTokens, 0);
  assert.equal(complete.usage.cachedInputTokens, 0);
  assert.equal(complete.usage.cacheReadInputTokens, 0);
  assert.equal(complete.usage.cacheCreationInputTokens, 0);
  // selection speed is distinct from actual measured TPS
  assert.notEqual(complete.speed?.effectiveTps, complete.usage.outputTps);
  assert.equal(complete.usage.outputTps, 18.75);
  assert.equal(complete.usage.tpsContract, 'agent_turn_v1');
  assert.equal(complete.usage.referenceCostUsd, 0.0123);

  const partial = snapshot.recentTaskRuns[1];
  assert.equal(partial.status, 'failed');
  assert.equal(partial.resolvedProfile, 'unknown');
  assert.equal(partial.speed?.source, 'catalog_default');
  assert.equal(partial.speed?.expectedTpsMet, false);
  assert.equal(partial.speed?.degradationReason, 'cold-start');
  assert.equal(partial.usage.completeness, 'partial');
  assert.equal(partial.usage.referenceCostComplete, false);
  // absent optional numbers remain undefined, not zero
  assert.equal(partial.usage.inputTokens, undefined);
  assert.equal(partial.usage.totalTokens, 220);
  assert.equal(partial.usage.attemptCount, 3);

  const unavailable = snapshot.recentTaskRuns[2];
  assert.equal(unavailable.taskId, 'legacy');
  assert.equal(unavailable.source, 'unknown');
  assert.equal(unavailable.usage.completeness, 'unavailable');
  assert.equal(unavailable.usage.referenceCostComplete, false);
  assert.equal(unavailable.usage.referenceCostUsd, 0);
  assert.equal(unavailable.speed, undefined);
  assert.equal(unavailable.resolvedProfile, undefined);
});

test('stats snapshot retains runs with unknown cost and never fabricates a speed source', async () => {
  const snapshot = await buildStatsSnapshot(async (method) => {
    if (method === 'stats.today') throw new Error('method unavailable');
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
      daily: [],
      byProfile: [],
      byTask: [],
      windows: [],
      recentRuns: [
        {
          task_run_id: 'run-missing-cost',
          task: 'edit',
          usage: {
            completeness: 'partial',
            attempt_count: 2,
            usage_event_count: 1,
            output_tokens: 120,
            total_tokens: 220,
            reference_cost_complete: false,
          },
        },
        {
          task_run_id: 'run-zero-and-bad-source',
          task: 'build',
          usage: {
            completeness: 'complete',
            attempt_count: 1,
            usage_event_count: 1,
            reference_cost_usd: 0,
            reference_cost_complete: true,
          },
          resolved: { speed: { effective_tps: 7, source: 'bogus-source', sample_count: null, expected_tps_met: null } },
        },
      ],
    };
  });

  assert.equal(snapshot.recentTaskRuns.length, 2);

  const missingCost = snapshot.recentTaskRuns[0];
  assert.equal(missingCost.taskRunId, 'run-missing-cost');
  assert.equal(missingCost.usage.referenceCostComplete, false);
  // Absent cost stays absent (undefined), it is not dropped nor substituted.
  assert.equal(missingCost.usage.referenceCostUsd, undefined);
  assert.equal(missingCost.usage.completeness, 'partial');
  assert.equal(missingCost.usage.attemptCount, 2);

  const zeroAndBad = snapshot.recentTaskRuns[1];
  // Real numeric zero cost is preserved, not coerced to undefined.
  assert.equal(zeroAndBad.usage.referenceCostUsd, 0);
  assert.equal(zeroAndBad.usage.referenceCostComplete, true);
  // Invalid/missing speed evidence is omitted rather than fabricating a source.
  assert.equal(zeroAndBad.speed, undefined);
});

test('stats snapshot tolerates missing recentRuns and malformed rows', async () => {
  const snapshot = await buildStatsSnapshot(async (method) => {
    if (method === 'stats.today') throw new Error('method unavailable');
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
      daily: [],
      byProfile: [],
      byTask: [],
      windows: [],
      recentRuns: [
        { task_run_id: 'good', task: 'edit', usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0.001, reference_cost_complete: true } },
        { task: 'missing-run-id', usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0.001, reference_cost_complete: true } },
        { task_run_id: 'missing-usage' },
        { task_run_id: 'bad-cost', task: 'x', usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_complete: true } },
      ],
    };
  });

  assert.equal(snapshot.recentTaskRuns.length, 1);
  assert.equal(snapshot.recentTaskRuns[0].taskRunId, 'good');
  assert.equal(snapshot.recentTaskRuns[0].usage.referenceCostComplete, true);
  assert.equal(snapshot.windows.length, 0);
});
