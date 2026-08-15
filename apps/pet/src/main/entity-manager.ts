import { BrowserWindow, screen } from 'electron';
import * as path from 'node:path';
import { getAppearance } from '../features/worker/appearance';
import { classifyWorkerClient } from './client-family';
import { AppConfig } from './config';
import { DisplayRect, resolveDisplay } from './display-placement';
import {
  clampRectToRect,
  defaultHouseBounds,
  houseEntitySize,
  houseWindowSize,
  moveRectToDisplay,
  placeHouseCarrier,
  pickWorkerSpawnPoint,
  resolveHouseCarrierPlacement,
  workerWindowSize,
  type ResolvedHouseCarrierPlacement,
} from './entity-geometry';
import { createHouseWindow, createWorkerWindow } from './entity-windows';
import { buildInfoCard, type InfoCard } from './hover-controller';
import {
  isFadeOutStage,
  nextWorkerBehaviorStage,
  WorkerBehaviorStage,
} from './worker-behavior';
import { HouseRendererState, WorkerRendererState } from '../shared/entities';
import type { DailyStatsSnapshot, SiteSnapshot, WorkerView } from '../shared/snapshot';
import type { WorkerSnapshot, Phase } from '../shared/snapshot';
import type { BroadcastSnapshot } from '../shared/broadcast';
import type { QuotaTipLine } from '../shared/entities';

const FADE_DURATION_MS = 500;

interface OpacityFade {
  from: number;
  to: number;
  startMs: number;
  durationMs: number;
  destroyOnComplete: boolean;
}

interface WorkerEntity {
  key: string; // workerIdentityKey
  window: BrowserWindow;
  bounds: DisplayRect;
  view: WorkerView;
  infoCard: InfoCard;
  rendererReady: boolean;
  suppressMove: boolean;
  behaviorStage: WorkerBehaviorStage;
  opacity: number;
  fade?: OpacityFade;
  pendingRetireUntil?: number;
  lastToolTs?: number;
  lastActivityTs?: number;
  lastContentTs?: number;
}

export interface EntityManagerOptions {
  preloadPath: string;
  rendererDir: string;
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onHouseDisplayChanged?: () => void;
  now?: () => number;
  rng?: () => number;
  debugRenderer?: boolean;
}

export class EntityManager {
  private readonly preloadPath: string;
  private readonly rendererDir: string;
  private readonly onConfigChange: (config: AppConfig) => void;
  private readonly onHouseDisplayChanged?: () => void;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly debugRenderer: boolean;
  private readonly workers = new Map<string, WorkerEntity>();
  private readonly retiredKeys = new Set<string>();
  private config: AppConfig;
  private house: BrowserWindow | null = null;
  private houseBounds: DisplayRect | null = null;
  private houseEntityBounds: DisplayRect | null = null;
  private houseEntityOffset: { x: number; y: number } | null = null;
  private houseRendererReady = false;
  private lastSnapWorkers: WorkerView[] = [];
  private lastQueuedCount = 0;
  private lastBroadcast?: BroadcastSnapshot;
  private lastDailyStats?: SiteSnapshot['dailyStats'];
  private lastActivityStale = false;
  private lastTaskgraphCount = 0;
  private lastQuotaTips?: QuotaTipLine[];
  private suppressHouseMove = false;
  private dragGrabOffset: { x: number; y: number } | null = null;
  private workerDragGrab: { key: string; x: number; y: number } | null = null;

  private readonly onDisplayChanged = () => {
    this.reclampHouseToDisplay();
    this.onHouseDisplayChanged?.();
  };

  constructor(options: EntityManagerOptions) {
    this.preloadPath = options.preloadPath;
    this.rendererDir = options.rendererDir;
    this.config = options.config;
    this.onConfigChange = options.onConfigChange;
    this.onHouseDisplayChanged = options.onHouseDisplayChanged;
    this.now = options.now ?? (() => Date.now());
    this.rng = options.rng ?? (() => Math.random());
    this.debugRenderer = options.debugRenderer ?? false;
  }

