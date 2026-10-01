import { describe, it, expect, vi } from 'vitest';

// Electron is unavailable under Vitest; mock only what the appearance
// controller touches so the attach/refresh bookkeeping runs for real.
const nativeThemeMock = vi.hoisted(() => ({
  themeSource: 'system',
  shouldUseDarkColors: false,
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp', dock: undefined },
  nativeTheme: nativeThemeMock,
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
}));

import { DesktopAppearanceController } from '../../src/main/appearance';

function createMockWindow() {
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  const win = {
    isDestroyed: () => destroyed,
    getBackgroundColor: vi.fn(() => '#000000'),
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setIcon: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => {
      handlers.set(event, callback);
    }),
  };
  return {
    win,
    emitClosed: () => {
      destroyed = true;
      handlers.get('closed')?.();
    },
  };
}

function createController(): DesktopAppearanceController {
  const store = {
    load: () => ({ appearance: { theme: 'paper', colorMode: 'light', motion: 'reduce', zoom: 100 } }),
    patch: vi.fn(),
  };
  return new DesktopAppearanceController({ store: store as never });
}

describe('DesktopAppearanceController attach bookkeeping', () => {
  it('applies the resolved appearance immediately when a window attaches', () => {
    const controller = createController();
    const { win } = createMockWindow();

    controller.attach(win as never);

    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1);
  });

  it('refresh only re-applies to attached windows', () => {
    const controller = createController();
    const attached = createMockWindow();
    const transparentOverlay = createMockWindow();
    controller.attach(attached.win as never);
    attached.win.setBackgroundColor.mockClear();

    controller.refresh();

    expect(attached.win.setBackgroundColor).toHaveBeenCalledTimes(1);
    expect(transparentOverlay.win.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('stops re-applying to a window after it closes', () => {
    const controller = createController();
    const { win, emitClosed } = createMockWindow();
    controller.attach(win as never);
    win.setBackgroundColor.mockClear();

    emitClosed();
    controller.refresh();

    expect(win.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('ignores a duplicate attach of the same window', () => {
    const controller = createController();
    const { win } = createMockWindow();

    controller.attach(win as never);
    controller.attach(win as never);

    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1);
  });

  it('never guesses transparency through getBackgroundColor', () => {
    const controller = createController();
    const { win } = createMockWindow();

    controller.attach(win as never);

    // The removed #00000000 probe called this and always saw an alpha-less
    // "#000000"; attaching must no longer consult it at all.
    expect(win.getBackgroundColor).not.toHaveBeenCalled();
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1);
  });
});
