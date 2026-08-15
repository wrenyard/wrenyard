import { BrowserWindow, screen, app } from 'electron';
import * as path from 'node:path';
import { bottomDockedBounds, resolveDisplay } from './display-placement';

const WINDOW_HEIGHT = 180;

export interface WindowPositionController {
  getActiveDisplayId(): number;
  setPreferredDisplayId(displayId: number): void;
  redock(): void;
}

export interface CreateWindowOptions {
  displayId?: number;
  bottomOffset?: number;
  onDisplayChanged?: () => void;
}

export interface CreatedWindow {
  window: BrowserWindow;
  position: WindowPositionController;
}

function getResolvedDisplay(preferredDisplayId?: number) {
  return resolveDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay(), preferredDisplayId);
}

export function createWindow(preloadPath: string, options: CreateWindowOptions = {}): CreatedWindow {
  let preferredDisplayId = options.displayId;
  let activeDisplayId = getResolvedDisplay(preferredDisplayId).id;

  const initialBounds = bottomDockedBounds(
    getResolvedDisplay(preferredDisplayId),
    WINDOW_HEIGHT,
    options.bottomOffset,
  );

  const win = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hide from dock on macOS
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  const positionWindow = () => {
    const display = getResolvedDisplay(preferredDisplayId);
    activeDisplayId = display.id;
    win.setBounds(bottomDockedBounds(display, WINDOW_HEIGHT, options.bottomOffset));
    options.onDisplayChanged?.();
  };

  // Re-dock on display changes
  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);

  // Auto-reload renderer on crash
  win.webContents.on('render-process-gone', (_event, _details) => {
    console.error('Render process gone, reloading...');
    win.webContents.reload();
  });

  return {
    window: win,
    position: {
      getActiveDisplayId: () => activeDisplayId,
      setPreferredDisplayId: (displayId: number) => {
        preferredDisplayId = displayId;
        positionWindow();
      },
      redock: positionWindow,
    },
  };
}
