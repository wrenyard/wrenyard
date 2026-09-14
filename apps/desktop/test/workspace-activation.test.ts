import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDaemonIdle, runPlannedDaemonRestart } from '../src/workspace-activation.js';
const idle = { ok: true, mode: 'accepting', frozen: false, recovery_required: false,
  activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0 };
test('workspace change requires confirmed idle daemon status', () => {
  assert.equal(assertDaemonIdle(idle).idle, true);
  for (const patch of [{ activeTaskCount: 1 }, { activeWorkflowCount: 1 }, { activeExecutionCount: 1 },
    { frozen: true }, { mode: 'planned_restart' }, { recovery_required: true }, { activeTaskCount: -1 }]) {
    assert.equal(assertDaemonIdle({ ...idle, ...patch }).idle, false);
  }
  assert.equal(assertDaemonIdle(undefined).idle, false);
  assert.equal(assertDaemonIdle({}).idle, false);
});
test('restart uses the actual CLI contract and requires completed result', async () => {
  const result = await runPlannedDaemonRestart({ cli: 'wrenyard' }, async (cli, args) => {
    assert.equal(cli, 'wrenyard');
    assert.deepEqual(args, ['daemon', 'restart', '--json']);
    return { stdout: JSON.stringify({ restart_result: 'completed' }), stderr: '', code: 0 };
  });
  assert.equal(result.restartResult, 'completed');
  for (const response of [ { code: 1, stdout: '{}' }, { code: 0, stdout: 'invalid' },
    { code: 0, stdout: JSON.stringify({ restart_result: 'failed' }) } ]) {
    await assert.rejects(runPlannedDaemonRestart({ cli: 'wrenyard' }, async () => ({ ...response, stderr: '' })));
  }
});
