import { BrowserWindow, type WebContents, type WebPreferences } from 'electron';
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
  /** Capture harness only: render without ever showing the window. */
  stayHidden?: boolean;
  /** Whether the owning surface currently wants this window shown. */
  isVisible?: () => boolean;
  /** Called once when a main-frame load fails; the factory has already hidden the window. */
  onLoadFailure?: () => void;
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
 * Whether `sender` is the exact web contents of a currently registered live
 * Pet window. Stale registry entries are pruned as they are observed, so a
 * destroyed or unknown sender can never retain trust. Callers use this to
 * admit the narrow read-only channels an owned Pet surface needs; it grants no
 * shell trust and is never true for an arbitrary sender id.
 */
export function isRegisteredPetSender(sender: WebContents): boolean {
  if (sender.isDestroyed()) return false;
  for (const win of petAppearanceWindows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      petAppearanceWindows.delete(win);
      continue;
    }
    if (win.webContents === sender) return true;
  }
  return false;
}

/**
 * The single factory for transparent Pet overlay windows (house, worker,
 * TaskGraph entity, Graph Slip). It owns the transparency invariants —
 * transparent, borderless, shadowless, always on top — and never registers the
 * window with the appearance controller, so a transparent overlay can never be
 * painted with the themed `windowBackground`.
 *
 * It also owns the shared load lifecycle so every overlay fails the same way:
 * a main-frame load failure hides the window and is reported once, while a
 * renderer crash reloads the web contents. A window that was visible before the
 * crash is restored only after the reload succeeds and the owner still wants it
 * shown, so a deliberate user-hide and the capture `stayHidden` mode survive a
 * crash. `transparent: true` is confined to this factory.
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
    ...(options.paintWhenInitiallyHidden || options.stayHidden ? { paintWhenInitiallyHidden: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...options.webPreferences,
      preload: options.preloadPath,
    },
  });

  trackAppearanceWindow(win);
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, overlayWorkspaceVisibilityOptions());
  // Overlay windows never open renderer-created child windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-create-window', (childWin) => {
    if (!childWin.isDestroyed()) childWin.destroy();
  });

  let loadFailed = false;
  let visibleBeforeCrash = false;

  const reportLoadFailure = (): void => {
    if (loadFailed) return;
    loadFailed = true;
    if (!win.isDestroyed()) win.hide();
    options.onLoadFailure?.();
  };

  win.webContents.on('did-start-loading', () => { loadFailed = false; });

  win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) reportLoadFailure();
  });

  // A renderer crash reloads in place instead of destroying the window. The
  // previous visibility is captured so the window is not silently resurrected
  // after a deliberate user-hide.
  win.webContents.on('render-process-gone', () => {
    if (win.isDestroyed()) return;
    visibleBeforeCrash = !options.stayHidden && isWindowVisible(win);
    win.hide();
    win.webContents.reload();
  });

  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed() || loadFailed) return;
    if (visibleBeforeCrash && (options.isVisible?.() ?? true)) win.showInactive();
    visibleBeforeCrash = false;
  });

  return win;
}

function isWindowVisible(win: BrowserWindow): boolean {
  const candidate = win as unknown as { isVisible?: () => boolean };
  return typeof candidate.isVisible === 'function' ? candidate.isVisible() : false;
}
