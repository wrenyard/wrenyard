import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'node:path';
import { loadConfig, saveConfig } from './config';
import { SiteModel } from './site-model';
import { createTray } from './tray';
import { EntityManager } from './entity-manager';
import { ForemanEventPoller } from './foreman-event-poller';
import { ForemanStatsPoller } from './foreman-stats-poller';
import { ActivitySnapshotPoller } from './activity-snapshot-poller';
import { QuotaService } from './quota-service';
import { createDiagnosticLogger } from './diagnostic-logger';
import { requestForemanPetRestart } from './foreman-pet-control';
import { PanelOwner } from './panel-windows';
import { buildQuotaTips, formatQuotaBarMenuRows, type QuotaMenuRow } from './panel-view-model';
import type { SummaryStatsPayload } from './foreman-stats-poller';
import type { DailyStatsSnapshot } from '../shared/snapshot';
import type { QuotaProviderState } from '../shared/entities';
import { ForemanIpcClient } from './foreman-ipc-client';
import { TaskGraphWindowOwner } from './taskgraph-windows';
import type { ForgeEventSignal } from './forge-types';

let tray: ReturnType<typeof createTray> | null = null;
let model: SiteModel | null = null;
let modelTickTimer: ReturnType<typeof setInterval> | null = null;
let animationTickTimer: ReturnType<typeof setInterval> | null = null;
let foremanEventPoller: ForemanEventPoller | null = null;
let foremanStatsPoller: ForemanStatsPoller | null = null;
let activityPoller: ActivitySnapshotPoller | null = null;
let entityManager: EntityManager | null = null;
let quotaService: QuotaService | null = null;
let panelOwner: PanelOwner | null = null;
let lastSummary: SummaryStatsPayload | null = null;
let lastDailyStats: DailyStatsSnapshot | null = null;
let lastQuotaMenuRows: QuotaMenuRow[] = [];
let quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;
let taskGraphWindowOwner: TaskGraphWindowOwner | null = null;

const QUOTA_POLL_INTERVAL_MS = 60_000;

/**
 * Presence-affecting event signals are owned exclusively by the activity
 * snapshot. Only message/tool/usage signals may enrich the transient surface.
 */
function isTransientSignal(signal: ForgeEventSignal): boolean {
  return signal.kind === 'message'
    || signal.kind === 'tool_call'
    || signal.kind === 'tool_result'
    || signal.kind === 'turn_usage';
}

/**
 * Apply a fetched provider array to house quota tips only.
 * Extracted so refreshQuotaState uses identical formatting/ordering logic.
 */
function applyProvidersToHouseTips(providers: QuotaProviderState[]): void {
  if (!entityManager) return;
  const savedConfig = loadConfig();
  const order = savedConfig.quota.providers.filter((p) => p.enabled).map((p) => p.id);
  const tips = buildQuotaTips(providers, order);
  lastQuotaMenuRows = formatQuotaBarMenuRows(tips);
  entityManager.setQuotaTips(tips);
  tray?.rebuildMenu();
}

/**
 * Fetch the latest enabled-provider order from settings and build quota tips
 * for house hover.
 */
