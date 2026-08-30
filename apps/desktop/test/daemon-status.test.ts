import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daemonStatusPresentation } from '../src/daemon-status.js';

test('daemon status derives the current start time from the public uptime', () => {
  assert.deepEqual(
    daemonStatusPresentation({ status: 'connected', uptimeMs: 125_000 }, 1_000_000),
    { status: 'connected', label: 'Daemon 在线', startedAt: 875_000 },
  );
});

test('daemon status keeps unavailable and unknown-uptime states explicit', () => {
  assert.deepEqual(
    daemonStatusPresentation({ status: 'connected' }, 1_000_000),
    { status: 'connected', label: 'Daemon 在线' },
  );
  assert.deepEqual(
    daemonStatusPresentation({ status: 'unavailable', uptimeMs: 125_000 }, 1_000_000),
    { status: 'unavailable', label: 'Daemon 离线' },
  );
});
