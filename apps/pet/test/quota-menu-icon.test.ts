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
  formatQuotaMenuPercentageText,
  groupQuotaMenuRows,
  QUOTA_MENU_AMOUNT_ALPHA,
  QUOTA_MENU_BALANCE_X,
  QUOTA_MENU_BAR_X,
  QUOTA_MENU_BAR_H,
  QUOTA_MENU_BAR_W,
  QUOTA_MENU_BAR_Y,
  QUOTA_MENU_CHILD_ALPHA,
  QUOTA_MENU_CHILD_X,
  QUOTA_MENU_FILL_ALPHA,
  QUOTA_MENU_LINE_STEP,
  QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA,
  QUOTA_MENU_PACE_MARKER_ON_TRACK_ALPHA,
  QUOTA_MENU_PROVIDER_ALPHA,
  QUOTA_MENU_ROW_WIDTH,
  QUOTA_MENU_TRACK_ALPHA,
  renderQuotaMenuGroupBitmap,
  renderQuotaMenuRowBitmap,
} from '../src/main/quota-menu-icon';

function alphaAt(
  rendered: ReturnType<typeof renderQuotaMenuRowBitmap>,
  logicalX: number,
  logicalY: number,
): number {
  const x = logicalX * rendered.scale;
  const y = logicalY * rendered.scale;
  return rendered.buffer[(y * rendered.pixelWidth + x) * 4 + 3];
}

/** Count filled (fill-alpha) pixels strictly inside the bar region. */
function countFill(rendered: ReturnType<typeof renderQuotaMenuRowBitmap>): number {
  const x0 = QUOTA_MENU_BAR_X * rendered.scale;
  const y0 = QUOTA_MENU_BAR_Y * rendered.scale;
  const x1 = x0 + QUOTA_MENU_BAR_W * rendered.scale;
  const y1 = y0 + QUOTA_MENU_BAR_H * rendered.scale;
  let count = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * rendered.pixelWidth + px) * 4;
      if (rendered.buffer[i + 3] === QUOTA_MENU_FILL_ALPHA) count += 1;
    }
  }
  return count;
}

const sample = {
  provider: 'codex',
  window: '7d',
  remainingPct: 100,
  expectedRemainingPct: null,
  label: 'codex 7d 100%',
};

const kimi5 = {
  provider: 'kimi-coding',
  window: '5h',
  remainingPct: 100,
  expectedRemainingPct: null,
  label: 'kimi-coding 5h 100%',
};
const kimi7 = {
  provider: '',
  window: '7d',
  remainingPct: 97,
  expectedRemainingPct: 52,
  label: 'kimi-coding 7d 97%',
};

