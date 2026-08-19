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

import { nativeImage } from 'electron';
import {
  TRAY_HOUSE_GLYPH,
  TRAY_ICON_FILL_ALPHA,
  TRAY_ICON_SCALE,
  TRAY_ICON_SIZE,
  createTrayIcon,
  renderTrayIconBitmap,
} from '../src/main/tray-icon';

function countFill(buffer: Buffer): number {
  let count = 0;
  for (let i = 3; i < buffer.length; i += 4) {
    if (buffer[i] === TRAY_ICON_FILL_ALPHA) count += 1;
  }
  return count;
}

describe('tray house icon', () => {
  it('is a fixed 18×18 house glyph with chimney, windows, and door holes', () => {
    expect(TRAY_HOUSE_GLYPH).toHaveLength(TRAY_ICON_SIZE);
    expect(TRAY_HOUSE_GLYPH.every((row) => row.length === TRAY_ICON_SIZE)).toBe(true);
    const filled = TRAY_HOUSE_GLYPH.join('');
    expect(filled.includes('#')).toBe(true);
    expect(filled.includes(' ')).toBe(true);
    expect(TRAY_HOUSE_GLYPH[3]?.startsWith('   ##')).toBe(true);
    expect(TRAY_HOUSE_GLYPH[9]).toBe('  ##  ##  ##  ##  ');
    expect(TRAY_HOUSE_GLYPH[13]).toBe('  ##    ##    ##  ');
  });

  it('renders an 18pt @2x bitmap from the glyph', () => {
    const rendered = renderTrayIconBitmap();
    expect(rendered.pixelWidth).toBe(TRAY_ICON_SIZE * TRAY_ICON_SCALE);
    expect(rendered.pixelHeight).toBe(TRAY_ICON_SIZE * TRAY_ICON_SCALE);
    expect(rendered.scale).toBe(2);
    const glyphPixels = TRAY_HOUSE_GLYPH.join('').split('#').length - 1;
    expect(countFill(rendered.buffer)).toBe(glyphPixels * TRAY_ICON_SCALE * TRAY_ICON_SCALE);
  });

  it('marks the tray image as a macOS template', () => {
    setTemplateImage.mockClear();
    vi.mocked(nativeImage.createFromBuffer).mockClear();
    createTrayIcon();
    expect(setTemplateImage).toHaveBeenCalledWith(true);
    expect(nativeImage.createFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), {
      width: 36,
      height: 36,
      scaleFactor: 2,
    });
  });
});
