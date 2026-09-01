import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatBuildTime,
  formatCompactTokenCount,
  formatTaskDuration,
} from '../src/renderer/format.js';

test('compact token counts use English K/M/B/T suffixes', () => {
  assert.equal(formatCompactTokenCount(999), '999');
  assert.equal(formatCompactTokenCount(1_000), '1K');
  assert.equal(formatCompactTokenCount(12_345), '12.3K');
  assert.equal(formatCompactTokenCount(10_355_000), '10.4M');
  assert.equal(formatCompactTokenCount(2_500_000_000), '2.5B');
  assert.equal(formatCompactTokenCount(1_200_000_000_000), '1.2T');
  assert.doesNotMatch(formatCompactTokenCount(10_355_000), /万|亿/);
});

test('build time renders a full local date and keeps invalid input inspectable', () => {
  assert.equal(formatBuildTime(undefined), '—');
  assert.equal(formatBuildTime('invalid'), 'invalid');
  assert.match(
    formatBuildTime('2026-09-01T02:03:04.000Z', 'Asia/Shanghai'),
    /2026.*9.*1.*10.*03.*04/,
  );
});

test('task durations use English unit suffixes', () => {
  assert.equal(formatTaskDuration(825), '825ms');
  assert.equal(formatTaskDuration(12_400), '12s');
  assert.equal(formatTaskDuration(8 * 60_000), '8m');
  assert.equal(formatTaskDuration((2 * 60 + 48) * 60_000), '2h 48m');
  assert.equal(formatTaskDuration(3 * 60 * 60_000), '3h');
});
