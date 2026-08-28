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
    assert.deepEqual(params, { days: 31, limit: 20 });
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
      daily: Array.from({ length: 100 }, (_, index) => ({ ...today, dayKey: `day-${index}` })),
      byProfile: Array.from({ length: 100 }, (_, index) => ({ profile: `p-${index}`, dispatchCount: 1, totalTokens: 1 })),
      byTask: [],
      windows: [],
    };
  });

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.daily.length, 31);
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
  });
});
