import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import * as path from 'node:path';
import { AppConfig, WindowGeometry, saveConfig } from './config';
import type { DailyStatsSnapshot } from '../shared/snapshot';
import type { SummaryStats } from '../shared/entities';

const SETTINGS_WIDTH = 380;
const SETTINGS_HEIGHT = 560;
const STATS_WIDTH = 440;
const STATS_HEIGHT = 640;
const STATS_MIN_WIDTH = 400;
const STATS_MIN_HEIGHT = 480;

export interface PanelOwnerOptions {
  config: AppConfig;
  htmlDir: string;
  preloadPath: string;
  onConfigChange: (config: AppConfig) => void;
  onStatsRequestRefresh: () => Promise<{ summary?: SummaryStats; dailyStats?: DailyStatsSnapshot } | undefined>;
  onRestart: () => void;
  onGetEnabledProviderOrder: () => string[];
  /** Returns the owner application's house window, or null if not available.
   *  Used by requireHouseWindow for sender-identity checks. */
  getHouseWindow: () => BrowserWindow | null;
  /** Invoked when the house skin selection changes via settings. */
  onHouseSkinChange?: (skin: 'classic' | 'mushroom') => void;
}

export class PanelOwner {
  private settingsWindow: BrowserWindow | null = null;
  private statsWindow: BrowserWindow | null = null;
  private readonly config: AppConfig;
  private readonly htmlDir: string;
  private readonly preloadPath: string;
  private readonly onConfigChange: (config: AppConfig) => void;
  private readonly onStatsRequestRefresh: () => Promise<{ summary?: SummaryStats; dailyStats?: DailyStatsSnapshot } | undefined>;
  private readonly onRestart: () => void;
  private readonly onGetEnabledProviderOrder: () => string[];
  private readonly getHouseWindow: () => BrowserWindow | null;
  private readonly onHouseSkinChange: ((skin: 'classic' | 'mushroom') => void) | undefined;
  private statsCache: {
    summary?: SummaryStats;
    dailyStats?: DailyStatsSnapshot;
  } = {};

  constructor(opts: PanelOwnerOptions) {
    this.config = opts.config;
    this.htmlDir = opts.htmlDir;
    this.preloadPath = opts.preloadPath;
    this.onConfigChange = opts.onConfigChange;
    this.onStatsRequestRefresh = opts.onStatsRequestRefresh;
    this.onRestart = opts.onRestart;
    this.onGetEnabledProviderOrder = opts.onGetEnabledProviderOrder;
    this.getHouseWindow = opts.getHouseWindow;
    this.onHouseSkinChange = opts.onHouseSkinChange;
    this.registerIpcHandlers();
  }

