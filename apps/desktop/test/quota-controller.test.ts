import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuotaProviderState } from '@wrenyard/pet/runtime';
import { projectQuotaSnapshot } from '../src/quota-controller.js';

const providers: QuotaProviderState[] = [
  {
    id: 'codex',
    label: 'Codex',
    status: 'ok',
    stale: false,
    displayLine: 'codex 7d 75% remain',
    error: null,
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [{ name: '7d', usedPct: 25, remainingPct: 75.8, expectedRemainingPct: 64.2 }],
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    status: 'ok',
    stale: false,
    displayLine: 'deepseek bal. ¥12.50',
    error: null,
    balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
  },
];

test('quota projection follows Desktop settings order and hides disabled providers', () => {
  const snapshot = projectQuotaSnapshot(providers, [
    { id: 'deepseek', enabled: true },
    { id: 'cursor', enabled: false },
    { id: 'codex', enabled: true },
  ], 123);

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.refreshedAt, 123);
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['deepseek', 'codex']);
  assert.deepEqual(snapshot.providers[0].balances, [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }]);
  assert.deepEqual(snapshot.providers[1].windows, [{ name: '7d', remainingPct: 75.8, expectedRemainingPct: 64.2 }]);
});

test('quota projection keeps configured providers visible when a runtime result is missing', () => {
  const snapshot = projectQuotaSnapshot([], [{ id: 'cursor', enabled: true }], 456, 'runtime unavailable');

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.message, 'runtime unavailable');
  assert.deepEqual(snapshot.providers, [{
    id: 'cursor',
    label: 'cursor',
    status: 'unavailable',
    stale: false,
    windows: [],
    balances: [],
    message: '当前额度结果中没有这个来源。',
  }]);
});

test('quota projection clamps malformed percentages at the renderer boundary', () => {
  const malformed: QuotaProviderState = {
    ...providers[0],
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [{ name: '7d', usedPct: 0, remainingPct: 130, expectedRemainingPct: -20 }],
    },
  };
  const snapshot = projectQuotaSnapshot([malformed], [{ id: 'codex', enabled: true }]);

  assert.equal(snapshot.providers[0].windows[0].remainingPct, 100);
  assert.equal(snapshot.providers[0].windows[0].expectedRemainingPct, 0);
});