  start(): void {
    this.createHouse();
    screen.on('display-metrics-changed', this.onDisplayChanged);
    screen.on('display-added', this.onDisplayChanged);
    screen.on('display-removed', this.onDisplayChanged);
  }

  dispose(): void {
    screen.removeListener('display-metrics-changed', this.onDisplayChanged);
    screen.removeListener('display-added', this.onDisplayChanged);
    screen.removeListener('display-removed', this.onDisplayChanged);
    for (const worker of this.workers.values()) {
      if (!worker.window.isDestroyed()) worker.window.destroy();
    }
    this.workers.clear();
    if (this.house && !this.house.isDestroyed()) {
      this.house.destroy();
    }
    this.house = null;
  }

  syncSnapshot(snapshot: SiteSnapshot): void {
    const nowMs = this.now();
    // Convert WorkerSnapshot[] -> renderer payloads while full snapshot fields are available.
    const workerUpdates = snapshot.workers.map((ws) => {
      const existing = this.workers.get(ws.workerIdentityKey);
      const lastToolTs = existing?.lastToolTs;
      const lastActivityTs = existing?.lastActivityTs;
      const lastContentTs = existing?.lastContentTs;
      const client = classifyWorkerClient(ws.profile, ws.meta?.clientFamily);
      const bubble = this.buildBubble(ws);
      // Detect new tool use by comparing toolCount
      const hasNewTool = ws.toolCount > 0 && (!existing || ws.toolCount > existing.view.toolCount);
      const hasNewText = Boolean(bubble?.text && (!existing || bubble.text !== existing.view.bubble?.text));
      const newLastToolTs = hasNewTool ? nowMs : lastToolTs;
      const newLastActivityTs = hasNewTool || hasNewText ? nowMs : lastActivityTs;
      const newLastContentTs = hasNewText ? nowMs : lastContentTs;

      return {
        view: {
          workerIdentityKey: ws.workerIdentityKey,
          profile: ws.profile,
          client,
          phase: ws.phase,
          appearance: getAppearance(ws.profile, ws.workerIdentityKey, client, ws.meta?.foremanTaskRunID),
          sinceMs: ws.phaseSinceMs,
          toolCount: ws.toolCount,
          lastToolTs: newLastToolTs,
          lastActivityTs: newLastActivityTs,
          lastContentTs: newLastContentTs,
          bubble,
          startedAt: ws.startedAt,
          taskLabel: ws.meta?.taskLabel,
          taskId: ws.meta?.taskId,
          taskName: ws.meta?.taskName,
        },
        infoCard: buildInfoCard(ws, nowMs),
      };
    });
    const views: WorkerView[] = workerUpdates.map(({ view }) => view);

    this.lastSnapWorkers = views;
    this.lastQueuedCount = snapshot.queuedCount;
    this.lastBroadcast = snapshot.broadcast;
    this.lastActivityStale = snapshot.activityStale ?? false;
    this.lastTaskgraphCount = snapshot.taskgraphCount ?? 0;
    if (snapshot.dailyStats !== undefined) {
      this.lastDailyStats = snapshot.dailyStats;
    }
    this.sendHouseUpdate();

    const liveKeys = new Set<string>();
    for (const { view, infoCard } of workerUpdates) {
      liveKeys.add(view.workerIdentityKey);
      if (this.retiredKeys.has(view.workerIdentityKey)) {
        // Key was previously retired (fadeOut completed, window destroyed).
        // Skip if a worker entity still exists (mid-fadeOut) to prevent
        // window recreation flicker.
        if (this.workers.has(view.workerIdentityKey)) continue;
        // Legitimate key reuse: unretire and proceed to recreate the window.
        this.retiredKeys.delete(view.workerIdentityKey);
      }
      const worker = this.workers.get(view.workerIdentityKey) ?? this.createWorker(view, infoCard);
      // Cancel any pending retirement timer — worker reappeared in snapshot
      worker.pendingRetireUntil = undefined;
      worker.view = view;
      worker.infoCard = infoCard;
      worker.lastToolTs = view.lastToolTs;
      worker.lastActivityTs = view.lastActivityTs;
      worker.lastContentTs = view.lastContentTs;
      this.applyWorkerPhase(worker, view);
      this.sendWorkerUpdate(worker);
    }

    for (const [key, worker] of this.workers) {
      if (!liveKeys.has(key)) {
        // Already waiting for a pending retirement delay
        if (worker.pendingRetireUntil !== undefined) continue;
        // Already fading out
        if (worker.fade) continue;

        // Check if a bubble animation is still active
        const bubbleUntilMs = worker.view.bubble?.untilMs;
        if (bubbleUntilMs !== undefined && bubbleUntilMs > nowMs) {
          // Defer retirement until the bubble animation completes
          worker.pendingRetireUntil = bubbleUntilMs;
          continue;
        }

        // No active bubble — start fade-out immediately
        worker.behaviorStage = 'fadeOut';
        this.startFade(worker, 0, true);
      }
    }

    for (const key of Array.from(this.retiredKeys)) {
      if (!liveKeys.has(key)) {
        this.retiredKeys.delete(key);
      }
    }
  }