  openSettings(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }
    this.settingsWindow = this.createPanelWindow('settings', this.config.windows.settings);
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
  }

  openStats(cachedSummary?: SummaryStats, cachedDaily?: DailyStatsSnapshot): void {
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.focus();
      return;
    }
    if (cachedSummary) {
      this.statsCache.summary = cachedSummary;
      if (cachedDaily) this.statsCache.dailyStats = cachedDaily;
    }
    this.statsWindow = this.createPanelWindow('stats', this.config.windows.stats);
    this.statsWindow.on('closed', () => {
      this.statsWindow = null;
    });
  }

  refreshStats(): void {
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.webContents.send('stats:data', { ...this.statsCache });
    }
  }

  /** Caller provides fresh summary data, e.g. from stats poller onSummaryStats */
  setStatsData(summary: SummaryStats, dailyStats?: DailyStatsSnapshot): void {
    this.statsCache.summary = summary;
    if (dailyStats) this.statsCache.dailyStats = dailyStats;
    this.publishStatsData();
  }

  setDailyStats(stats: DailyStatsSnapshot): void {
    this.statsCache.dailyStats = stats;
    this.publishStatsData();
  }

  private publishStatsData(): void {
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.webContents.send('stats:data', { ...this.statsCache });
    }
  }

  destroy(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.destroy();
    }
    this.settingsWindow = null;
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.destroy();
    }
    this.statsWindow = null;
  }

  private createPanelWindow(name: 'settings' | 'stats', savedGeo?: WindowGeometry): BrowserWindow {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;

    const isSettings = name === 'settings';
    const defaultWidth = isSettings ? SETTINGS_WIDTH : STATS_WIDTH;
    const defaultHeight = isSettings ? SETTINGS_HEIGHT : STATS_HEIGHT;

    let panelWidth: number;
    let panelHeight: number;
    if (savedGeo && typeof savedGeo.x === 'number' && typeof savedGeo.y === 'number') {
      panelWidth = isSettings ? defaultWidth : Math.max(STATS_MIN_WIDTH, savedGeo.width ?? defaultWidth);
      panelHeight = isSettings ? defaultHeight : Math.max(STATS_MIN_HEIGHT, savedGeo.height ?? defaultHeight);
    } else {
      panelWidth = defaultWidth;
      panelHeight = defaultHeight;
    }

    let x: number;
    let y: number;
    if (savedGeo && typeof savedGeo.x === 'number' && typeof savedGeo.y === 'number') {
      x = savedGeo.x;
      y = savedGeo.y;
    } else {
      x = Math.round(workArea.x + (workArea.width - panelWidth) / 2);
      y = Math.round(workArea.y + (workArea.height - panelHeight) / 2);
    }

    const win = new BrowserWindow({
      x,
      y,
      width: panelWidth,
      height: panelHeight,
      transparent: true,
      frame: false,
      thickFrame: false,
      resizable: !isSettings,
      minWidth: isSettings ? undefined : STATS_MIN_WIDTH,
      minHeight: isSettings ? undefined : STATS_MIN_HEIGHT,
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
        sandbox: true,
        preload: this.preloadPath,
      },
    });

    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // ── Deny renderer-created child windows ─────────────────────────
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.on('did-create-window', (childWin) => {
      console.warn(`${name} panel detected unexpected child; destroying`);
      if (!childWin.isDestroyed()) {
        childWin.destroy();
      }
    });

    // ── Fail-closed loading ────────────────────────────────────────
    let loadFailed = false;
    const handleLoadFailure = (): void => {
      if (loadFailed) return;
      loadFailed = true;
      console.warn(`${name} panel load failed`);
      if (!win.isDestroyed()) {
        win.close();
      }
    };

    win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) handleLoadFailure();
    });

    win.webContents.on('render-process-gone', () => {
      handleLoadFailure();
    });

    win.loadFile(path.join(this.htmlDir, `${name}.html`)).catch(() => {
      handleLoadFailure();
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !loadFailed) {
        win.showInactive();
      }
    });

    win.on('move', () => {
      this.persistWindowBounds(name, win);
    });

    win.on('resize', () => {
      this.persistWindowBounds(name, win);
    });

    if (process.platform === 'darwin') {
      app.dock?.hide();
    }

    return win;
  }

  private persistWindowBounds(name: 'stats' | 'settings', win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    this.config.windows[name] = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    this.onConfigChange(this.config);
  }

  private registerIpcHandlers(): void {
    // ─── Settings IPC ──────────────────────────────────────────────
    ipcMain.handle('settings:load', (event) => {
      if (!this.isOwnerSender(event, 'settings')) return undefined;
      return this.serializeConfig();
    });

    ipcMain.handle('settings:save', (event, partial: unknown) => {
      if (!this.isOwnerSender(event, 'settings')) return;
      this.applyPartialConfig(partial);
    });

    ipcMain.handle('settings:save-and-restart', (event) => {
      if (!this.isOwnerSender(event, 'settings')) return;
      this.onConfigChange(this.config);
      this.onRestart();
    });

    // ─── Stats IPC ─────────────────────────────────────────────────
    ipcMain.handle('stats:load', async (event) => {
      if (!this.isOwnerSender(event, 'stats')) return undefined;

      // Only fetch missing stats data
      if (!this.statsCache.summary && !this.statsCache.dailyStats) {
        const data = await this.onStatsRequestRefresh();
        if (data) {
          if (data.summary) this.statsCache.summary = data.summary;
          if (data.dailyStats) this.statsCache.dailyStats = data.dailyStats;
        }
      }

      const hasAny = this.statsCache.summary || this.statsCache.dailyStats;
      return hasAny ? { ...this.statsCache } : null;
    });

    // ─── Panel window close ────────────────────────────────────────
    ipcMain.on('panel:close', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
    });

    // ─── House action IPC ──────────────────────────────────────────
    ipcMain.handle('house:open-settings', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== this.requireHouseWindow()) {
        console.warn('house:open-settings rejected: sender does not match house window');
        return;
      }
      this.openSettings();
    });

    ipcMain.handle('house:open-stats', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== this.requireHouseWindow()) {
        console.warn('house:open-stats rejected: sender does not match house window');
        return;
      }
      this.openStats();
    });
  }

  private isOwnerSender(event: IpcMainEvent | Electron.IpcMainInvokeEvent, panel: 'settings' | 'stats'): boolean {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender.isDestroyed()) return false;
    const expected = panel === 'settings' ? this.settingsWindow : this.statsWindow;
    if (!expected || expected.isDestroyed()) return false;
    return sender === expected;
  }

  private requireHouseWindow(): BrowserWindow | null {
    const win = this.getHouseWindow();
    if (win && !win.isDestroyed()) return win;
    return null;
  }

  private serializeConfig(): Record<string, unknown> {
    return {
      scale: this.config.scale,
      bubbleSeconds: this.config.bubbleSeconds,
      bottomOffset: this.config.bottomOffset,
      entities: { ...this.config.entities },
      appearance: { ...this.config.appearance },
      quota: {
        providers: this.config.quota.providers.map((p) => ({ ...p })),
      },
    };
  }

  private applyPartialConfig(partial: unknown): AppConfig {
    const obj = partial && typeof partial === 'object' ? partial as Record<string, unknown> : {};
    const cfg = { ...this.config };
    let skinChanged = false;

    if (typeof obj.scale === 'number') cfg.scale = Math.max(1, Math.min(6, Math.round(obj.scale)));
    if (typeof obj.bubbleSeconds === 'number') cfg.bubbleSeconds = Math.max(1, Math.min(60, Math.round(obj.bubbleSeconds)));
    if (typeof obj.bottomOffset === 'number') cfg.bottomOffset = Math.max(0, Math.min(512, Math.round(obj.bottomOffset)));
    if (obj.entities && typeof obj.entities === 'object') {
      const e = obj.entities as Record<string, unknown>;
      if (typeof e.house === 'boolean') cfg.entities.house = e.house;
      if (typeof e.workers === 'boolean') cfg.entities.workers = e.workers;
    }
    if (obj.appearance && typeof obj.appearance === 'object') {
      const a = obj.appearance as Record<string, unknown>;
      if (a.houseSkin === 'classic' || a.houseSkin === 'mushroom') {
        const prev = cfg.appearance?.houseSkin ?? 'classic';
        if (a.houseSkin !== prev) {
          cfg.appearance = { ...(cfg.appearance ?? { houseSkin: 'classic' }), houseSkin: a.houseSkin };
          skinChanged = true;
        }
      }
    }
    if (obj.quota && typeof obj.quota === 'object') {
      const q = obj.quota as Record<string, unknown>;
      if (Array.isArray(q.providers)) {
        cfg.quota.providers = q.providers.map((p: unknown) => {
          const entry = p && typeof p === 'object' ? p as Record<string, unknown> : {};
          return {
            id: typeof entry.id === 'string' ? entry.id : '',
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
          };
        }).filter((p) => p.id.length > 0);
      }
    }

    // Synchronize the in-memory config and fire notifications
    Object.assign(this.config, cfg);
    this.onConfigChange(this.config);
    if (skinChanged && this.onHouseSkinChange) {
      this.onHouseSkinChange(this.config.appearance.houseSkin);
    }
    return cfg;
  }
}
