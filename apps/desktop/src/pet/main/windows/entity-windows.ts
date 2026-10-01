import { BrowserWindow } from 'electron';
import type { PageLoader } from '../../../pages.js';
import { DisplayRect } from './display-placement';
import { createOverlayWindow } from './overlay-window';

export interface EntityWindowOptions {
  preloadPath: string;
  pageLoader: PageLoader;
  page: 'house' | 'worker';
  bounds: DisplayRect;
  visible: boolean;
  /** Current owner visibility, including changes while the renderer loads. */
  isVisible?: () => boolean;
}

export function createHouseWindow(options: EntityWindowOptions): BrowserWindow {
  return createEntityWindow(options);
}

export function createWorkerWindow(options: EntityWindowOptions): BrowserWindow {
  return createEntityWindow(options);
}

function createEntityWindow(options: EntityWindowOptions): BrowserWindow {
  const win = createOverlayWindow({
    x: options.bounds.x,
    y: options.bounds.y,
    width: options.bounds.width,
    height: options.bounds.height,
    preloadPath: options.preloadPath,
    focusable: true,
  });

  // Overlay entities have no context menu; product controls live in Desktop.
  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // ── Fail-closed loading: keep a failed entity window hidden ────
  let loadFailed = false;
  const handleLoadFailure = (): void => {
    if (loadFailed) return;
    loadFailed = true;
    console.warn('entity window load failed');
    if (!win.isDestroyed()) {
      win.hide();
    }
  };

  win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) handleLoadFailure();
  });

  options.pageLoader.load(win, options.page).catch(() => {
    handleLoadFailure();
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && (options.isVisible?.() ?? options.visible) && !loadFailed) {
      win.showInactive();
    }
  });

  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) {
      win.webContents.reload();
    }
  });

  return win;
}
