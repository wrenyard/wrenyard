import { BrowserWindow, ipcMain, screen } from 'electron';
import { SiteModel } from './site-model';
import { EntityManager } from './entity-manager';
import { ForemanEventPoller } from './foreman-event-poller';
import { ForemanStatsPoller } from './foreman-stats-poller';
import { ActivitySnapshotPoller } from './activity-snapshot-poller';
import { createDiagnosticLogger } from './diagnostic-logger';
import { buildQuotaTips } from './quota-tips';
import type { QuotaProviderState } from '../shared/entities';
import { ForemanIpcClient } from './foreman-ipc-client';
import { TaskGraphWindowOwner } from './taskgraph-windows';
import type { ForgeEventSignal } from './forge-types';
import type { AppConfig } from './config';

export type PetRuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export { QuotaService } from './quota-service';
export type { QuotaProviderState } from '../shared/entities';

export interface DesktopPetRuntimeOptions {
  config: AppConfig;
  rendererDir: string;
  preloadDir: string;
  ipcPath?: string;
  onConfigChange(config: AppConfig): void;
  debugRenderer?: boolean;
}

/**
 * Desktop-owned Pet runtime. It owns only transparent observation windows and
 * read-only Wrenyard projections; the host owns lifecycle, persistence, tray
 * UI and product navigation.
 */
export class DesktopPetRuntime {
  private statusValue: PetRuntimeStatus = 'stopped';
  private config: AppConfig;
  private model: SiteModel | null = null;
  private modelTickTimer: ReturnType<typeof setInterval> | null = null;
  private animationTickTimer: ReturnType<typeof setInterval> | null = null;
  private foremanEventPoller: ForemanEventPoller | null = null;
  private foremanStatsPoller: ForemanStatsPoller | null = null;
  private activityPoller: ActivitySnapshotPoller | null = null;
  private entityManager: EntityManager | null = null;
  private quotaProviders: QuotaProviderState[] = [];
  private taskGraphWindowOwner: TaskGraphWindowOwner | null = null;

  constructor(private readonly options: DesktopPetRuntimeOptions) {
    this.config = options.config;
  }

  get status(): PetRuntimeStatus {
    return this.statusValue;
  }

  async start(): Promise<void> {
    if (this.statusValue === 'running' || this.statusValue === 'starting') return;
    this.statusValue = 'starting';
    try {
      this.setup();
      this.statusValue = 'running';
      console.log('[wrenyard-desktop] Pet module started');
    } catch (error) {
      this.teardown();
      this.statusValue = 'failed';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.statusValue === 'stopped' || this.statusValue === 'stopping') return;
    this.statusValue = 'stopping';
    this.teardown();
    this.statusValue = 'stopped';
  }

  /** Desktop owns quota refreshes and pushes the latest bounded projection in. */
  setQuotaProviders(providers: QuotaProviderState[]): void {
    this.quotaProviders = providers.map((provider) => ({ ...provider }));
    this.applyProvidersToHouseTips(this.quotaProviders);
  }

  private setup(): void {
    this.model = new SiteModel();
    this.entityManager = new EntityManager({
      preloadPath: `${this.options.preloadDir}/preload.js`,
      rendererDir: this.options.rendererDir,
      config: this.config,
      onConfigChange: (config) => {
        this.config = config;
        this.options.onConfigChange(config);
      },
      debugRenderer: this.options.debugRenderer,
    });
    this.entityManager.start();
    this.model.onChange((snapshot) => this.entityManager?.syncSnapshot(snapshot));
    this.entityManager.syncSnapshot(this.model.snapshot());

    const logger = createDiagnosticLogger('desktop-pet-events');
    this.foremanEventPoller = new ForemanEventPoller({
      ...(this.options.ipcPath ? { ipcPath: this.options.ipcPath } : {}),
      logger,
      onSignal: (_workerKey, signal, meta) => {
        if (isTransientSignal(signal)) this.model?.ingestTransient(signal, meta);
      },
    });
    this.foremanEventPoller.start();

    this.foremanStatsPoller = new ForemanStatsPoller({
      ...(this.options.ipcPath ? { ipcPath: this.options.ipcPath } : {}),
      logger,
      onStats: (stats) => this.entityManager?.setDailyStats(stats),
      onUnavailable: () => this.entityManager?.clearDailyStats(),
    });
    this.foremanStatsPoller.start();
    this.applyProvidersToHouseTips(this.quotaProviders);

    const ipcPath = this.options.ipcPath ?? this.foremanEventPoller.getIpcPath();
    if (ipcPath) {
      this.taskGraphWindowOwner = new TaskGraphWindowOwner({
        foremanIpcClient: new ForemanIpcClient({ path: ipcPath }),
        htmlDir: this.options.rendererDir,
        preloadDir: this.options.preloadDir,
        getHouseWindow: () => this.entityManager?.getHouseWindow() ?? null,
        graphSlipGeometry: this.config.windows.graphSlip,
        entitiesVisible: this.config.entities.taskgraphs,
        onGraphSlipGeometryChange: (geometry) => {
          this.config.windows.graphSlip = geometry;
          this.options.onConfigChange(this.config);
        },
        logger: console,
      });
    }

    this.activityPoller = new ActivitySnapshotPoller({
      ...(this.options.ipcPath ? { ipcPath: this.options.ipcPath } : {}),
      logger,
      getTrackedTaskgraphIds: () => this.taskGraphWindowOwner?.getTrackedTaskgraphIds() ?? [],
      onPresence: (presence) => {
        this.model?.reconcileActivity(presence);
        this.taskGraphWindowOwner?.applyActivity(presence);
      },
    });
    this.activityPoller.start();

    this.registerIpcHandlers();
    this.modelTickTimer = setInterval(() => this.model?.tick(), 1_000);
    this.animationTickTimer = setInterval(() => this.entityManager?.tick(), 33);
  }

