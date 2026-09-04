import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuotaProviderSnapshot, QuotaSnapshot } from '../src/shell-contract.js';
import { conversationProviderPresentation } from '../src/renderer/conversation-provider-status.js';

function snapshot(quota: QuotaProviderSnapshot, status: QuotaSnapshot['status'] = 'available'): QuotaSnapshot {
  return {
    status,
    providers: [quota],
    catalog: [{
      id: quota.id,
      label: quota.label,
      description: 'Provider',
      configured: true,
      authMode: 'api-key',
      setupHint: 'Configured',
      quota,
    }],
    providerOrder: [{ id: quota.id, enabled: true }],
  };
}

function quota(overrides: Partial<QuotaProviderSnapshot> = {}): QuotaProviderSnapshot {
  return {
    id: 'codebuddy',
    label: 'CodeBuddy',
    status: 'ok',
    stale: false,
    windows: [],
    balances: [],
    ...overrides,
  };
}

test('picker quota projection distinguishes plan pace and low remaining quota', () => {
  const presentation = conversationProviderPresentation('codebuddy', snapshot(quota({
    windows: [{ name: '5h', remainingPct: 8, expectedRemainingPct: 24 }],
  })));

  assert.equal(presentation.label, 'CodeBuddy');
  assert.deepEqual(presentation.indicators.map((indicator) => indicator.kind), [
    'quota-plan',
    'quota-low',
    'pace-low',
  ]);
  assert.match(presentation.tooltip, /额度计划/);
  assert.doesNotMatch(presentation.tooltip, /订阅|会员|Pro/);
});

test('picker quota projection distinguishes balances without inventing a plan', () => {
  const presentation = conversationProviderPresentation('deepseek', snapshot(quota({
    id: 'deepseek',
    label: 'DeepSeek',
    balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
  })));

  assert.deepEqual(presentation.indicators.map((indicator) => indicator.kind), ['balance']);
  assert.match(presentation.tooltip, /余额 \/ 按量/);
  assert.doesNotMatch(presentation.tooltip, /额度计划/);
});

test('picker quota projection covers exhaustion and provider lifecycle states', () => {
  const exhausted = conversationProviderPresentation('codebuddy', snapshot(quota({
    status: 'error',
    stale: true,
    balances: [{ currency: 'CNY', amount: '0', display: '¥0.00' }],
    message: '计划信息暂不可用',
  })));
  assert.deepEqual(exhausted.indicators.map((indicator) => indicator.kind), [
    'balance',
    'error',
    'stale',
    'quota-empty',
  ]);
  assert.match(exhausted.tooltip, /计划信息暂不可用/);

  const pending = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'pending' })));
  assert.deepEqual(pending.indicators.map((indicator) => indicator.kind), ['pending']);

  const unavailable = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'unavailable' })));
  assert.deepEqual(unavailable.indicators.map((indicator) => indicator.kind), ['unavailable']);
});

test('picker marks globally unavailable provider data but stays quiet when no quota evidence exists', () => {
  const unavailable: QuotaSnapshot = {
    status: 'unavailable',
    providers: [],
    catalog: [],
    providerOrder: [],
  };
  assert.deepEqual(
    conversationProviderPresentation('codebuddy', unavailable).indicators.map((indicator) => indicator.kind),
    ['unavailable'],
  );

  const available = { ...unavailable, status: 'available' as const };
  assert.deepEqual(conversationProviderPresentation('codebuddy', available).indicators, []);
});
