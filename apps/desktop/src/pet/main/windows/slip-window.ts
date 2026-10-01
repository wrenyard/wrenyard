// ── Graph Slip window ────────────────────────────────────────────────
// Transparent, resizable Graph Slip surface. The owner keeps the slip state
// machine (manual size/move arming, initial auto-size, show gating); this
// module only constructs the transparent carrier and forwards its window
// events so the transparent-window invariants live in one place.

import type { BrowserWindow, Rectangle } from 'electron';
import type { PageLoader } from '../../../pages.js';
import { createOverlayWindow } from './overlay-window';

export interface GraphSlipWindowOptions {
  bounds: Rectangle;
  minWidth: number;
  minHeight: number;
  preloadPath: string;
  /** Capture harness only: render without ever showing the window. */
  stayHidden: boolean;
  pageLoader: PageLoader;
  graphId: string;
  /** Called once after a load failure; the owner closes the slip. */
  onLoadFailure(): void;
  onDidFinishLoad(): void;
  onReady(): void;
  onWillResize(): void;
  onWillMove(): void;
  onMove(bounds: Rectangle): void;
  onResize(bounds: Rectangle): void;
  onClosed(): void;
}

export function createGraphSlipWindow(options: GraphSlipWindowOptions): BrowserWindow {
  const win = createOverlayWindow({
    x: options.bounds.x,
    y: options.bounds.y,
    width: options.bounds.width,
    height: options.bounds.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    preloadPath: options.preloadPath,
    resizable: true,
    focusable: true,
    ...(options.stayHidden ? { paintWhenInitiallyHidden: true } : {}),
  });

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
    if (!win.isDestroyed() && !loadFailed) options.onDidFinishLoad();
  });

  options.pageLoader.load(win, 'graph-slip', { panel: 'slip', graph_id: options.graphId }).catch(() => handleLoadFailure());

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && !loadFailed) options.onReady();
  });

  win.on('will-resize', () => options.onWillResize());
  win.on('will-move', () => options.onWillMove());
  win.on('move', () => {
    if (win.isDestroyed()) return;
    options.onMove(win.getBounds());
  });
  win.on('resize', () => {
    if (win.isDestroyed()) return;
    options.onResize(win.getBounds());
  });
  win.on('closed', () => options.onClosed());

  return win;
}