  private teardown(): void {
    if (this.modelTickTimer) clearInterval(this.modelTickTimer);
    if (this.animationTickTimer) clearInterval(this.animationTickTimer);
    this.modelTickTimer = null;
    this.animationTickTimer = null;
    this.foremanEventPoller?.stop();
    this.foremanStatsPoller?.stop();
    this.activityPoller?.stop();
    this.taskGraphWindowOwner?.destroy();
    this.entityManager?.dispose();
    this.removeIpcHandlers();
    this.foremanEventPoller = null;
    this.foremanStatsPoller = null;
    this.activityPoller = null;
    this.taskGraphWindowOwner = null;
    this.entityManager = null;
    this.model = null;
  }

  private applyProvidersToHouseTips(providers: QuotaProviderState[]): void {
    if (!this.entityManager) return;
    const order = this.config.quota.providers.filter((provider) => provider.enabled).map((provider) => provider.id);
    this.entityManager.setQuotaTips(buildQuotaTips(providers, order));
  }

  private readonly handleHouseMousePassthrough = (event: Electron.IpcMainEvent, passthrough: unknown): void => {
    if (typeof passthrough !== 'boolean') {
      event.returnValue = { ack: false, reason: 'invalid type' };
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== this.entityManager?.getHouseWindow()) {
      event.returnValue = { ack: false, reason: 'invalid sender' };
      return;
    }
    win.setIgnoreMouseEvents(passthrough, { forward: true });
    event.returnValue = { ack: true };
  };

  private readonly handleHouseCursorPoint = (event: Electron.IpcMainInvokeEvent): { x: number; y: number; inside: boolean } | null => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== this.entityManager?.getHouseWindow() || win.isDestroyed()) return null;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    return { x, y, inside: x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height };
  };

  private readonly handleHouseDragStart = (event: Electron.IpcMainEvent): void => {
    if (BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getHouseWindow()) this.entityManager?.handleHouseDragStart();
  };

  private readonly handleHouseDragMove = (event: Electron.IpcMainEvent): void => {
    if (BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getHouseWindow()) this.entityManager?.handleHouseDragMove();
  };

  private readonly handleHouseDragEnd = (event: Electron.IpcMainEvent): void => {
    if (BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getHouseWindow()) this.entityManager?.handleHouseDragEnd();
  };

  private readonly handleBroadcastDismiss = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getHouseWindow()) this.model?.clearBroadcast(typeof id === 'string' ? id : undefined);
  };

  private readonly handleWorkerMousePassthrough = (event: Electron.IpcMainEvent, id: unknown, passthrough: unknown): void => {
    if (typeof id !== 'string' || typeof passthrough !== 'boolean') return;
    if (BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getWorkerWindow(id)) this.entityManager?.setWorkerMousePassthrough(id, passthrough);
  };

  private readonly handleWorkerDragStart = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (typeof id === 'string' && BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getWorkerWindow(id)) this.entityManager?.handleWorkerDragStart(id);
  };

  private readonly handleWorkerDragMove = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (typeof id === 'string' && BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getWorkerWindow(id)) this.entityManager?.handleWorkerDragMove(id);
  };

  private readonly handleWorkerDragEnd = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (typeof id === 'string' && BrowserWindow.fromWebContents(event.sender) === this.entityManager?.getWorkerWindow(id)) this.entityManager?.handleWorkerDragEnd(id);
  };

  private registerIpcHandlers(): void {
    this.removeIpcHandlers();
    ipcMain.handle('get-config', () => ({ scale: this.config.scale }));
    ipcMain.on('house:mouse-passthrough', this.handleHouseMousePassthrough);
    ipcMain.handle('house:get-cursor-point', this.handleHouseCursorPoint);
    ipcMain.on('house:drag-start', this.handleHouseDragStart);
    ipcMain.on('house:drag-move', this.handleHouseDragMove);
    ipcMain.on('house:drag-end', this.handleHouseDragEnd);
    ipcMain.on('house:broadcast-dismiss', this.handleBroadcastDismiss);
    ipcMain.on('worker:mouse-passthrough', this.handleWorkerMousePassthrough);
    ipcMain.on('worker:drag-start', this.handleWorkerDragStart);
    ipcMain.on('worker:drag-move', this.handleWorkerDragMove);
    ipcMain.on('worker:drag-end', this.handleWorkerDragEnd);
  }

  private removeIpcHandlers(): void {
    ipcMain.removeHandler('get-config');
    ipcMain.removeHandler('house:get-cursor-point');
    ipcMain.removeListener('house:mouse-passthrough', this.handleHouseMousePassthrough);
    ipcMain.removeListener('house:drag-start', this.handleHouseDragStart);
    ipcMain.removeListener('house:drag-move', this.handleHouseDragMove);
    ipcMain.removeListener('house:drag-end', this.handleHouseDragEnd);
    ipcMain.removeListener('house:broadcast-dismiss', this.handleBroadcastDismiss);
    ipcMain.removeListener('worker:mouse-passthrough', this.handleWorkerMousePassthrough);
    ipcMain.removeListener('worker:drag-start', this.handleWorkerDragStart);
    ipcMain.removeListener('worker:drag-move', this.handleWorkerDragMove);
    ipcMain.removeListener('worker:drag-end', this.handleWorkerDragEnd);
  }
}

function isTransientSignal(signal: ForgeEventSignal): boolean {
  return signal.kind === 'message'
    || signal.kind === 'tool_call'
    || signal.kind === 'tool_result'
    || signal.kind === 'turn_usage';
}
