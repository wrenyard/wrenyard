import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDaemonIdle } from '../src/workspace-activation.js';
const idle = { ok: true, shutting_down: false, idle: true,
  activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 };
test('workspace change requires confirmed idle daemon status', () => {
  assert.equal(assertDaemonIdle(idle).idle, true);
  for (const patch of [{ activeTaskCount: 1 }, { activeWorkflowCount: 1 }, { activeExecutionCount: 1 },
    { idle: false }, { shutting_down: true }, { activeTaskCount: -1 }]) {
    assert.equal(assertDaemonIdle({ ...idle, ...patch }).idle, false);
  }
  assert.equal(assertDaemonIdle(undefined).idle, false);
  assert.equal(assertDaemonIdle({}).idle, false);
});
