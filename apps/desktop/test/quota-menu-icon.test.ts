import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuotaProviderSnapshot } from '../src/shell-contract.js';

const {
  formatQuotaMenuPercentageText,
  QUOTA_MENU_AMOUNT_ALPHA,
  QUOTA_MENU_BALANCE_X,
  QUOTA_MENU_BAR_H,
  QUOTA_MENU_BAR_W,
  QUOTA_MENU_BAR_X,
  QUOTA_MENU_BAR_Y,
  QUOTA_MENU_CHILD_ALPHA,
  QUOTA_MENU_FILL_ALPHA,
  QUOTA_MENU_LINE_STEP,
  QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA,
  QUOTA_MENU_PROVIDER_ALPHA,
  QUOTA_MENU_ROW_WIDTH,
  QUOTA_MENU_TRACK_ALPHA,
  renderQuotaMenuProviderBitmap,
} = await import('../src/quota-menu-icon.js');

function provider(overrides: Partial<QuotaProviderSnapshot> = {}): QuotaProviderSnapshot {
  return {
    id: 'codex',
    label: 'Codex',
    status: 'ok',
    stale: false,
    windows: [{ name: '7d', remainingPct: 65.9, expectedRemainingPct: 52 }],
    balances: [],
    ...overrides,
  };
}

function alphaAt(
  rendered: ReturnType<typeof renderQuotaMenuProviderBitmap>,
  logicalX: number,
  logicalY: number,
): number {
  const x = logicalX * rendered.scale;
  const y = logicalY * rendered.scale;
  return rendered.buffer[(y * rendered.pixelWidth + x) * 4 + 3];
}

test('restores the original compact grouped quota bitmap geometry', () => {
  const single = renderQuotaMenuProviderBitmap(provider());
  const grouped = renderQuotaMenuProviderBitmap(provider({
    windows: [
      { name: '5h', remainingPct: 100, expectedRemainingPct: 80 },
      { name: '7d', remainingPct: 97, expectedRemainingPct: 52 },
    ],
  }));

  assert.equal(single.pixelWidth / single.scale, QUOTA_MENU_ROW_WIDTH);
  assert.equal(single.pixelHeight / single.scale, 22);
  assert.equal(grouped.pixelHeight / grouped.scale, 31);
  assert.equal(alphaAt(grouped, 108, QUOTA_MENU_BAR_Y + QUOTA_MENU_LINE_STEP), QUOTA_MENU_CHILD_ALPHA);
});

test('keeps original provider, progress, track, marker and percentage hierarchy', () => {
  const rendered = renderQuotaMenuProviderBitmap(provider({ id: 'kimi-coding', label: 'KIMI' }));
  const markerX = QUOTA_MENU_BAR_X + Math.round(QUOTA_MENU_BAR_W * 0.52);

  assert.equal(formatQuotaMenuPercentageText(65.9), '65%');
  assert.equal(alphaAt(rendered, 8, QUOTA_MENU_BAR_Y), QUOTA_MENU_PROVIDER_ALPHA);
  assert.equal(alphaAt(rendered, 108, QUOTA_MENU_BAR_Y), QUOTA_MENU_CHILD_ALPHA);
  assert.equal(alphaAt(rendered, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y), QUOTA_MENU_FILL_ALPHA);
  assert.equal(alphaAt(rendered, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y), QUOTA_MENU_TRACK_ALPHA);
  assert.equal(alphaAt(rendered, markerX, QUOTA_MENU_BAR_Y), QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA);
  assert.equal(alphaAt(rendered, markerX, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H), 0);
});

test('keeps balance rows in the original provider, bal and amount columns without a bar', () => {
  const rendered = renderQuotaMenuProviderBitmap(provider({
    id: 'deepseek',
    label: 'DeepSeek',
    windows: [],
    balances: [{ currency: 'CNY', amount: '2.04', display: '¥2.04' }],
  }));

  assert.equal(QUOTA_MENU_BALANCE_X, 108);
  assert.equal(alphaAt(rendered, QUOTA_MENU_BALANCE_X, QUOTA_MENU_BAR_Y), QUOTA_MENU_CHILD_ALPHA);
  assert.equal(alphaAt(rendered, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y), QUOTA_MENU_AMOUNT_ALPHA);
  assert.equal(alphaAt(rendered, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y), 0);
});
