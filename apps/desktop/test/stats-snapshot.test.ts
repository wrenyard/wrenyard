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
      byProfile: [{ model: 'kimi', dispatchCount: 8, inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
      byTask: [{ taskName: 'edit', dispatchCount: 6, inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
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
  assert.equal(snapshot.source, 'summary');
  assert.deepEqual(snapshot.byProfile, [{ name: 'kimi', model: 'kimi', dispatchCount: 8, totalTokens: 3 }]);
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
      byProfile: Array.from({ length: 100 }, (_, index) => ({ model: `p-${index}`, dispatchCount: 1, totalTokens: 1 })),
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
            generation_ms: 48000,
            output_tps: 18.75,
            tps_contract: 'response_v1',
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
  assert.equal(complete.usage.tpsContract, 'response_v1');
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

test('stats snapshot requires model identity for rankings and preserves display fields', async () => {
  const snapshot = await buildStatsSnapshot(async (method) => {
    if (method === 'stats.today') throw new Error('method unavailable');
    return {
      source: 'sqlite',
      today: { ...today, outcomes: { done: 1, failed: 0, cancelled: 0 } },
      daily: [],
      byProfile: [
        {
          model: 'kimi/kimi-k2',
          profile: 'legacy-fallback',
          dispatchCount: 8,
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          model_display_name: 'Kimi K2',
          provider_display_names: ['Kimi', 'Kimi', 'Moonshot'],
        },
        { profile: 'old-only', dispatchCount: 4, totalTokens: 2 },
      ],
      byTask: [],
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
              profile: 'legacy-p',
              runCount: 8,
              totalTokens: 3_000,
              averageTps: 12.5,
              model_display_name: 'Kimi K3',
              provider_display_names: ['Kimi', 'Moonshot', 'Kimi'],
            },
          ],
          taskStats: {
            totalDurationMs: 120_000,
            byTask: [],
            builtinTotalDurationMs: 80_000,
            byBuiltinTask: [],
          },
        },
      ],
    };
  });

  assert.equal(snapshot.byProfile.length, 1);
  // model is preferred over the legacy profile for the internal identity
  assert.equal(snapshot.byProfile[0].name, 'kimi/kimi-k2');
  assert.equal(snapshot.byProfile[0].model, 'kimi/kimi-k2');
  assert.equal(snapshot.byProfile[0].modelDisplayName, 'Kimi K2');
  // provider names are de-duplicated deterministically, preserving order
  assert.deepEqual(snapshot.byProfile[0].providerDisplayNames, ['Kimi', 'Moonshot']);
  const windowProfile = snapshot.windows[0].byProfile[0];
  assert.equal(windowProfile.name, 'kimi/kimi-k3');
  assert.equal(windowProfile.modelDisplayName, 'Kimi K3');
  assert.deepEqual(windowProfile.providerDisplayNames, ['Kimi', 'Moonshot']);
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

test('stats snapshot keeps authoritative wire resolved_profile without inferring model or provider', async () => {
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
          // Legacy run predating full dispatch snapshots: only the authoritative
          // stored resolved_profile travels on the wire, never a fabricated
          // resolved object.
          task_run_id: 'run-legacy-profile',
          task: 'legacy',
          source: 'unknown',
          status: 'done',
          resolved_profile: 'legacy-clean',
          usage: {
            completeness: 'unavailable',
            attempt_count: 1,
            usage_event_count: 0,
            reference_cost_complete: false,
          },
        },
        {
          // Quiet missing state: no resolved object and no resolved_profile.
          task_run_id: 'run-no-profile',
          task: 'build',
          source: 'builtin',
          status: 'done',
          usage: {
            completeness: 'unavailable',
            attempt_count: 0,
            usage_event_count: 0,
            reference_cost_complete: false,
          },
        },
      ],
    };
  });

  assert.equal(snapshot.recentTaskRuns.length, 2);

  const legacy = snapshot.recentTaskRuns[0];
  // The fallback chain (resolvedModelId/resolvedModel/resolvedProfile) can use
  // the authoritative profile without inferring model or provider.
  assert.equal(legacy.resolvedProfile, 'legacy-clean');
  assert.equal(legacy.resolvedModel, undefined);
  assert.equal(legacy.resolvedModelId, undefined);
  assert.equal(legacy.resolvedClient, undefined);
  assert.equal(legacy.resolvedProvider, undefined);
  assert.equal(legacy.speed, undefined);

  const absent = snapshot.recentTaskRuns[1];
  assert.equal(absent.resolvedProfile, undefined);
  assert.equal(absent.resolvedModel, undefined);
  assert.equal(absent.resolvedProvider, undefined);
});

