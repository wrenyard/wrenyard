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
      windows: [{
        period: '24h',
        startAt: today.startAt,
        endAt: today.endAt,
        dispatchCount: 12,
        totalTokens: 3_900,
        byProfile: [{ model: 'kimi', runCount: 8, totalTokens: 3_000, averageTps: 12.5 }],
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
  assert.equal(snapshot.today?.outcomes?.running, 1);
  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.windows[0]?.totalDurationMs, 120_000);
  assert.equal(snapshot.windows[0]?.builtinTotalDurationMs, 80_000);
  assert.equal(snapshot.windows[0]?.byTask[0]?.averageDurationMs, 13_333);
  assert.deepEqual(snapshot.windows[0]?.byBuiltinTask, []);
});

test('stats snapshot uses only stats.summary and never falls back to stats.today', async () => {
  const calls: string[] = [];
  const snapshot = await buildStatsSnapshot(async (method) => {
    calls.push(method);
    throw new Error('method unavailable');
  });

  assert.deepEqual(calls, ['stats.summary']);
  assert.deepEqual(snapshot, {
    status: 'unavailable',
    today: null,
    daily: [],
    windows: [],
    recentTaskRuns: [],
  });
});

test('stats snapshot rejects malformed projections and caps renderer arrays', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: Array.from({ length: 400 }, (_, index) => ({ ...today, dayKey: `day-${index}` })),
    windows: [],
  }));

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.daily.length, 365);

  // A non-sqlite or missing today projection is unavailable, not an error.
  const unavailable = await buildStatsSnapshot(async () => ({ ...today, source: 'memory' }));
  assert.deepEqual(unavailable, {
    status: 'unavailable',
    today: null,
    daily: [],
    windows: [],
    recentTaskRuns: [],
  });
});

test('stats snapshot maps recentRuns without inventing calculations', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: [],
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
          generation_ms: 48000,
          output_tps: 18.75,
          tps_contract: 'tokenizer_v1',
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
  }));

  assert.equal(snapshot.recentTaskRuns.length, 3);

  const complete = snapshot.recentTaskRuns[0]!;
  assert.equal(complete.taskRunId, 'run-1');
  assert.equal(complete.taskId, 'edit');
  assert.equal(complete.taskName, undefined);
  assert.equal(complete.source, 'builtin');
  assert.equal(complete.status, 'done');
  assert.equal(complete.resolvedProfile, 'kimi');
  assert.deepEqual(complete.speed, { effectiveTps: 18.5, source: 'local_31d', sampleCount: 31, expectedTpsMet: true });
  assert.equal(complete.usage.completeness, 'complete');
  assert.equal(complete.usage.inputTokens, 0);
  assert.notEqual(complete.speed?.effectiveTps, complete.usage.outputTps);
  assert.equal(complete.usage.outputTps, 18.75);
  assert.equal(complete.usage.tpsContract, 'tokenizer_v1');
  assert.equal(complete.usage.referenceCostUsd, 0.0123);

  const partial = snapshot.recentTaskRuns[1]!;
  assert.equal(partial.status, 'failed');
  assert.equal(partial.speed?.source, 'catalog_default');
  assert.equal(partial.speed?.degradationReason, 'cold-start');
  assert.equal(partial.usage.inputTokens, undefined);
  assert.equal(partial.usage.totalTokens, 220);
  assert.equal(partial.usage.attemptCount, 3);

  const unavailable = snapshot.recentTaskRuns[2]!;
  assert.equal(unavailable.usage.completeness, 'unavailable');
  assert.equal(unavailable.usage.referenceCostUsd, 0);
  assert.equal(unavailable.speed, undefined);
  assert.equal(unavailable.resolvedProfile, undefined);
});

