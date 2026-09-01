import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDesktopBuildTime } from '../src/build-metadata.js';

test('desktop build time accepts only valid timestamps and normalizes to ISO', () => {
  assert.equal(resolveDesktopBuildTime('2026-09-01T02:03:04+00:00'), '2026-09-01T02:03:04.000Z');
  assert.equal(resolveDesktopBuildTime('invalid'), undefined);
  assert.equal(resolveDesktopBuildTime(''), undefined);
  assert.equal(resolveDesktopBuildTime(null), undefined);
});
