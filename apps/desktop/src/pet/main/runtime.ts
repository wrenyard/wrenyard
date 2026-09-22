import { BrowserWindow, ipcMain, screen } from 'electron';
import { SiteModel } from './site-model';
import { EntityManager } from './entity-manager';
import { buildQuotaTips } from '../../main/projections/quota-tips';
import type { QuotaProviderState } from '../shared/entities';
import type { AgentEventSignal } from './agent-types';
import type { AppConfig } from './config';
import type { ActivityPresence } from '../shared/activity-snapshot';
import type { DailyStatsSnapshot } from '../shared/snapshot';
import type { DaemonSubscriptionHandlers, DaemonSubscriptions, PetEventSignal } from '../../main/daemon-client/subscriptions';

export type PetRuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type PetVisibility = 'visible' | 'hidden';
export type { QuotaProviderState } from '../shared/entities';

export interface DesktopPetRuntimeOptions {
  config: AppConfig;
  rendererDir: string;
  preloadDir: string;
  /**
   * Shared Desktop subscriptions. The Pet runtime consumes a projection; it
   * never creates its own daemon connection, pollers or timers.
   */
  subscriptions: DaemonSubscriptions;
  onConfigChange(config: AppConfig): void;
  debugRenderer?: boolean;
}

/**
 * Desktop-owned Pet runtime. It owns only transparent observation windows and
 * read-only projections; the host owns lifecycle, persistence, tray UI and
 * product navigation. Visibility is orthogonal to disposal: `setVisible(false)`
 * pauses the model/animation ticks and hides windows, while `stop()` tears the
 * module down completely.
 */
export class DesktopPetRuntime {
  private statusValue: PetRuntimeStatus = 'stopped';
  private visibility: PetVisibility = 'visible';
  private config: AppConfig;
  private model: SiteModel | null = null;
  private modelTickTimer: ReturnType<typeof setInterval> | null = null;
  private animationTickTimer: ReturnType<typeof setInterval> | null = null;
  private entityManager: EntityManager | null = null;
  private quotaProviders: QuotaProviderState[] = [];
  private unsubscribe: (() => void) | null = null;
  private ipcHandlersRegistered = false;

  constructor(private readonly options: DesktopPetRuntimeOptions) {
    this.config = options.config;
  }

  get status(): PetRuntimeStatus {
    return this.statusValue;
  }

  get visible(): boolean {
    return this.visibility === 'visible';
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
    if (this.statusValue === 'stopping') return;
    if (this.statusValue === 'stopped') return;
    this.statusValue = 'stopping';
    this.teardown();
    this.statusValue = 'stopped';
  }

  /**
   * Overall visibility toggle, independent of disposal. Hiding pauses the
   * model and animation ticks and hides every entity window; showing resumes
   * ticks and re-shows the windows whose entity type is enabled, starting from
   * the current shared snapshot rather than replaying missed events.
   */
  setVisible(visible: boolean): void {
    this.visibility = visible ? 'visible' : 'hidden';
    if (this.statusValue !== 'running') return;
    if (visible) {
      this.model?.tick();
      this.startTicks();
      this.entityManager?.setVisible(true);
    } else {
      this.stopTicks();
      this.entityManager?.setVisible(false);
    }
  }

  /** Desktop owns quota refreshes and pushes the latest bounded projection in. */
  setQuotaProviders(providers: QuotaProviderState[]): void {
    this.quotaProviders = providers.map((provider) => ({ ...provider }));
    this.applyProvidersToHouseTips(this.quotaProviders);
  }

  /**
   * House window, exposed so the shared Desktop window owner can place Wren
   * entities relative to it. Null while the runtime is stopped.
   */
  getHouseWindow(): BrowserWindow | null {
    return this.entityManager?.getHouseWindow() ?? null;
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
    this.applyProvidersToHouseTips(this.quotaProviders);

    // Consume the shared Desktop subscriptions. Attaching replays the latest
    // stats/activity round so a hidden-then-shown Pet resumes from the current
    // snapshot instead of the events it missed.
    this.unsubscribe = this.options.subscriptions.subscribe(this.subscriptionHandlers());

    this.registerIpcHandlers();
    if (this.visibility === 'visible') this.startTicks();
    this.entityManager.setVisible(this.visibility === 'visible');
  }

  private subscriptionHandlers(): DaemonSubscriptionHandlers {
    return {
      onSignal: (event: PetEventSignal) => {
        if (this.visible && isTransientSignal(event.signal)) this.model?.ingestTransient(event.signal, event.meta);
      },
      onStats: (stats: DailyStatsSnapshot | undefined) => {
        if (stats) this.entityManager?.setDailyStats(stats);
        else this.entityManager?.clearDailyStats();
      },
      onActivity: (presence: ActivityPresence) => {
        this.model?.reconcileActivity(presence);
      },
    };
  }

  private startTicks(): void {
    if (!this.modelTickTimer) this.modelTickTimer = setInterval(() => this.model?.tick(), 1_000);
    if (!this.animationTickTimer) this.animationTickTimer = setInterval(() => this.entityManager?.tick(), 33);
  }

  private stopTicks(): void {
    if (this.modelTickTimer) clearInterval(this.modelTickTimer);
    if (this.animationTickTimer) clearInterval(this.animationTickTimer);
    this.modelTickTimer = null;
    this.animationTickTimer = null;
  }

  private teardown(): void {
    this.stopTicks();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.entityManager?.dispose();
    this.removeIpcHandlers();
    this.entityManager = null;
    this.model = null;
  }

  private applyProvidersToHouseTips(providers: QuotaProviderState[]): void {
    if (!this.entityManager) return;
    const order = providers.map((provider) => provider.id);
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
    if (this.ipcHandlersRegistered) return;
    this.removeIpcHandlers();
    // Channel names are namespaced under the Pet overlay surface so they never
    // collide with general Desktop channels such as `get-config`.
    ipcMain.handle('pet:get-config', () => ({ scale: this.config.scale }));
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
    this.ipcHandlersRegistered = true;
  }

  private removeIpcHandlers(): void {
    if (!this.ipcHandlersRegistered) return;
    ipcMain.removeHandler('pet:get-config');
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
    this.ipcHandlersRegistered = false;
  }
}

function isTransientSignal(signal: AgentEventSignal): boolean {
  return signal.kind === 'message'
    || signal.kind === 'tool_call'
    || signal.kind === 'tool_result'
    || signal.kind === 'turn_usage';
}
