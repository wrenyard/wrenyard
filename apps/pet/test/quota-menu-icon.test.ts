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
  QUOTA_MENU_BAR_H,
  QUOTA_MENU_BAR_W,
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

  it('marks the row image as a macOS template so AppKit tints it', () => {
    setTemplateImage.mockClear();
    createQuotaMenuRowIcon(sample);
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });
});