test('stats snapshot retains runs with unknown cost and never fabricates a speed source', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: [],
    windows: [],
    recentRuns: [
      {
        task_run_id: 'run-missing-cost',
        task: 'edit',
        usage: { completeness: 'partial', attempt_count: 2, usage_event_count: 1, output_tokens: 120, total_tokens: 220, reference_cost_complete: false },
      },
      {
        task_run_id: 'run-zero-and-bad-source',
        task: 'build',
        usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0, reference_cost_complete: true },
        resolved: { speed: { effective_tps: 7, source: 'bogus-source', sample_count: null, expected_tps_met: null } },
      },
    ],
  }));

  assert.equal(snapshot.recentTaskRuns.length, 2);
  const missingCost = snapshot.recentTaskRuns[0]!;
  assert.equal(missingCost.usage.referenceCostComplete, false);
  assert.equal(missingCost.usage.referenceCostUsd, undefined);

  const zeroAndBad = snapshot.recentTaskRuns[1]!;
  assert.equal(zeroAndBad.usage.referenceCostUsd, 0);
  assert.equal(zeroAndBad.usage.referenceCostComplete, true);
  assert.equal(zeroAndBad.speed, undefined);
});

test('stats snapshot rejects malformed rows and keeps queued/interrupted status and zero values', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: [],
    windows: [],
    recentRuns: [
      { task_run_id: 'good', task: 'edit', project: 'workspace', source: 'project', status: 'queued', usage: { completeness: 'partial', attempt_count: 0, usage_event_count: 0, input_tokens: 0, output_tokens: 0, reference_cost_complete: false } },
      { task: 'missing-run-id', usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0.001, reference_cost_complete: true } },
      { task_run_id: 'missing-usage' },
      { task_run_id: 'bad-cost', task: 'x', usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_complete: true } },
      { task_run_id: 'run-zero', task: 'commit', source: 'builtin', status: 'interrupted', usage: { completeness: 'partial', attempt_count: 1, usage_event_count: 1, input_tokens: 0, output_tokens: 0, output_tps: 0, reference_cost_complete: false } },
    ],
  }));

  assert.equal(snapshot.recentTaskRuns.length, 2);
  const projectRun = snapshot.recentTaskRuns[0]!;
  assert.equal(projectRun.project, 'workspace');
  assert.equal(projectRun.status, 'queued');
  assert.equal(projectRun.usage.inputTokens, 0);
  assert.equal(projectRun.usage.outputTps, undefined);

  const zeroRun = snapshot.recentTaskRuns[1]!;
  assert.equal(zeroRun.status, 'interrupted');
  assert.equal(zeroRun.usage.outputTps, 0);
});

test('stats snapshot keeps authoritative wire resolved_profile without inferring model or provider', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: [],
    windows: [],
    recentRuns: [
      {
        task_run_id: 'run-legacy-profile',
        task: 'legacy',
        source: 'unknown',
        status: 'done',
        resolved_profile: 'legacy-clean',
        usage: { completeness: 'unavailable', attempt_count: 1, usage_event_count: 0, reference_cost_complete: false },
      },
      {
        task_run_id: 'run-no-profile',
        task: 'build',
        source: 'builtin',
        status: 'done',
        usage: { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false },
      },
    ],
  }));

  const legacy = snapshot.recentTaskRuns[0]!;
  assert.equal(legacy.resolvedProfile, 'legacy-clean');
  assert.equal(legacy.resolvedModel, undefined);
  assert.equal(legacy.resolvedProvider, undefined);
  assert.equal(legacy.speed, undefined);

  const absent = snapshot.recentTaskRuns[1]!;
  assert.equal(absent.resolvedProfile, undefined);
});

test('stats snapshot preserves window profile display fields and de-duplicates provider names', async () => {
  const snapshot = await buildStatsSnapshot(async () => ({
    source: 'sqlite',
    today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
    daily: [],
    windows: [
      {
        period: '24h',
        startAt: today.startAt,
        endAt: today.endAt,
        dispatchCount: 12,
        totalTokens: 3_900,
        byProfile: [
          {
            model: 'kimi/kimi-k3',
            runCount: 8,
            totalTokens: 3_000,
            averageTps: 12.5,
            model_display_name: 'Kimi K3',
            provider_display_names: ['Kimi', 'Moonshot', 'Kimi'],
          },
        ],
        taskStats: { totalDurationMs: 120_000, byTask: [], builtinTotalDurationMs: 80_000, byBuiltinTask: [] },
      },
    ],
  }));

  const windowProfile = snapshot.windows[0]?.byProfile[0];
  assert.equal(windowProfile?.name, 'kimi/kimi-k3');
  assert.equal(windowProfile?.modelDisplayName, 'Kimi K3');
  assert.deepEqual(windowProfile?.providerDisplayNames, ['Kimi', 'Moonshot']);
});
