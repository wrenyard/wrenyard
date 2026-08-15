import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntityManager } from '../src/main/entity-manager';
import { createHouseWindow, createWorkerWindow } from '../src/main/entity-windows';
import type { AppConfig } from '../src/main/config';
import type { DailyStatsSnapshot, SiteSnapshot, WorkerSnapshot } from '../src/shared/snapshot';
import type { QuotaTipLine } from '../src/shared/entities';

// ── Hoisted helpers for mock factories ──────────────────────────────

const { makeMockWin } = vi.hoisted(() => {
  let uid = 0;
  return {
    makeMockWin: () => {
      const id = ++uid;
      let destroyed = false;
      return {
        _mockId: id,
        isDestroyed: () => destroyed,
        destroy: () => { destroyed = true; },
        setOpacity: vi.fn(),
        loadFile: vi.fn(),
        webContents: {
          on: vi.fn(),
          once: vi.fn((_event: string, cb?: () => void) => { cb?.(); }),
          send: vi.fn(),
        },
        on: vi.fn(),
        once: vi.fn(),
        showInactive: vi.fn(),
        hide: vi.fn(),
        setBounds: vi.fn(),
        getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
        setIgnoreMouseEvents: vi.fn(),
        setMenuBarVisibility: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        setVisibleOnAllWorkspaces: vi.fn(),
      };
    },
  };
});

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(() => makeMockWin()),
  screen: {
    getDisplayMatching: vi.fn(() => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getPrimaryDisplay: vi.fn(() => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getAllDisplays: vi.fn(() => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  app: { dock: { hide: vi.fn() } },
}));

vi.mock('../src/main/entity-windows', () => ({
  createWorkerWindow: vi.fn(() => makeMockWin()),
  createHouseWindow: vi.fn(() => makeMockWin()),
}));

vi.mock('../src/main/entity-geometry', () => ({
  workerWindowSize: vi.fn(() => ({ width: 120, height: 160 })),
  houseWindowSize: vi.fn(() => ({ width: 400, height: 200 })),
  houseEntitySize: vi.fn(() => ({ width: 144, height: 120 })),
  defaultHouseBounds: vi.fn(() => ({ x: 0, y: 800, width: 400, height: 200 })),
  clampRectToRect: vi.fn(<T>(r: T) => r),
  pickWorkerSpawnPoint: vi.fn(() => ({ x: 100, y: 500 })),
  resolveHouseCarrierPlacement: vi.fn(() => ({
    display: { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    bounds: { x: 0, y: 800, width: 400, height: 200 },
    entityBounds: { x: 128, y: 880, width: 144, height: 120 },
    entityOffset: { x: 128, y: 80 },
  })),
  placeHouseCarrier: vi.fn((_point, display) => ({
    display,
    bounds: { x: 0, y: 800, width: 400, height: 200 },
    entityBounds: { x: 128, y: 880, width: 144, height: 120 },
    entityOffset: { x: 128, y: 80 },
  })),
  moveRectToDisplay: vi.fn(<T>(r: T) => r),
  resolveDisplay: vi.fn(() => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const FADE_DURATION_MS = 500;

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
    get: () => t,
  };
}

function makeWorker(overrides: Partial<WorkerSnapshot> & { workerIdentityKey: string }): WorkerSnapshot {
  const workerIdentityKey = overrides.workerIdentityKey ?? 't1';
  const profile = overrides.profile ?? 'cb-dsf';
  return {
    workerIdentityKey,
    profile,
    phase: 'working',
    phaseSinceMs: 0,
    toolCount: 0,
    startedAt: 0,
    meta: {
      workerIdentityKey,
      profile,
      workDir: '',
      isWorktree: false,
      status: 'running',
    },
    ...overrides,
  };
}

function makeSnapshot(workers: WorkerSnapshot[]): SiteSnapshot {
  return { workers, queuedCount: 0 };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('EntityManager — key reuse after retirement', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();

    const config: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };

    em = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config,
      onConfigChange: vi.fn(),
      now: clock.now,
    });

    em.start();
  });

  afterEach(() => {
    em.dispose();
  });

  it('recreates window when retired key reappears (regression)', () => {
    const mockCreateWorker = vi.mocked(createWorkerWindow);
    mockCreateWorker.mockClear();

    // First lifecycle: create worker, then remove it (no worker in snapshot → destroy)
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', phase: 'working' })]));
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);

    // Empty snapshot → worker removed, destroyed
    em.syncSnapshot(makeSnapshot([]));

    // Tick to allow any pending fade
    clock.set(FADE_DURATION_MS + 1);
    em.tick();

    // Key reuse: same workerIdentityKey reappears
    mockCreateWorker.mockClear();
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', phase: 'working' })]));
    expect(mockCreateWorker).toHaveBeenCalledTimes(1); // window recreated
  });

  it('does not rebuild window when worker list is empty after removal', () => {
    const mockCreateWorker = vi.mocked(createWorkerWindow);
    mockCreateWorker.mockClear();

    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', phase: 'working' })]));
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);

    em.syncSnapshot(makeSnapshot([]));

    // Same empty snapshot — no new windows
    mockCreateWorker.mockClear();
    em.syncSnapshot(makeSnapshot([]));
    expect(mockCreateWorker).toHaveBeenCalledTimes(0);

    // Reuse before fade completion keeps the same window alive and cancels fade.
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', phase: 'working' })]));
    expect(mockCreateWorker).toHaveBeenCalledTimes(0);
    const workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].fade).toBeUndefined();
    expect(workers[0].window.isDestroyed()).toBe(false);
  });

  it('publishes a UI-only activity timestamp when tools or text change', () => {
    clock.set(1_000);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', toolCount: 0, lastText: 'starting' })]));

    let worker = Array.from((em as any).workers.values())[0];
    expect(worker.view.lastActivityTs).toBe(1_000);
    expect(worker.view.lastContentTs).toBe(1_000);

    clock.set(1_500);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', toolCount: 0, lastText: 'starting' })]));
    worker = Array.from((em as any).workers.values())[0];
    expect(worker.view.lastActivityTs).toBe(1_000);
    expect(worker.view.lastContentTs).toBe(1_000);

    clock.set(2_000);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', toolCount: 1, lastText: 'starting' })]));
    worker = Array.from((em as any).workers.values())[0];
    expect(worker.view.lastActivityTs).toBe(2_000);
    expect(worker.view.lastContentTs).toBe(1_000);

    clock.set(2_500);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', toolCount: 1, lastText: 'new output' })]));
    worker = Array.from((em as any).workers.values())[0];
    expect(worker.view.lastActivityTs).toBe(2_500);
    expect(worker.view.lastContentTs).toBe(2_500);
  });
});