  tick(): void {
    const now = this.now();

    // Trigger pending retirements whose delay has elapsed
    for (const worker of this.workers.values()) {
      if (worker.pendingRetireUntil !== undefined && now >= worker.pendingRetireUntil) {
        worker.pendingRetireUntil = undefined;
        if (!worker.fade && !worker.window.isDestroyed()) {
          worker.behaviorStage = 'fadeOut';
          this.startFade(worker, 0, true);
        }
      }
    }

    for (const worker of this.workers.values()) {
      if (!worker.fade || worker.window.isDestroyed()) continue;

      const t = Math.min(1, Math.max(0, (now - worker.fade.startMs) / worker.fade.durationMs));
      const opacity = lerp(worker.fade.from, worker.fade.to, t);
      this.setWorkerOpacity(worker, opacity);

      if (t >= 1) {
        const destroyOnComplete = worker.fade.destroyOnComplete && isFadeOutStage(worker.behaviorStage);
        worker.fade = undefined;
        if (destroyOnComplete) {
          this.destroyWorker(worker);
          this.workers.delete(worker.key);
          this.retiredKeys.add(worker.key);
        }
      }
    }
  }

  getHouseDisplayId(): number | undefined {
    if (!this.houseEntityBounds) return this.config.house.displayId;
    return screen.getDisplayMatching(this.houseEntityBounds).id;
  }

  getHouseWindow(): BrowserWindow | null {
    return this.house;
  }

  getWorkerWindow(key: string): BrowserWindow | null {
    return this.workers.get(key)?.window ?? null;
  }

  moveHouseToDisplay(displayId: number): void {
    if (!this.house || !this.houseEntityBounds) return;

    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const currentDisplay = screen.getDisplayMatching(this.houseEntityBounds);
    const targetDisplay = resolveDisplay(displays, primary, displayId);
    const moved = moveRectToDisplay(this.houseEntityBounds, currentDisplay, targetDisplay);
    this.setHousePlacement(placeHouseCarrier(moved, targetDisplay, this.config.scale));
    this.persistHouseBounds();
    this.onHouseDisplayChanged?.();
  }

  setHouseVisible(visible: boolean): void {
    this.config.entities.house = visible;
    if (this.house && !this.house.isDestroyed()) {
      if (visible) this.house.showInactive();
      else this.house.hide();
    }
    this.onConfigChange(this.config);
  }

  setWorkersVisible(visible: boolean): void {
    this.config.entities.workers = visible;
    for (const worker of this.workers.values()) {
      if (worker.window.isDestroyed()) continue;
      if (visible) worker.window.showInactive();
      else worker.window.hide();
    }
    this.onConfigChange(this.config);
  }

  getEntityVisibility(): { house: boolean; workers: boolean } {
    return { ...this.config.entities };
  }

  setDailyStats(stats: DailyStatsSnapshot): void {
    this.lastDailyStats = stats;
    this.sendHouseUpdate();
  }

  clearDailyStats(): void {
    this.lastDailyStats = undefined;
    this.sendHouseUpdate();
  }

