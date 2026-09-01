import { describe, expect, it } from 'vitest';
import {
  overlaySkipsTaskbar,
  overlayWorkspaceVisibilityOptions,
} from '../src/main/overlay-window-policy';

describe('overlay window taskbar policy', () => {
  it('keeps the Desktop host visible in the macOS Dock', () => {
    expect(overlaySkipsTaskbar('darwin')).toBe(false);
  });

  it('keeps individual overlays out of Windows and Linux taskbars', () => {
    expect(overlaySkipsTaskbar('win32')).toBe(true);
    expect(overlaySkipsTaskbar('linux')).toBe(true);
  });

  it('does not transform the macOS Desktop host into a UIElement application', () => {
    expect(overlayWorkspaceVisibilityOptions('darwin')).toEqual({
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  });

  it('keeps the cross-workspace policy minimal outside macOS', () => {
    expect(overlayWorkspaceVisibilityOptions('win32')).toEqual({ visibleOnFullScreen: true });
    expect(overlayWorkspaceVisibilityOptions('linux')).toEqual({ visibleOnFullScreen: true });
  });
});