describe('EntityManager — bubble-based delayed retirement', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();

    const config: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };

    em = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config,
      onConfigChange: vi.fn(),
      now: clock.now,
    });

    em.start();
  });

  afterEach(() => {
    em.dispose();
  });

  it('defers retirement when worker with active bubble is removed from snapshot', () => {
    clock.set(1000);
    // Worker has lastText → generates bubble with untilMs = 1000 + 6000 = 7000
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', lastText: 'working on it' })]));

    let workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].window.isDestroyed()).toBe(false);

    // Remove worker from snapshot — bubble still active, should NOT destroy window
    em.syncSnapshot(makeSnapshot([]));

    workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].window.isDestroyed()).toBe(false);
    expect(workers[0].pendingRetireUntil).toBe(7000);
  });

  it('does not destroy window before bubble expiry', () => {
    clock.set(0);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', lastText: 'working on it' })]));
    // bubble.untilMs = 0 + 6000 = 6000

    // Remove worker
    em.syncSnapshot(makeSnapshot([]));

    // Advance to just before bubble expiry
    clock.set(5000);
    em.tick();

    const workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].window.isDestroyed()).toBe(false);
    // No fade started yet
    expect(workers[0].fade).toBeUndefined();
  });

  it('starts fade-out at bubble expiry and destroys window after FADE_DURATION_MS', () => {
    clock.set(0);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', lastText: 'working on it' })]));
    // bubble.untilMs = 6000

    // Remove worker
    em.syncSnapshot(makeSnapshot([]));

    // Advance to bubble expiry
    clock.set(6000);
    em.tick();

    let workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    // FadeOut should have started
    expect(workers[0].fade).toBeDefined();
    expect(workers[0].fade.to).toBe(0);
    expect(workers[0].fade.destroyOnComplete).toBe(true);
    expect(workers[0].window.isDestroyed()).toBe(false);

    // Advance through fade duration
    clock.set(6000 + FADE_DURATION_MS);
    em.tick();

    // Worker should be fully destroyed and removed from the map
    workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(0);
  });

  it('cancels pending retirement when worker reappears before bubble expiry', () => {
    clock.set(0);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', lastText: 'working on it' })]));
    // bubble.untilMs = 6000

    // Remove worker → pendingRetireUntil = 6000
    em.syncSnapshot(makeSnapshot([]));

    let workers = Array.from((em as any).workers.values());
    expect(workers[0].pendingRetireUntil).toBe(6000);

    // Worker reappears before bubble expiry → pending retirement cancelled
    clock.set(3000);
    em.syncSnapshot(makeSnapshot([makeWorker({ workerIdentityKey: 't1', lastText: 'working on it' })]));

    workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].pendingRetireUntil).toBeUndefined();

    // Advance past original bubble expiry + fade duration
    clock.set(10000);
    em.tick();

    // Window still alive because reappearance cancelled the pending retirement
    workers = Array.from((em as any).workers.values());
    expect(workers).toHaveLength(1);
    expect(workers[0].window.isDestroyed()).toBe(false);
  });
});