  setQuotaTips(tips: QuotaTipLine[]): void {
    this.lastQuotaTips = tips;
    this.sendHouseUpdate();
  }

  setHouseSkin(skin: 'classic' | 'mushroom'): void {
    this.config.appearance = { ...this.config.appearance, houseSkin: skin };
    this.onConfigChange(this.config);
    this.sendHouseUpdate();
  }

  handleHouseDragStart(): void {
    if (!this.house || this.house.isDestroyed() || !this.houseEntityBounds) return;
    const cursor = screen.getCursorScreenPoint();
    this.dragGrabOffset = {
      x: cursor.x - this.houseEntityBounds.x,
      y: cursor.y - this.houseEntityBounds.y,
    };
  }

  handleHouseDragMove(): void {
    if (!this.dragGrabOffset || !this.house || this.house.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const entitySize = houseEntitySize(this.config.scale);
    const desired = {
      x: cursor.x - this.dragGrabOffset.x,
      y: cursor.y - this.dragGrabOffset.y,
      ...entitySize,
    };
    const display = screen.getDisplayMatching(desired);
    this.setHousePlacement(
      placeHouseCarrier(desired, display, this.config.scale),
    );
  }

  handleHouseDragEnd(): void {
    this.dragGrabOffset = null;
    this.persistHouseBounds();
  }

  setWorkerMousePassthrough(key: string, passthrough: boolean): void {
    const worker = this.workers.get(key);
    if (!worker || worker.window.isDestroyed()) return;
    worker.window.setIgnoreMouseEvents(passthrough, { forward: true });
  }

  handleWorkerDragStart(key: string): void {
    const worker = this.workers.get(key);
    if (!worker || worker.window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    this.workerDragGrab = {
      key,
      x: cursor.x - worker.bounds.x,
      y: cursor.y - worker.bounds.y,
    };
  }

  handleWorkerDragMove(key: string): void {
    const worker = this.workers.get(key);
    if (
      !worker ||
      worker.window.isDestroyed() ||
      !this.workerDragGrab ||
      this.workerDragGrab.key !== key
    ) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const size = workerWindowSize(this.config.scale);
    const display = screen.getDisplayMatching(worker.bounds);
    const clamped = clampRectToRect(
      {
        x: cursor.x - this.workerDragGrab.x,
        y: cursor.y - this.workerDragGrab.y,
        width: size.width,
        height: size.height,
      },
      display.bounds,
    );

    this.setWorkerBounds(worker, clamped);
  }

  handleWorkerDragEnd(key: string): void {
    if (this.workerDragGrab?.key === key) {
      this.workerDragGrab = null;
    }
  }

  private createHouse(): void {
    const placement = resolveHouseCarrierPlacement(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      this.config.house,
      this.config.scale,
      this.config.bottomOffset,
    );
    this.houseBounds = placement.bounds;
    this.houseEntityBounds = placement.entityBounds;
    this.houseEntityOffset = placement.entityOffset;

    const win = createHouseWindow({
      preloadPath: this.preloadPath,
      htmlPath: path.join(this.rendererDir, 'house.html'),
      bounds: placement.bounds,
      visible: this.config.entities.house,
      onRendererRecovered: () => {
        this.houseRendererReady = true;
        this.sendHouseUpdate();
      },
    });
    this.house = win;
    win.setIgnoreMouseEvents(true, { forward: true });
    this.attachRendererDebug(win);

    win.webContents.once('did-finish-load', () => {
      this.houseRendererReady = true;
      this.sendHouseUpdate();
    });
    win.on('move', () => this.handleHouseMoved());
    this.persistHouseBounds();
  }

  private createWorker(view: WorkerView, infoCard: InfoCard): WorkerEntity {
    const houseBounds = this.requireHouseBounds();
    const display = screen.getDisplayMatching(houseBounds);
    const size = workerWindowSize(this.config.scale);
    const occupied = Array.from(this.workers.values(), (w) => w.bounds);
    const spawnPoint = pickWorkerSpawnPoint(display, houseBounds, size, this.rng, occupied);
    const startBounds = clampRectToRect({ ...spawnPoint, ...size }, display.bounds);

    const win = createWorkerWindow({
      preloadPath: this.preloadPath,
      htmlPath: path.join(this.rendererDir, 'worker.html'),
      bounds: startBounds,
      visible: this.config.entities.workers,
    });
    win.setOpacity(0);
    // Initial passthrough: worker windows ignore mouse events by default
    win.setIgnoreMouseEvents(true, { forward: true });
    this.attachRendererDebug(win);

    const worker: WorkerEntity = {
      key: view.workerIdentityKey,
      window: win,
      bounds: startBounds,
      view,
      infoCard,
      rendererReady: false,
      suppressMove: false,
      behaviorStage: 'spawn',
      opacity: 0,
      lastToolTs: view.lastToolTs,
      lastActivityTs: view.lastActivityTs,
    };

    win.webContents.on('did-finish-load', () => {
      worker.rendererReady = true;
      this.sendWorkerUpdate(worker);
    });
    win.on('move', () => this.handleWorkerMoved(worker));
    this.workers.set(view.workerIdentityKey, worker);
    return worker;
  }

  private applyWorkerPhase(worker: WorkerEntity, view: WorkerView): void {
    const nextStage = nextWorkerBehaviorStage(worker.behaviorStage, view.phase);
    if (nextStage === worker.behaviorStage) return;

    if (nextStage === 'fadeIn') {
      this.startFade(worker, 1, false);
      worker.behaviorStage = nextStage;
      return;
    }

    if (nextStage === 'fadeOut') {
      this.startFade(worker, 0, true);
      worker.behaviorStage = nextStage;
      return;
    }

    if (nextStage === 'work') {
      this.clearFade(worker, 1);
    }

    worker.behaviorStage = nextStage;
  }

  private startFade(worker: WorkerEntity, to: number, destroyOnComplete: boolean): void {
    if (worker.window.isDestroyed()) return;
    if (to > 0 && this.config.entities.workers) {
      worker.window.showInactive();
    }
    worker.fade = {
      from: worker.opacity,
      to,
      startMs: this.now(),
      durationMs: FADE_DURATION_MS,
      destroyOnComplete,
    };
  }

  private handleHouseMoved(): void {
    if (!this.house || this.suppressHouseMove) return;
    this.houseBounds = this.house.getBounds();
    if (this.houseEntityOffset) {
      const size = houseEntitySize(this.config.scale);
      this.houseEntityBounds = {
        x: this.houseBounds.x + this.houseEntityOffset.x,
        y: this.houseBounds.y + this.houseEntityOffset.y,
        ...size,
      };
    }
    this.persistHouseBounds();
    this.sendHouseUpdate();
    this.onHouseDisplayChanged?.();
  }

  private handleWorkerMoved(worker: WorkerEntity): void {
    if (worker.suppressMove || worker.window.isDestroyed()) return;
    worker.bounds = worker.window.getBounds();
  }

  private reclampHouseToDisplay(): void {
    if (!this.house) return;
    const display = this.houseEntityBounds
      ? screen.getDisplayMatching(this.houseEntityBounds)
      : resolveDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay(), this.config.house.displayId);
    const desired = this.houseEntityBounds ?? {
      x: display.workArea.x + 24,
      y: display.workArea.y + display.workArea.height - houseEntitySize(this.config.scale).height - 24,
    };
    this.setHousePlacement(placeHouseCarrier(desired, display, this.config.scale));
    this.persistHouseBounds();
  }

  private setHousePlacement(placement: ResolvedHouseCarrierPlacement): void {
    this.houseEntityBounds = placement.entityBounds;
    this.houseEntityOffset = placement.entityOffset;
    this.setHouseBounds(placement.bounds);
    this.sendHouseUpdate();
  }

  private setHouseBounds(bounds: DisplayRect): void {
    if (!this.house || this.house.isDestroyed()) return;
    this.houseBounds = bounds;
    this.suppressHouseMove = true;
    this.house.setBounds(bounds);
    setTimeout(() => {
      this.suppressHouseMove = false;
    }, 0);
  }

  private setWorkerBounds(worker: WorkerEntity, bounds: DisplayRect): void {
    if (worker.window.isDestroyed()) return;
    worker.bounds = bounds;
    worker.suppressMove = true;
    worker.window.setBounds(bounds);
    setTimeout(() => {
      worker.suppressMove = false;
    }, 0);
  }

  private clearFade(worker: WorkerEntity, opacity: number): void {
    worker.fade = undefined;
    this.setWorkerOpacity(worker, opacity);
  }

  private setWorkerOpacity(worker: WorkerEntity, opacity: number): void {
    worker.opacity = Math.min(1, Math.max(0, opacity));
    if (!worker.window.isDestroyed()) {
      worker.window.setOpacity(worker.opacity);
    }
  }

  private persistHouseBounds(): void {
    if (!this.houseBounds || !this.houseEntityBounds) return;
    const display = screen.getDisplayMatching(this.houseEntityBounds);
    this.config.house = {
      displayId: display.id,
      x: this.houseBounds.x,
      y: this.houseBounds.y,
      entityX: this.houseEntityBounds.x,
      entityY: this.houseEntityBounds.y,
    };
    this.onConfigChange(this.config);
  }

  private sendHouseUpdate(): void {
    if (!this.house || this.house.isDestroyed() || !this.houseRendererReady) return;
    const state: HouseRendererState = {
      scale: this.config.scale,
      houseSkin: this.config.appearance?.houseSkin ?? 'classic',
      ...(this.houseEntityOffset ? { placement: { ...this.houseEntityOffset } } : {}),
      workers: this.lastSnapWorkers,
      queuedCount: this.lastQueuedCount,
      ...(this.lastBroadcast ? { broadcast: this.lastBroadcast } : {}),
      ...(this.lastDailyStats ? { dailyStats: this.lastDailyStats } : {}),
      ...(this.lastActivityStale ? { activityStale: true } : {}),
      ...(this.lastTaskgraphCount > 0 ? { taskgraphCount: this.lastTaskgraphCount } : {}),
      ...(this.lastQuotaTips && this.lastQuotaTips.length > 0 ? { quotaTips: [...this.lastQuotaTips] } : {}),
    };
    this.house.webContents.send('house:update', state);
  }

  private sendWorkerUpdate(worker: WorkerEntity): void {
    if (worker.window.isDestroyed() || !worker.rendererReady) return;
    const state: WorkerRendererState = {
      scale: this.config.scale,
      worker: worker.view,
      infoCard: worker.infoCard,
    };
    worker.window.webContents.send('worker:update', state);
  }

  private destroyWorker(worker: WorkerEntity): void {
    if (this.workerDragGrab?.key === worker.key) {
      this.workerDragGrab = null;
    }
    if (!worker.window.isDestroyed()) {
      worker.window.destroy();
    }
  }

  private requireHouseBounds(): DisplayRect {
    if (this.houseEntityBounds) return this.houseEntityBounds;
    const display = screen.getPrimaryDisplay();
    const carrier = defaultHouseBounds(display, houseWindowSize(this.config.scale));
    const size = houseEntitySize(this.config.scale);
    return {
      x: carrier.x + Math.max(0, Math.round((carrier.width - size.width) / 2)),
      y: carrier.y + Math.max(0, carrier.height - size.height),
      ...size,
    };
  }

  private buildBubble(ws: WorkerSnapshot): { text: string; untilMs: number } | undefined {
    const text = ws.lastText || ws.firstSentence;
    if (!text) return undefined;
    return {
      text,
      untilMs: ws.bubbleUntilMs ?? this.now() + this.config.bubbleSeconds * 1000,
    };
  }

  private attachRendererDebug(win: BrowserWindow): void {
    if (!this.debugRenderer) return;
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const prefix = ['VERBOSE', 'INFO', 'WARN', 'ERROR'][level] ?? 'LOG';
      console.log(`[renderer ${prefix}] ${message} (${sourceId}:${line})`);
    });
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
