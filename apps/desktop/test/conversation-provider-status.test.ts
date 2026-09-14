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
  assert.match(presentation.tooltip, /5h 剩余 8%/);
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
  assert.match(presentation.tooltip, /余额 ¥12\.50/);
  assert.equal(presentation.tooltip.includes('额度计划'), false);
});

test('picker tooltip reports actual per-window remaining percentages and balances', () => {
  const presentation = conversationProviderPresentation('codebuddy', snapshot(quota({
    windows: [
      { name: '5h', remainingPct: 63.25, expectedRemainingPct: 40 },
      { name: '7d', remainingPct: 12, expectedRemainingPct: 10 },
    ],
    balances: [
      { currency: 'CNY', amount: '12.50', display: '¥12.50' },
      { currency: 'USD', amount: '3.00', display: 'US$3.00' },
    ],
  })));

  assert.match(presentation.tooltip, /5h 剩余 63\.3%/);
  assert.match(presentation.tooltip, /7d 剩余 12%/);
  assert.match(presentation.tooltip, /余额 ¥12\.50/);
  assert.match(presentation.tooltip, /余额 US\$3\.00/);
  // Actual snapshot numbers only — no pool fallback or fabricated quota.
  assert.doesNotMatch(presentation.tooltip, /池|总额度/);
});

test('picker tooltip keeps unknown quota evidence out of the healthy verdict', () => {
  const unknown = conversationProviderPresentation('codebuddy', snapshot(quota()));
  assert.notEqual(unknown.status, 'green');
  assert.doesNotMatch(unknown.tooltip, /状态正常/);
  assert.match(unknown.tooltip, /额度未知/);
  assert.doesNotMatch(unknown.tooltip, /剩余|余额/);
});

test('picker quota projection makes exhaustion and provider failures red', () => {
  const exhausted = conversationProviderPresentation('codebuddy', snapshot(quota({
    balances: [{ currency: 'CNY', amount: '0', display: '¥0.00' }],
    message: '计划信息暂不可用',
  })));
  assert.equal(exhausted.status, 'red');
  assert.match(exhausted.tooltip, /额度已耗尽/);
  assert.match(exhausted.tooltip, /余额 ¥0\.00/);
  assert.match(exhausted.tooltip, /计划信息暂不可用/);

  const errored = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'error' })));
  assert.equal(errored.status, 'red');
  assert.match(errored.tooltip, /额度状态异常/);

  const pending = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'pending' })));
  assert.equal(pending.status, 'yellow');
  assert.match(pending.tooltip, /额度状态读取中/);

  const stale = conversationProviderPresentation('codebuddy', snapshot(quota({ stale: true })));
  assert.equal(stale.status, 'yellow');
  assert.match(stale.tooltip, /额度状态可能已过期/);

  const unavailable = conversationProviderPresentation('codebuddy', snapshot(quota({ status: 'unavailable' })));
  assert.equal(unavailable.status, 'red');
  assert.match(unavailable.tooltip, /额度状态不可用/);
});

test('picker marks an advertised provider without quota evidence as unknown, not healthy', () => {
  const unavailable: QuotaSnapshot = {
    status: 'unavailable',
    providers: [],
    catalog: [],
    providerOrder: [],
  };
  const noEvidence = conversationProviderPresentation('codebuddy', unavailable);
  assert.notEqual(noEvidence.status, 'green');
  assert.match(noEvidence.tooltip, /额度未知/);
  assert.doesNotMatch(noEvidence.tooltip, /剩余|余额/);

  const available = { ...unavailable, status: 'available' as const };
  const availablePresentation = conversationProviderPresentation('codebuddy', available);
  assert.notEqual(availablePresentation.status, 'green');
  assert.doesNotMatch(availablePresentation.tooltip, /状态正常/);
});
