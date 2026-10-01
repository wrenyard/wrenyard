import { BrowserWindow, type WebPreferences } from 'electron';
import {
  overlaySkipsTaskbar,
  overlayWorkspaceVisibilityOptions,
} from './overlay-window-policy';
import { SHELL_CHANNELS, type ResolvedAppearance } from '../../../shell-contract.js';

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
 * Every Pet window that mirrors the resolved appearance (transparent overlays
 * and the themed transcript). The registry lives beside the overlay factory so
 * a new overlay is tracked automatically and can never miss a live appearance
 * update.
 */
const petAppearanceWindows = new Set<BrowserWindow>();

function trackAppearanceWindow(win: BrowserWindow): void {
  petAppearanceWindows.add(win);
  win.once('closed', () => {
    petAppearanceWindows.delete(win);
  });
}

/**
 * Register a themed Pet window that the overlay factory does not construct —
 * currently the task transcript, which is opaque and appearance-attached.
 */
export function registerThemedPetWindow(win: BrowserWindow): void {
  trackAppearanceWindow(win);
}

/**
 * Push the resolved appearance to every live Pet window. Called from the sole
 * appearance `onChanged` hook in `main.ts`, alongside the shell notification.
 */
export function broadcastPetAppearance(appearance: ResolvedAppearance): void {
  for (const win of petAppearanceWindows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      petAppearanceWindows.delete(win);
      continue;
    }
    win.webContents.send(SHELL_CHANNELS.appearanceChanged, appearance);
  }
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
