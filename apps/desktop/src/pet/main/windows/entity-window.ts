// ── Blueprint Wren entity window ─────────────────────────────────────
// Owns transparent-window construction and load lifecycle for the Wren
// taskgraph entity. All entity state, IPC and placement stay in the owner;
// this module only wires the window-scoped behaviour so entity windows never
// duplicate the overlay invariants.

import type { BrowserWindow } from 'electron';
import type { PageLoader } from '../../../pages.js';
import { createOverlayWindow } from './overlay-window';
import { ENTITY_WINDOW_HEIGHT, ENTITY_WINDOW_WIDTH } from './placement';

export interface TaskGraphEntityWindowOptions {
  preloadPath: string;
  pageLoader: PageLoader;
  windowId: string;
  /** Capture harness only: render without ever showing the window. */
  stayHidden: boolean;
  /** Called once after a load failure; the owner removes the entity. */
  onLoadFailure(): void;
  /** Called on did-finish-load and ready-to-show to (re)push entity state. */
  onReady(): void;
  /** Whether the owning surface (entity visibility + Pet visible) is shown. */
  isVisible(): boolean;
}

export function createTaskGraphEntityWindow(options: TaskGraphEntityWindowOptions): BrowserWindow {
  const win = createOverlayWindow({
    width: ENTITY_WINDOW_WIDTH,
    height: ENTITY_WINDOW_HEIGHT,
    preloadPath: options.preloadPath,
    focusable: false,
    ...(options.stayHidden ? { paintWhenInitiallyHidden: true } : {}),
  });

  // Start with full window passthrough; only bird/fact-slip areas become interactive.
  win.setIgnoreMouseEvents(true, { forward: true });

  let loadFailed = false;
  const handleLoadFailure = (): void => {
    if (loadFailed) return;
    loadFailed = true;
    options.onLoadFailure();
  };

  win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) handleLoadFailure();
  });
  win.webContents.on('render-process-gone', () => handleLoadFailure());

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && !loadFailed) options.onReady();
  });
  options.pageLoader.load(win, 'entity', { entity_id: options.windowId }).catch(() => handleLoadFailure());

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && !loadFailed) {
      options.onReady();
      if (!options.stayHidden && options.isVisible()) win.showInactive();
    }
  });

  return win;
}
