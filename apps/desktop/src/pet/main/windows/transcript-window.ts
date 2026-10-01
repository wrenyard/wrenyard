// ── Task transcript window ───────────────────────────────────────────
// Themed (non-transparent) transcript window for a single task run. This
// module owns construction, appearance attachment and load lifecycle; the
// owner owns the window registry, the incremental event poller and IPC.

import { BrowserWindow } from 'electron';
import type { PageLoader } from '../../../pages.js';
import { registerThemedPetWindow } from './overlay-window';

export const TRANSCRIPT_WIDTH = 420;
export const TRANSCRIPT_HEIGHT = 520;
export const TRANSCRIPT_MIN_WIDTH = 340;
export const TRANSCRIPT_MIN_HEIGHT = 360;

export interface TranscriptWindowOptions {
  taskRunId: string;
  nodeId: string;
  taskLabel: string;
  /** Centered initial bounds for a new transcript window. */
  bounds: { x: number; y: number };
  preloadPath: string;
  /** Capture harness only: render without ever showing the window. */
  stayHidden: boolean;
  pageLoader: PageLoader;
  /** Register the themed window with the appearance controller. */
  attachAppearance?(window: BrowserWindow): void;
  onLoadFailure(): void;
  onDidFinishLoad(): void;
  onReady(): void;
  onClosed(): void;
}

export function createTranscriptWindow(options: TranscriptWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    x: options.bounds.x,
    y: options.bounds.y,
    width: TRANSCRIPT_WIDTH,
    height: TRANSCRIPT_HEIGHT,
    minWidth: TRANSCRIPT_MIN_WIDTH,
    minHeight: TRANSCRIPT_MIN_HEIGHT,
    transparent: false,
    frame: true,
    thickFrame: false,
    hasShadow: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    focusable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    title: options.taskLabel,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : {}),
    show: false,
    ...(options.stayHidden ? { paintWhenInitiallyHidden: true } : {}),
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: options.preloadPath,
    },
  });
  // Themed window: follow the resolved appearance instead of a hardcoded paper.
  options.attachAppearance?.(win);
  // Opaque Pet window: mirror live appearance updates through the Pet registry.
  registerThemedPetWindow(win);

  win.setMenuBarVisibility(false);
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-create-window', (childWin) => {
    if (!childWin.isDestroyed()) childWin.destroy();
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

  options.pageLoader.load(win, 'transcript', {
    task_run_id: options.taskRunId, node_id: options.nodeId, task_label: options.taskLabel, platform: process.platform,
  }).catch(() => handleLoadFailure());

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && !loadFailed) options.onReady();
  });

  win.on('closed', () => options.onClosed());

  return win;
}

/**
 * Canonical standalone transcript node id for a direct (non-TaskGraph) task
 * run. A standalone run has no graph/node, so the run id itself is the stable
 * node identity — callers never synthesize an arbitrary graph node id.
 */
export function standaloneTranscriptNodeId(taskRunId: string): string {
  return taskRunId;
}
