import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDaemonIdle, runDaemonRestart } from '../src/workspace-activation.js';
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
test('restart uses the actual CLI contract and requires restarted:true', async () => {
  const result = await runDaemonRestart({ cli: 'wrenyard' }, async (cli, args) => {
    assert.equal(cli, 'wrenyard');
    assert.deepEqual(args, ['daemon', 'restart', '--json']);
    return { stdout: JSON.stringify({ restarted: true, pid: 4321 }), stderr: '', code: 0 };
  });
  assert.equal(result.restartResult, 'completed');
  for (const response of [ { code: 1, stdout: '{}' }, { code: 0, stdout: 'invalid' },
    { code: 0, stdout: JSON.stringify({ restarted: false, pid: null }) } ]) {
    await assert.rejects(runDaemonRestart({ cli: 'wrenyard' }, async () => ({ ...response, stderr: '' })));
  }
});
