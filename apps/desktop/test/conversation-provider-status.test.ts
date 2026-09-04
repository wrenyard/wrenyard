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

test('picker quota projection collapses plan warnings into one yellow status', () => {
  const presentation = conversationProviderPresentation('codebuddy', snapshot(quota({
    windows: [{ name: '5h', remainingPct: 8, expectedRemainingPct: 24 }],
  })));

  assert.equal(presentation.label, 'CodeBuddy');
  assert.equal(presentation.status, 'yellow');
  assert.match(presentation.tooltip, /额度计划/);
  assert.match(presentation.tooltip, /剩余额度偏低/);
  assert.match(presentation.tooltip, /消耗速度偏快/);
  assert.doesNotMatch(presentation.tooltip, /订阅|会员|Pro/);
});

test('picker quota projection keeps a healthy balance green without inventing a plan', () => {
  const presentation = conversationProviderPresentation('deepseek', snapshot(quota({
    id: 'deepseek',
    label: 'DeepSeek',
    balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
  })));

  assert.equal(presentation.status, 'green');
  assert.match(presentation.tooltip, /余额 \/ 按量/);
  assert.doesNotMatch(presentation.tooltip, /额度计划/);
});

test('picker quota projection makes exhaustion and provider failures red', () => {
  const exhausted = conversationProviderPresentation('codebuddy', snapshot(quota({
    balances: [{ currency: 'CNY', amount: '0', display: '¥0.00' }],
    message: '计划信息暂不可用',
  })));
  assert.equal(exhausted.status, 'red');
  assert.match(exhausted.tooltip, /额度已耗尽/);
  assert.match(exhausted.tooltip, /计划信息暂不可用/);

  const errored = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'error' })));
  assert.equal(errored.status, 'red');

  const pending = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'pending' })));
  assert.equal(pending.status, 'yellow');

  const stale = conversationProviderPresentation('codebuddy', snapshot(quota({ stale: true })));
  assert.equal(stale.status, 'yellow');

  const unavailable = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'unavailable' })));
  assert.equal(unavailable.status, 'red');
});

test('picker keeps an advertised provider without quota evidence green', () => {
  const unavailable: QuotaSnapshot = {
    status: 'unavailable',
    providers: [],
    catalog: [],
    providerOrder: [],
  };
  assert.equal(conversationProviderPresentation('codebuddy', unavailable).status, 'green');

  const available = { ...unavailable, status: 'available' as const };
  assert.equal(conversationProviderPresentation('codebuddy', available).status, 'green');
});