describe('quota menu row bitmap', () => {
  it('formats visible percentages without the remain suffix', () => {
    expect(formatQuotaMenuPercentageText(99.8)).toBe('99%');
    expect(formatQuotaMenuPercentageText(50)).toBe('50%');
  });

  it('uses the tightened columns and trims trailing bitmap whitespace', () => {
    const rendered = renderQuotaMenuRowBitmap(sample);
    expect(QUOTA_MENU_CHILD_X).toBe(108);
    expect(QUOTA_MENU_BAR_X - QUOTA_MENU_CHILD_X).toBe(32);
    expect(QUOTA_MENU_ROW_WIDTH).toBe(280);
    expect(rendered.pixelWidth / rendered.scale).toBe(280);
  });

  it('fills remaining from the left and leaves 0% empty', () => {
    const empty = renderQuotaMenuRowBitmap({ ...sample, remainingPct: 0, label: 'codex 7d 0%' });
    const full = renderQuotaMenuRowBitmap(sample);
    expect(countFill(empty)).toBe(0);
    expect(countFill(full)).toBe(QUOTA_MENU_BAR_W * QUOTA_MENU_BAR_H * 2 * 2);
  });

  it('keeps the pace marker at 1x bar height and contrasts it against fill or track', () => {
    const overFill = renderQuotaMenuRowBitmap({
      ...sample,
      expectedRemainingPct: 50,
    });
    const overTrack = renderQuotaMenuRowBitmap({
      ...sample,
      remainingPct: 25,
      expectedRemainingPct: 50,
    });
    const markerX = QUOTA_MENU_BAR_X + Math.round(QUOTA_MENU_BAR_W * 0.5);

    expect(alphaAt(overFill, markerX, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA);
    expect(alphaAt(overTrack, markerX, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_PACE_MARKER_ON_TRACK_ALPHA);
    expect(alphaAt(overFill, markerX - 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(overFill, markerX + 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(overFill, markerX, QUOTA_MENU_BAR_Y - 1)).toBe(0);
    expect(alphaAt(overFill, markerX, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H)).toBe(0);
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
    expect(countFill(row)).toBe(0);
  });

  it('draws provider/bal/amount pixels for a balance row with zero progress fill', () => {
    const row = renderQuotaMenuRowBitmap({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek bal ¥12.50',
      balances: [{ provider: 'deepseek', currency: 'CNY', amount: '12.50', display: '¥12.50', label: 'deepseek bal ¥12.50' }],
    });
    // No solid bar track/fill reaches the far right bar edge (short amount text cannot).
    expect(alphaAt(row, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y)).toBe(0);
    expect(alphaAt(row, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H - 1)).toBe(0);
    // bal shares the same left edge as every other child-column label.
    expect(QUOTA_MENU_BALANCE_X).toBe(QUOTA_MENU_CHILD_X);
    expect(alphaAt(row, QUOTA_MENU_BALANCE_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_CHILD_ALPHA);
    // Amount starts exactly at the bar column and is strong.
    expect(alphaAt(row, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_AMOUNT_ALPHA);
  });

  it('retains template image behavior for balance rows', () => {
    setTemplateImage.mockClear();
    createQuotaMenuRowIcon({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek bal ¥12.50',
      balances: [{ provider: 'deepseek', currency: 'CNY', amount: '12.50', display: '¥12.50', label: 'deepseek bal ¥12.50' }],
    });
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });

  it('marks the row image as a macOS template so AppKit tints it', () => {
    setTemplateImage.mockClear();
    createQuotaMenuRowIcon(sample);
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });

  it('groups consecutive rows of one provider and splits providers', () => {
    const groups = groupQuotaMenuRows([kimi5, kimi7, sample]);
    expect(groups).toHaveLength(2);
    expect(groups[0].provider).toBe('kimi-coding');
    expect(groups[0].lines).toHaveLength(2);
    expect(groups[1].provider).toBe('codex');
    expect(groups[1].lines).toHaveLength(1);
  });

  it('computes dynamic group height and steps child lines at 16px', () => {
    const single = renderQuotaMenuGroupBitmap({ provider: 'codex', lines: [sample] });
    const two = renderQuotaMenuGroupBitmap({ provider: 'kimi-coding', lines: [kimi5, kimi7] });
    expect(single.pixelHeight / single.scale).toBe(22);
    expect(two.pixelHeight / two.scale).toBe(31);
    // Child text on line 1 sits 16px below child text on line 0.
    expect(alphaAt(two, QUOTA_MENU_CHILD_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_CHILD_ALPHA);
    expect(alphaAt(two, QUOTA_MENU_CHILD_X, QUOTA_MENU_BAR_Y + QUOTA_MENU_LINE_STEP)).toBe(QUOTA_MENU_CHILD_ALPHA);
  });

  it('renders provider at regular glyph weight with full alpha and a lower-alpha child', () => {
    const g = renderQuotaMenuGroupBitmap({ provider: 'kimi-coding', lines: [{ ...kimi5, window: '7d', label: 'kimi-coding 7d 100%' }] });
    // Provider glyph (first char 'k' top-left) is full alpha at the top edge.
    expect(alphaAt(g, 8, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_PROVIDER_ALPHA);
    // Provider uses the regular 5x7 glyph: row index 6 is present and index 7 is empty.
    expect(alphaAt(g, 8, QUOTA_MENU_BAR_Y + 6)).toBe(QUOTA_MENU_PROVIDER_ALPHA);
    expect(alphaAt(g, 8, QUOTA_MENU_BAR_Y + 7)).toBe(0);
    // Child glyph is lower alpha and single-height (empty 8px below its top).
    expect(alphaAt(g, QUOTA_MENU_CHILD_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_CHILD_ALPHA);
    expect(alphaAt(g, QUOTA_MENU_CHILD_X, QUOTA_MENU_BAR_Y + 8)).toBe(0);
  });

  it('indents child labels relative to the old window column', () => {
    const g = renderQuotaMenuRowBitmap(sample);
    // Nothing at the parent column (104) where the child used to start.
    expect(alphaAt(g, 104, QUOTA_MENU_BAR_Y)).toBe(0);
    // Child text present at the indented column (110).
    expect(alphaAt(g, QUOTA_MENU_CHILD_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_CHILD_ALPHA);
  });

  it('deepens track/fill contrast', () => {
    const low = renderQuotaMenuRowBitmap({ ...sample, remainingPct: 25 });
    // Leading fill is fully opaque.
    expect(alphaAt(low, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    // Exposed track on the unfilled tail uses the higher track alpha.
    expect(alphaAt(low, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_TRACK_ALPHA);
  });

  it('preserves 100x6 bar and 1x6 pace marker geometry', () => {
    const full = renderQuotaMenuRowBitmap({ ...sample, expectedRemainingPct: 50 });
    // Corners of the full 100x6 bar are solid fill.
    expect(alphaAt(full, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(full, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(full, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H - 1)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(full, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H - 1)).toBe(QUOTA_MENU_FILL_ALPHA);
    // Outside pixels are empty.
    expect(alphaAt(full, QUOTA_MENU_BAR_X - 1, QUOTA_MENU_BAR_Y)).toBe(0);
    expect(alphaAt(full, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W, QUOTA_MENU_BAR_Y)).toBe(0);
    expect(alphaAt(full, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y - 1)).toBe(0);
    expect(alphaAt(full, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y + QUOTA_MENU_BAR_H)).toBe(0);
    // Exactly the marker column (1 logical col x 6 rows) is overwritten off fill.
    expect(countFill(full)).toBe(QUOTA_MENU_BAR_W * QUOTA_MENU_BAR_H * 2 * 2 - QUOTA_MENU_BAR_H * 2 * 2);
    const markerX = QUOTA_MENU_BAR_X + Math.round(QUOTA_MENU_BAR_W * 0.5);
    for (let y = 0; y < QUOTA_MENU_BAR_H; y++) {
      expect(alphaAt(full, markerX, QUOTA_MENU_BAR_Y + y)).toBe(QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA);
    }
    // One pixel wide: neighbors are fill.
    expect(alphaAt(full, markerX - 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
    expect(alphaAt(full, markerX + 1, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_FILL_ALPHA);
  });

  it('left-aligns balance bal in the label column and amount at the bar column with no bar semantics', () => {
    const row = renderQuotaMenuRowBitmap({
      provider: 'deepseek',
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      label: 'deepseek bal ¥12.50',
      balances: [{ provider: 'deepseek', currency: 'CNY', amount: '12.50', display: '¥12.50', label: 'deepseek bal ¥12.50' }],
    });
    // bal shares the same left edge as child labels at lower alpha.
    expect(QUOTA_MENU_BALANCE_X).toBe(QUOTA_MENU_CHILD_X);
    expect(alphaAt(row, QUOTA_MENU_BALANCE_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_CHILD_ALPHA);
    // Amount starts exactly at the bar column and is strong.
    expect(alphaAt(row, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y)).toBe(QUOTA_MENU_AMOUNT_ALPHA);
    // No solid bar track/fill reaches the far right edge where short amount text cannot.
    expect(alphaAt(row, QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, QUOTA_MENU_BAR_Y)).toBe(0);
  });
});
