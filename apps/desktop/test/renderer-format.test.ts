import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBuildTime } from '../src/renderer/lib/format.js';

test('build time renders a full local date and keeps invalid input inspectable', () => {
  assert.equal(formatBuildTime(undefined), '—');
  assert.equal(formatBuildTime(''), '—');
  assert.equal(formatBuildTime('invalid'), 'invalid');
  assert.match(
    formatBuildTime('2026-09-01T02:03:04.000Z', 'Asia/Shanghai'),
    /2026.*9.*1.*10.*03.*04/,
  );
});