describe('EntityManager — stats clear regression', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;

  const sampleStats: DailyStatsSnapshot = {
    dayKey: '2026-06-25',
    startAt: '2026-06-24T16:00:00.000Z',
    endAt: '2026-06-25T16:00:00.000Z',
    dispatchCount: 7,
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    source: 'sqlite',
  };

  beforeEach(() => {
    clock = makeClock();

    const config: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };

    em = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config,
      onConfigChange: vi.fn(),
      now: clock.now,
    });

    em.start();
  });

  afterEach(() => {
    em.dispose();
  });

  it('removes dailyStats from house update after explicit clear', () => {
    em.setDailyStats(sampleStats);

    // Stats are set — dailyStats should appear in the house update
    let houseSend = vi.mocked(createHouseWindow).mock.results[0]?.value.webContents.send as ReturnType<typeof vi.fn>;
    if (!houseSend) houseSend = vi.fn(); // fallback before window is created

    em.clearDailyStats();

    const lastUpdateCall = houseSend.mock.calls.findLast(
      ([channel]: unknown[]) => channel === 'house:update',
    );
    expect(lastUpdateCall).toBeDefined();
    expect(lastUpdateCall![1]).not.toHaveProperty('dailyStats');
  });
});

describe('EntityManager — quota tips plumbing', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;

  const sampleStats: DailyStatsSnapshot = {
    dayKey: '2026-06-25',
    startAt: '2026-06-24T16:00:00.000Z',
    endAt: '2026-06-25T16:00:00.000Z',
    dispatchCount: 7,
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    source: 'sqlite',
  };

  const sampleTips: QuotaTipLine[] = [
    { text: 'codex: 12.3k / 100k' },
    { text: 'openai: 4.5k / 50k' },
  ];

  beforeEach(() => {
    clock = makeClock();

    const config: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };

    em = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config,
      onConfigChange: vi.fn(),
      now: clock.now,
    });

    em.start();
  });

  afterEach(() => {
    em.dispose();
  });

  it('includes quotaTips in house update when set without disturbing dailyStats (regression)', () => {
    em.setDailyStats(sampleStats);

    const houseWin = em.getHouseWindow();
    expect(houseWin).toBeDefined();
    const houseSend = houseWin!.webContents.send as ReturnType<typeof vi.fn>;
    // Clear calls from setDailyStats so the next assertion only sees
    // the house:update emitted by setQuotaTips.
    houseSend.mockClear();

    (em as any).setQuotaTips(sampleTips);

    const lastUpdateCall = houseSend.mock.calls.find(
      ([channel]: unknown[]) => channel === 'house:update',
    );
    expect(lastUpdateCall).toBeDefined();
    expect(lastUpdateCall![1]).toHaveProperty('quotaTips');
    expect(lastUpdateCall![1].quotaTips).toEqual(sampleTips);
    expect(lastUpdateCall![1]).toHaveProperty('dailyStats');
    expect(lastUpdateCall![1].dailyStats).toEqual(sampleStats);
  });
});

describe('EntityManager — house skin', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;
  let onConfigChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clock = makeClock();

    onConfigChange = vi.fn();

    const config: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };

    em = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config,
      onConfigChange,
      now: clock.now,
    });

    em.start();
  });

  afterEach(() => {
    em.dispose();
  });

  it('setHouseSkin emits house:update with the new skin', () => {
    const houseWin = em.getHouseWindow();
    expect(houseWin).toBeDefined();
    const houseSend = houseWin!.webContents.send as ReturnType<typeof vi.fn>;

    em.setHouseSkin('mushroom');

    // Verify onConfigChange was called
    expect(onConfigChange).toHaveBeenCalled();

    // Verify house:update now includes mushroom
    const lastUpdateCall = houseSend.mock.calls.findLast(
      ([channel]: unknown[]) => channel === 'house:update',
    );
    expect(lastUpdateCall).toBeDefined();
    expect(lastUpdateCall![1]).toHaveProperty('houseSkin', 'mushroom');
  });

  it('setHouseSkin persists through config change callback', () => {
    let captured: AppConfig | undefined;
    const cfg: AppConfig = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      house: {},
      entities: { house: true, workers: true },
      appearance: { houseSkin: 'classic' },
    };
    const localEm = new EntityManager({
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      config: cfg,
      onConfigChange: (c) => { captured = c; },
      rng: () => 0.5,
    });
    localEm.start();

    localEm.setHouseSkin('mushroom');
    expect(captured).toBeDefined();
    expect(captured!.appearance.houseSkin).toBe('mushroom');

    localEm.dispose();
  });
});