async function refreshQuotaState(force: boolean): Promise<void> {
  if (!quotaService || !entityManager) return;
  try {
    const providers = await quotaService.listProviders(force);
    if (providers.length === 0) return;
    applyProvidersToHouseTips(providers);
  } catch (err) {
    console.warn('refreshQuotaState error:', err);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.whenReady().then(() => {
  const config = loadConfig();

  // Site model — pure logic, no maxWorkers limit
  model = new SiteModel();

  // Entity windows — preload is in the same directory as index.js
  const preloadResolved = path.join(__dirname, 'preload.js');
  const rendererDir = path.join(__dirname, '..', '..', 'renderer');
  const petDebug = process.env['PET_DEBUG'];
  entityManager = new EntityManager({
    preloadPath: preloadResolved,
    rendererDir,
    config,
    onConfigChange: saveConfig,
    onHouseDisplayChanged: () => {
      tray?.rebuildMenu();
    },
    debugRenderer: petDebug === '1' || petDebug === 'true',
  });
  entityManager.start();

  // IPC: push snapshots to entity manager
  model.onChange((snap) => {
    entityManager?.syncSnapshot(snap);
  });
  entityManager.syncSnapshot(model.snapshot());

  // ─── Foreman IPC event polling (single runtime worker-activity source) ──
  const foremanEventsLogger = createDiagnosticLogger('foreman-events');
  if (foremanEventsLogger.path !== null) {
    console.log('Foreman events diagnostic log:', foremanEventsLogger.path);
  }

  foremanEventPoller = new ForemanEventPoller({
    logger: foremanEventsLogger,
    onSignal(_workerKey, signal, meta) {
      // Presence is owned by the activity snapshot; the event stream only
      // enriches message/tool/usage transient display.
      if (isTransientSignal(signal)) {
        model?.ingestTransient(signal, meta);
      }
    },
  });
  foremanEventPoller.start();

  foremanStatsPoller = new ForemanStatsPoller({
    logger: foremanEventsLogger,
    onStats(stats) {
      entityManager?.setDailyStats(stats);
      lastDailyStats = stats;
      panelOwner?.setDailyStats(stats);
    },
    onSummaryStats(summary) {
      // Full summary available with up to 31 days and optional today/rankings
      lastSummary = summary;
      panelOwner?.setStatsData(summary, summary.today ?? summary.daily.at(-1));
      console.log('Stats summary available:', summary.daily.length, 'days');
    },
    onUnavailable() {
      entityManager?.clearDailyStats();
    },
  });
  foremanStatsPoller.start();

  // Quota service
  quotaService = new QuotaService({ logger: foremanEventsLogger });

  // Panel windows
  panelOwner = new PanelOwner({
    config,
    htmlDir: path.join(__dirname, '..', '..', 'renderer'),
    preloadPath: preloadResolved,
    getHouseWindow: () => entityManager?.getHouseWindow() ?? null,
    onConfigChange: saveConfig,
    onHouseSkinChange: (skin) => entityManager?.setHouseSkin(skin),
    onStatsRequestRefresh: async () => {
      try {
        // Return current cached data from the panel owner's perspective
        if (lastSummary) {
          return {
            summary: lastSummary,
            ...(lastDailyStats ? { dailyStats: lastDailyStats } : {}),
          };
        }
        if (lastDailyStats) {
          return { dailyStats: lastDailyStats };
        }
        return undefined;
      } catch (err) {
        console.warn('onStatsRequestRefresh error:', err);
        return undefined;
      }
    },
    onRestart: () => requestForemanPetRestart(),
    onGetEnabledProviderOrder: () => {
      const cfg = loadConfig();
      return cfg.quota.providers.filter(p => p.enabled).map(p => p.id);
    },
  });

  // Refresh quota state at startup
  refreshQuotaState(false);

  // ─── TaskGraph Window Owner (active entity lifecycle) ──────────────
  const ipcPath = foremanEventPoller.getIpcPath();
  if (ipcPath) {
    const taskgraphIpcClient = new ForemanIpcClient({ path: ipcPath });
    taskGraphWindowOwner = new TaskGraphWindowOwner({
      foremanIpcClient: taskgraphIpcClient,
      htmlDir: path.join(__dirname, '..', '..', 'renderer'),
      preloadDir: __dirname,
      getHouseWindow: () => entityManager?.getHouseWindow() ?? null,
      graphSlipGeometry: config.windows.graphSlip,
      onGraphSlipGeometryChange: (geometry) => {
        config.windows.graphSlip = geometry;
        saveConfig(config);
      },
      logger: console,
    });
  }

  // ─── Unique activity snapshot poller (presence SSOT) ───────────────
  // Samples foreman.activity.snapshot v1 every 2s; every presence surface
  // (house/worker, Wren, Graph Slip dynamic state) derives from the one
  // atomically published snapshot. Failures discard the whole round and
  // re-emit the previous complete presence as uniformly stale.
  activityPoller = new ActivitySnapshotPoller({
    logger: foremanEventsLogger,
    getTrackedTaskgraphIds: () => taskGraphWindowOwner?.getTrackedTaskgraphIds() ?? [],
    onPresence(presence) {
      model?.reconcileActivity(presence);
      taskGraphWindowOwner?.applyActivity(presence);
    },
  });
  activityPoller.start();

  // Periodic quota refresh (matches default cache TTL)
  quotaRefreshTimer = setInterval(() => {
    refreshQuotaState(false);
  }, QUOTA_POLL_INTERVAL_MS);

  // ─── IPC handlers ─────────────────────────────────────────────────
  ipcMain.handle('get-config', () => {
    return { scale: config.scale };
  });

  ipcMain.on('house:mouse-passthrough', (event, passthrough: unknown) => {
    if (typeof passthrough !== 'boolean') {
      event.returnValue = { ack: false, reason: 'invalid type' };
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow()) {
      event.returnValue = { ack: false, reason: 'invalid sender' };
      return;
    }
    win.setIgnoreMouseEvents(passthrough, { forward: true });
    event.returnValue = { ack: true };
  });

  ipcMain.handle('house:get-cursor-point', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow() || win.isDestroyed()) return null;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    return {
      x,
      y,
      inside: x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height,
    };
  });

  ipcMain.on('house:drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow()) return;
    entityManager?.handleHouseDragStart();
  });

  ipcMain.on('house:drag-move', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow()) return;
    entityManager?.handleHouseDragMove();
  });

  ipcMain.on('house:drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow()) return;
    entityManager?.handleHouseDragEnd();
  });

  ipcMain.on('house:broadcast-dismiss', (event, id: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getHouseWindow()) return;
    model?.clearBroadcast(typeof id === 'string' ? id : undefined);
  });

  ipcMain.on('worker:mouse-passthrough', (event, id: unknown, passthrough: unknown) => {
    if (typeof id !== 'string' || typeof passthrough !== 'boolean') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getWorkerWindow(id)) return;
    entityManager?.setWorkerMousePassthrough(id, passthrough);
  });

  ipcMain.on('worker:drag-start', (event, id: unknown) => {
    if (typeof id !== 'string') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getWorkerWindow(id)) return;
    entityManager?.handleWorkerDragStart(id);
  });

  ipcMain.on('worker:drag-move', (event, id: unknown) => {
    if (typeof id !== 'string') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getWorkerWindow(id)) return;
    entityManager?.handleWorkerDragMove(id);
  });

  ipcMain.on('worker:drag-end', (event, id: unknown) => {
    if (typeof id !== 'string') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== entityManager?.getWorkerWindow(id)) return;
    entityManager?.handleWorkerDragEnd(id);
  });

  // ─── Timers ───────────────────────────────────────────────────────
  modelTickTimer = setInterval(() => {
    model!.tick();
  }, 1000);
  animationTickTimer = setInterval(() => {
    entityManager?.tick();
  }, 33);

  // ─── Tray ─────────────────────────────────────────────────────────
  tray = createTray({
    entities: {
      getVisibility: () => entityManager?.getEntityVisibility() ?? { house: true, workers: true },
      setHouseVisible: (visible: boolean) => entityManager?.setHouseVisible(visible),
      setWorkersVisible: (visible: boolean) => entityManager?.setWorkersVisible(visible),
    },
    displays: {
      getActiveDisplayId: () => entityManager?.getHouseDisplayId(),
      onSelect: (displayId: number) => {
        entityManager?.moveHouseToDisplay(displayId);
      },
    },
    onSettings: () => {
      panelOwner?.openSettings();
    },
    onRestart: () => requestForemanPetRestart(),
    onStats: () => {
      panelOwner?.openStats();
    },
    getQuotaRows: () => lastQuotaMenuRows,
  });

  console.log('啾啾工坊 started');
  console.log('Polling Foreman events over IPC', foremanEventPoller.getIpcPath() || '(not configured)');
  console.log('Polling Foreman stats over IPC', foremanStatsPoller.getIpcPath() || '(not configured)');
});

app.on('window-all-closed', () => {
  // Don't quit; tray keeps app alive
});

app.on('before-quit', () => {
  if (modelTickTimer) clearInterval(modelTickTimer);
  if (animationTickTimer) clearInterval(animationTickTimer);
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  if (foremanEventPoller) foremanEventPoller.stop();
  if (foremanStatsPoller) foremanStatsPoller.stop();
  if (activityPoller) activityPoller.stop();
  if (entityManager) entityManager.dispose();
  if (panelOwner) panelOwner.destroy();
  if (taskGraphWindowOwner) taskGraphWindowOwner.destroy();
});