test('stats snapshot carries project context and keeps queued/interrupted status and zero values', async () => {
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
          task_run_id: 'run-project',
          task: 'edit',
          project: 'workspace',
          source: 'project',
          status: 'queued',
          usage: {
            completeness: 'partial',
            attempt_count: 0,
            usage_event_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            reference_cost_complete: false,
          },
        },
        {
          task_run_id: 'run-zero',
          task: 'commit',
          source: 'builtin',
          status: 'interrupted',
          usage: {
            completeness: 'partial',
            attempt_count: 1,
            usage_event_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            output_tps: 0,
            reference_cost_complete: false,
          },
        },
        {
          task_run_id: 'run-missing',
          task: 'build',
          source: 'unknown',
          status: 'done',
          usage: {
            completeness: 'partial',
            attempt_count: 1,
            usage_event_count: 1,
            input_tokens: 0,
            output_tokens: 120,
            reference_cost_complete: false,
          },
        },
      ],
    };
  });

  assert.equal(snapshot.source, 'summary');
  assert.equal(snapshot.recentTaskRuns.length, 3);

  const projectRun = snapshot.recentTaskRuns[0];
  assert.equal(projectRun.project, 'workspace');
  assert.equal(projectRun.status, 'queued');
  // real numeric zero is preserved verbatim, never coerced or invented
  assert.equal(projectRun.usage.inputTokens, 0);
  assert.equal(projectRun.usage.outputTokens, 0);
  assert.equal(projectRun.usage.outputTps, undefined);

  const zeroRun = snapshot.recentTaskRuns[1];
  assert.equal(zeroRun.status, 'interrupted');
  assert.equal(zeroRun.usage.inputTokens, 0);
  assert.equal(zeroRun.usage.outputTokens, 0);
  assert.equal(zeroRun.usage.outputTps, 0);

  const missingRun = snapshot.recentTaskRuns[2];
  assert.equal(missingRun.status, 'done');
  assert.equal(missingRun.project, undefined);
  // output_tps is only the authoritative value; a missing number is never calculated.
  assert.equal(missingRun.usage.outputTps, undefined);
  assert.equal(missingRun.usage.outputTokens, 120);
});

test('stats snapshot projects paired Catalog display labels only when the server row sends both', async () => {
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
          // Complete paired row-level display labels.
          task_run_id: 'run-paired',
          task: 'edit',
          source: 'builtin',
          status: 'done',
          provider_display_name: 'Kimi Coding',
          model_display_name: 'Kimi K2',
          usage: {
            completeness: 'complete',
            attempt_count: 1,
            usage_event_count: 1,
            reference_cost_usd: 0.001,
            reference_cost_complete: true,
          },
        },
        {
          // Missing one half: neither label is projected or copied from the sibling.
          task_run_id: 'run-provider-only',
          task: 'edit',
          provider_display_name: 'Kimi Coding',
          usage: {
            completeness: 'complete',
            attempt_count: 1,
            usage_event_count: 1,
            reference_cost_usd: 0.001,
            reference_cost_complete: true,
          },
        },
        {
          // Legacy/raw resolved identity payloads never generate display labels.
          task_run_id: 'run-raw',
          task: 'legacy',
          resolved: {
            client: 'kimi',
            provider: 'moonshot',
            profile: 'moonshot',
            model: 'kimi-k3',
            model_id: 'moonshot/kimi-k3',
          },
          resolved_client: 'kimi',
          resolved_provider: 'moonshot',
          resolved_profile: 'moonshot',
          resolved_model: 'kimi-k3',
          resolved_model_id: 'moonshot/kimi-k3',
          usage: {
            completeness: 'complete',
            attempt_count: 1,
            usage_event_count: 1,
            reference_cost_usd: 0.001,
            reference_cost_complete: true,
          },
        },
      ],
    };
  });

  assert.equal(snapshot.recentTaskRuns.length, 3);

  const paired = snapshot.recentTaskRuns[0]!;
  assert.equal(paired.resolvedProviderDisplayName, 'Kimi Coding');
  assert.equal(paired.resolvedModelDisplayName, 'Kimi K2');

  const providerOnly = snapshot.recentTaskRuns[1]!;
  // A missing sibling means neither display label is carried.
  assert.equal(providerOnly.resolvedProviderDisplayName, undefined);
  assert.equal(providerOnly.resolvedModelDisplayName, undefined);

  const raw = snapshot.recentTaskRuns[2]!;
  // Raw resolved identities keep the compatibility projection but are never
  // promoted into paired Catalog display labels.
  assert.equal(raw.resolvedClient, 'kimi');
  assert.equal(raw.resolvedProvider, 'moonshot');
  assert.equal(raw.resolvedProfile, 'moonshot');
  assert.equal(raw.resolvedModel, 'kimi-k3');
  assert.equal(raw.resolvedModelId, 'moonshot/kimi-k3');
  assert.equal(raw.resolvedProviderDisplayName, undefined);
  assert.equal(raw.resolvedModelDisplayName, undefined);
});

test('stats snapshot retains provider_override speed source exactly and still rejects unknown sources', async () => {
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
          task_run_id: 'run-provider-override',
          task: 'edit',
          resolved: { speed: { effective_tps: 21.5, source: 'provider_override', sample_count: null, expected_tps_met: true } },
          usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0.001, reference_cost_complete: true },
        },
        {
          task_run_id: 'run-unknown-source',
          task: 'build',
          resolved: { speed: { effective_tps: 9, source: 'made_up_source', sample_count: null, expected_tps_met: null } },
          usage: { completeness: 'complete', attempt_count: 1, usage_event_count: 1, reference_cost_usd: 0, reference_cost_complete: true },
        },
      ],
    };
  });

  assert.equal(snapshot.recentTaskRuns.length, 2);

  const overrideRun = snapshot.recentTaskRuns[0];
  assert.deepEqual(overrideRun.speed, { effectiveTps: 21.5, source: 'provider_override', sampleCount: null, expectedTpsMet: true });

  const unknownRun = snapshot.recentTaskRuns[1];
  // Unknown sources are still rejected rather than fabricated.
  assert.equal(unknownRun.speed, undefined);
});
