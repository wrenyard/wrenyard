import { app, BrowserWindow } from 'electron';
import { DisplayRect } from './display-placement';

export interface EntityWindowOptions {
  preloadPath: string;
  htmlPath: string;
  bounds: DisplayRect;
  visible: boolean;
  /** Called after a render-process recovery reload completes, so the
   *  consumer can re-push current state before the next frame. */
  onRendererRecovered?: () => void;
}

export function createHouseWindow(options: EntityWindowOptions): BrowserWindow {
  return createEntityWindow(options);
}

export function createWorkerWindow(options: EntityWindowOptions): BrowserWindow {
  return createEntityWindow(options);
}

function createEntityWindow(options: EntityWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    x: options.bounds.x,
    y: options.bounds.y,
    width: options.bounds.width,
    height: options.bounds.height,
    transparent: true,
    frame: false,
    thickFrame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: options.preloadPath,
    },
  });

  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Overlay entities have no context menu; settings/restart live on the tray.
  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // ── Deny renderer-created child windows ────────────────────────
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-create-window', (childWin) => {
    console.warn('entity window detected unexpected child; destroying');
    if (!childWin.isDestroyed()) {
      childWin.destroy();
    }
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

  win.loadFile(options.htmlPath).catch(() => {
    handleLoadFailure();
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && options.visible && !loadFailed) {
      win.showInactive();
    }
  });

  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) {
      // Re-register did-finish-load so a recovered renderer gets state
      win.webContents.once('did-finish-load', () => {
        options.onRendererRecovered?.();
      });
      win.webContents.reload();
    }
  });

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  return win;
}
