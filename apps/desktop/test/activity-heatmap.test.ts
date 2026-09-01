import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActivityHeatmap } from '../src/renderer/activity-heatmap.js';

const days = [
  { dayKey: '2026-08-30', dispatchCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  { dayKey: '2026-08-31', dispatchCount: 1, inputTokens: 500, outputTokens: 100, totalTokens: 600 },
  { dayKey: '2026-09-01', dispatchCount: 4, inputTokens: 8_000, outputTokens: 2_000, totalTokens: 10_000 },
];

test('activity heatmap flows seven local days down each weekly column', () => {
  const model = buildActivityHeatmap(days);
  assert.equal(model.weekCount, 1);
  assert.equal(model.slots.length, 7);
  assert.deepEqual(model.slots.slice(0, 3).map((slot) => slot.day?.dayKey), [
    '2026-08-30',
    '2026-08-31',
    '2026-09-01',
  ]);
  assert.ok(model.slots.slice(3).every((slot) => slot.day === null));
});

test('activity heatmap emits English month labels and fixed absolute intensity levels', () => {
  const model = buildActivityHeatmap(days);
  assert.deepEqual(model.months, [{ label: 'Sep', weekIndex: 0 }]);
  assert.equal(model.slots[0].level, 0);
  assert.equal(model.slots[1].level, 1);
  assert.equal(model.slots[2].level, 1);
});

test('activity heatmap advances one level per 100M tokens and caps at 400M', () => {
  const totals = [
    0,
    1,
    99_999_999,
    100_000_000,
    199_999_999,
    200_000_000,
    299_999_999,
    300_000_000,
    399_999_999,
    400_000_000,
    500_000_000,
  ];
  const model = buildActivityHeatmap(totals.map((totalTokens, index) => ({
    dayKey: `2026-08-${String(index + 1).padStart(2, '0')}`,
    dispatchCount: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
  })));
  assert.deepEqual(
    model.slots.filter((slot) => slot.day !== null).map((slot) => slot.level),
    [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
  );
});

test('activity heatmap aligns a midweek first day with leading placeholders', () => {
  const model = buildActivityHeatmap(days.slice(2));
  assert.equal(model.slots.length, 7);
  assert.equal(model.slots[0].day, null);
  assert.equal(model.slots[1].day, null);
  assert.equal(model.slots[2].day?.dayKey, '2026-09-01');
});
