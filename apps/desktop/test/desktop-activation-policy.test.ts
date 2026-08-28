import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDesktopActivationPolicy } from '../src/desktop-activation-policy.js';

test('macOS uses the regular activation policy and shows the Dock icon', async () => {
  const calls: string[] = [];

  await ensureDesktopActivationPolicy({
    setActivationPolicy: (policy) => calls.push(`policy:${policy}`),
    showDock: async () => {
      calls.push('dock:show');
    },
  }, 'darwin');

  assert.deepEqual(calls, ['policy:regular', 'dock:show']);
});

test('other platforms keep their native activation policy', async () => {
  const calls: string[] = [];

  await ensureDesktopActivationPolicy({
    setActivationPolicy: (policy) => calls.push(`policy:${policy}`),
    showDock: () => {
      calls.push('dock:show');
    },
  }, 'linux');

  assert.deepEqual(calls, []);
});
