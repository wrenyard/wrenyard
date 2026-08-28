import { describe, expect, it } from 'vitest';
import { overlaySkipsTaskbar } from '../src/main/overlay-window-policy';

describe('overlay window taskbar policy', () => {
  it('keeps the Desktop host visible in the macOS Dock', () => {
    expect(overlaySkipsTaskbar('darwin')).toBe(false);
  });

  it('keeps individual overlays out of Windows and Linux taskbars', () => {
    expect(overlaySkipsTaskbar('win32')).toBe(true);
    expect(overlaySkipsTaskbar('linux')).toBe(true);
  });
});
