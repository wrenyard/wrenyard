import { BrowserWindow, type WebPreferences } from 'electron';
import {
  overlaySkipsTaskbar,
  overlayWorkspaceVisibilityOptions,
} from './overlay-window-policy';

export interface OverlayWindowOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  /** Preload script for the overlay renderer. */
  preloadPath: string;
  /** Allow the user to resize the window (default `false`). */
  resizable?: boolean;
  /** Receive mouse events without first activating the app (default `true`). */
  focusable?: boolean;
  /** Override the platform taskbar policy (defaults to `overlaySkipsTaskbar`). */
  skipTaskbar?: boolean;
  /** Keep painting while hidden; required by capture harnesses. */
  paintWhenInitiallyHidden?: boolean;
  /** Extra web preferences merged over the overlay defaults. */
  webPreferences?: Omit<WebPreferences, 'preload'>;
}

/**
 * The single factory for transparent Pet overlay windows (house, worker,
 * TaskGraph entity, Graph Slip). It owns the transparency invariants —
 * transparent, borderless, shadowless, always on top — and never registers the
 * window with the appearance controller, so a transparent overlay can never be
 * painted with the themed `windowBackground`.
 */
export function createOverlayWindow(options: OverlayWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...(options.x !== undefined ? { x: options.x } : {}),
    ...(options.y !== undefined ? { y: options.y } : {}),
    width: options.width,
    height: options.height,
    ...(options.minWidth !== undefined ? { minWidth: options.minWidth } : {}),
    ...(options.minHeight !== undefined ? { minHeight: options.minHeight } : {}),
    transparent: true,
    frame: false,
    thickFrame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    skipTaskbar: options.skipTaskbar ?? overlaySkipsTaskbar(),
    alwaysOnTop: true,
    focusable: options.focusable ?? true,
    resizable: options.resizable ?? false,
    show: false,
    acceptFirstMouse: true,
    ...(options.paintWhenInitiallyHidden ? { paintWhenInitiallyHidden: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...options.webPreferences,
      preload: options.preloadPath,
    },
  });

  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, overlayWorkspaceVisibilityOptions());
  // Overlay windows never open renderer-created child windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-create-window', (childWin) => {
    if (!childWin.isDestroyed()) childWin.destroy();
  });

  return win;
}
