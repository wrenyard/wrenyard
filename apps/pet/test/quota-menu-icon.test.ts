import { describe, expect, it, vi } from 'vitest';

const setTemplateImage = vi.fn();

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage,
    })),
  },
}));

import {
  createQuotaMenuRowIcon,
  QUOTA_MENU_BAR_X,
  QUOTA_MENU_BAR_H,
  QUOTA_MENU_BAR_W,
  QUOTA_MENU_BAR_Y,
  QUOTA_MENU_FILL_ALPHA,
  renderQuotaMenuRowBitmap,
} from '../src/main/quota-menu-icon';

function countFill(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === QUOTA_MENU_FILL_ALPHA) {
      count += 1;
    }
  }
  return count;
}

function countText(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 255) {
      count += 1;
    }
  }
  return count;
}

function alphaAt(
  rendered: ReturnType<typeof renderQuotaMenuRowBitmap>,
  logicalX: number,
  logicalY: number,
): number {
  const x = logicalX * rendered.scale;
  const y = logicalY * rendered.scale;
  return rendered.buffer[(y * rendered.pixelWidth + x) * 4 + 3];
}

const sample = {
  provider: 'codex',
  window: '7d',
  remainingPct: 100,
  expectedRemainingPct: null,
  label: 'codex 7d 100% remain',
};

describe('quota menu row bitmap', () => {
  it('fills remaining from the left and leaves 0% empty', () => {
    const empty = renderQuotaMenuRowBitmap({ ...sample, remainingPct: 0, label: 'codex 7d 0% remain' });
    const full = renderQuotaMenuRowBitmap(sample);
    expect(countFill(empty.buffer)).toBe(0);
    expect(countFill(full.buffer)).toBe(QUOTA_MENU_BAR_W * QUOTA_MENU_BAR_H * 2 * 2);
  });

  it('extends the pace marker above and below the bar with visible caps', () => {
    const rendered = renderQuotaMenuRowBitmap({
      ...sample,
      expectedRemainingPct: 50,
    });
    const markerX = QUOTA_MENU_BAR_X + Math.round(QUOTA_MENU_BAR_W * 0.5);

    expect(alphaAt(rendered, markerX - 1, QUOTA_MENU_BAR_Y - 2)).toBe(255);
    expect(alphaAt(rendered, markerX, QUOTA_MENU_BAR_Y - 2)).toBe(255);
    expect(alphaAt(rendered, markerX + 1, QUOTA_MENU_BAR_Y - 2)).toBe(255);
    expect(alphaAt(rendered, markerX - 1, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H + 1)).toBe(255);
    expect(alphaAt(rendered, markerX, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H + 1)).toBe(255);
    expect(alphaAt(rendered, markerX + 1, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H + 1)).toBe(255);
  });

  it('does not draw a bar for error rows', () => {
    const row = renderQuotaMenuRowBitmap({
      provider: 'codex',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      error: 'error — initialize failed',
      label: 'codex  error — initialize failed',
    });
    expect(countFill(row.buffer)).toBe(0);
  });

  it('draws provider/currency/amount pixels for a balance row with zero progress fill', () => {
    const row = renderQuotaMenuRowBitmap({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek CNY ¥12.50',
      balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
    });
    // Provider/currency/amount text is drawn (template mask alpha 255)
    expect(countText(row.buffer)).toBeGreaterThan(0);
    // No progress bar track/fill semantics for a monetary row
    expect(countFill(row.buffer)).toBe(0);
  });

  it('retains template image behavior for balance rows', () => {
    setTemplateImage.mockClear();
    createQuotaMenuRowIcon({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek CNY ¥12.50',
      balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
    });
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });

  it('marks the row image as a macOS template so AppKit tints it', () => {
    setTemplateImage.mockClear();
    createQuotaMenuRowIcon(sample);
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });
});
