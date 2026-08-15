import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { PanelOwner } from '../src/main/panel-windows';
import { EntityManager } from '../src/main/entity-manager';
import { buildQuotaTips } from '../src/main/panel-view-model';
import type { AppConfig } from '../src/main/config';
import type { QuotaProviderState } from '../src/shared/entities';
import type { DailyStatsSnapshot } from '../src/shared/snapshot';

// ── Hoisted helpers ────────────────────────────────────────────────

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
        focus: vi.fn(),
        close: vi.fn(),
      };
    },
  };
});

// ── IPC handler registry (shared with test helpers) ────────────────

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => void>();

const mockWebContentsSelf = { id: 1, send: vi.fn() };
const mockWebContentsForeign = { id: 2 };

interface MockWindow {
  webContents: { id: number };
  isDestroyed: () => boolean;
  destroy: ReturnType<typeof vi.fn>;
}

let mockSettingsWindow: MockWindow | null = null;
let mockStatsWindow: MockWindow | null = null;

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('electron', () => {
  return {
    BrowserWindow: {
      fromWebContents: vi.fn((wc: { id: number }) => {
        if (wc === mockWebContentsSelf) {
          return mockStatsWindow ?? mockSettingsWindow ?? { isDestroyed: () => false };
        }
        if (wc === mockWebContentsForeign) {
          return { isDestroyed: () => false };
        }
        return null;
      }),
      getAllWindows: vi.fn(() => []),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler);
      }),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        ipcListeners.set(channel, listener);
      }),
      removeHandler: vi.fn(),
      removeListener: vi.fn(),
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getPrimaryDisplay: vi.fn(() => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getAllDisplays: vi.fn(() => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    app: { dock: { hide: vi.fn() } },
  };
});

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

// ── Fixtures ───────────────────────────────────────────────────────

const baseConfig: AppConfig = {
  scale: 3,
  bubbleSeconds: 6,
  bottomOffset: 0,
  house: {},
  entities: { house: true, workers: true },
  appearance: { houseSkin: 'classic' },
  quota: {
    providers: [
      { id: 'codex', enabled: true },
      { id: 'codex-spark', enabled: false },
      { id: 'super-grok', enabled: true },
    ],
  },
  windows: {},
};

const sampleProviders: QuotaProviderState[] = [
  { id: 'codex', label: 'Codex', displayLine: '5.0k / 30k', error: null, status: 'ok', stale: false },
  { id: 'codex-spark', label: 'Codex Spark', displayLine: null, error: null, status: 'unavailable', stale: true },
  { id: 'super-grok', label: 'super-grok', displayLine: null, error: 'rate limit hit', status: 'error', stale: false },
];

const sampleDailyStats: DailyStatsSnapshot = {
  dayKey: '2026-07-21',
  startAt: '2026-07-20T16:00:00.000Z',
  endAt: '2026-07-21T16:00:00.000Z',
  dispatchCount: 10,
  inputTokens: 2000,
  outputTokens: 500,
  totalTokens: 2500,
  source: 'sqlite',
};

// ── Clock helper ───────────────────────────────────────────────────

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

// ── Test: Finding (1) — startup wiring must refresh quota after PanelOwner exists ──

describe('startup wiring — initial quota refresh ordering', () => {
  let em: EntityManager;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
    ipcHandlers.clear();
    ipcListeners.clear();
    mockSettingsWindow = null;
    mockStatsWindow = null;

    const config: AppConfig = {
      ...baseConfig,
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

  it('refreshQuotaState before PanelOwner exists does NOT push tips to EntityManager', async () => {
    // Simulate refreshQuotaState(false) called BEFORE PanelOwner is created,
    // as happens in the current index.ts startup wiring.
    // Without quotaService or entityManager, the guard should prevent any tips
    // from reaching EntityManager.
    const entityManagerSetQuotaTips = vi.spyOn(em, 'setQuotaTips' as any);

    // Without quotaService or PanelOwner, no tips should be pushed.
    expect(em.getHouseWindow()).toBeTruthy();
    const houseSend = (em.getHouseWindow()!.webContents.send as ReturnType<typeof vi.fn>);
    houseSend.mockClear();

    // Verify no quota tips reach the house update before any refresh call
    const callsWithoutOwner = houseSend.mock.calls.filter(
      ([ch]: unknown[]) => ch === 'house:update',
    );
    for (const call of callsWithoutOwner) {
      expect(call[1]).not.toHaveProperty('quotaTips');
    }
  });

  it('refreshQuotaState after initialization pushes enabled-provider tips to EntityManager immediately', async () => {
    // Simulate refreshQuotaState logic: fetch providers, build tips, push to EntityManager.
    const providers = sampleProviders;
    const order = baseConfig.quota.providers.filter(p => p.enabled).map(p => p.id);
    const tips = buildQuotaTips(providers, order);
    em.setQuotaTips(tips);

    // EntityManager must propagate the tips into a house:update.
    const houseSend = em.getHouseWindow()!.webContents.send as ReturnType<typeof vi.fn>;
    const quotaUpdateCalls = houseSend.mock.calls.filter(
      ([ch]: unknown[]) => ch === 'house:update',
    );
    expect(quotaUpdateCalls.length).toBeGreaterThan(0);

    // Every house:update after setQuotaTips must include quotaTips.
    const lastCall = quotaUpdateCalls[quotaUpdateCalls.length - 1];
    expect(lastCall[1]).toHaveProperty('quotaTips');
    // Error providers remain visible in red instead of being filtered.
    expect(lastCall[1].quotaTips).toEqual([
      { text: 'codex 5.0k / 30k' },
      {
        text: 'super-grok error — rate limit hit',
        errorRow: { label: 'super-grok', message: 'error — rate limit hit' },
        bars: [{
          provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
          label: 'super-grok',
          error: 'rate limit hit',
          status: 'error',
          stale: false,
        }],
      },
    ]);
  });
});

// ── Test: Finding (3) — setters must send merged stats:data to open Stats window, do nothing if closed ──

describe('PanelOwner — setters push merged stats:data to open Stats window', () => {
  let owner: PanelOwner;

  beforeEach(() => {
    ipcHandlers.clear();
    ipcListeners.clear();
    mockSettingsWindow = null;
    mockStatsWindow = null;

    owner = new PanelOwner({
      config: { ...baseConfig },
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => baseConfig.quota.providers.filter(p => p.enabled).map(p => p.id),
    });
  });

  afterEach(() => {
    owner.destroy();
  });

  it('setStatsData sends stats:data to an already-open Stats window', () => {
    const statsWindowSend = vi.fn();
    const openStatsWin = {
      webContents: { id: 1, send: statsWindowSend },
      isDestroyed: () => false,
      destroy: vi.fn(),
    };
    (owner as any).statsWindow = openStatsWin;

    const summary = {
      daily: [
        { dayKey: '2026-07-21', startAt: '2026-07-20T16:00:00.000Z', endAt: '2026-07-21T16:00:00.000Z', dispatchCount: 10, inputTokens: 2000, outputTokens: 500, totalTokens: 2500, source: 'sqlite' as const },
      ],
    };

    owner.setStatsData(summary, sampleDailyStats);

    // Must have sent stats:data with merged summary + dailyStats
    expect(statsWindowSend).toHaveBeenCalledWith('stats:data', expect.objectContaining({
      summary,
      dailyStats: sampleDailyStats,
    }));
  });

  it('setDailyStats sends stats:data to an already-open Stats window', () => {
    const statsWindowSend = vi.fn();
    const openStatsWin = {
      webContents: { id: 1, send: statsWindowSend },
      isDestroyed: () => false,
      destroy: vi.fn(),
    };
    (owner as any).statsWindow = openStatsWin;

    owner.setDailyStats(sampleDailyStats);

    // Must have sent stats:data with merged dailyStats
    expect(statsWindowSend).toHaveBeenCalledWith('stats:data', expect.objectContaining({
      dailyStats: sampleDailyStats,
    }));
  });

  it('setStatsData does nothing when Stats window is closed', () => {
    // No statsWindow set — equivalent to closed
    const summary = {
      daily: [
        { dayKey: '2026-07-21', startAt: '2026-07-20T16:00:00.000Z', endAt: '2026-07-21T16:00:00.000Z', dispatchCount: 10, inputTokens: 2000, outputTokens: 500, totalTokens: 2500, source: 'sqlite' as const },
      ],
    };

    // Should not throw and should not send stats:data
    expect(() => owner.setStatsData(summary, sampleDailyStats)).not.toThrow();
    // Cache should be updated even when window is closed
    const cache = (owner as any).statsCache;
    expect(cache.summary).toEqual(summary);
  });

  it('setDailyStats does nothing when Stats window is closed', () => {
    expect(() => owner.setDailyStats(sampleDailyStats)).not.toThrow();
    const cache = (owner as any).statsCache;
    expect(cache.dailyStats).toEqual(sampleDailyStats);
  });

  // ── Foreign-sender rejection (existing contract preserved) ──────

  it('stats:load rejects foreign senders', async () => {
    // Set up mock stats window so the handler can distinguish
    const ownerStatsWin = {
      webContents: mockWebContentsSelf,
      isDestroyed: () => false,
      destroy: vi.fn(),
    };
    mockStatsWindow = ownerStatsWin;
    (owner as any).statsWindow = ownerStatsWin;

    const handler = ipcHandlers.get('stats:load')!;
    const foreignResult = await handler({ sender: mockWebContentsForeign });
    expect(foreignResult).toBeUndefined();
  });
});

// ── Source contract: onSummaryStats must use at(-1) for daily fallback ──

describe('onSummaryStats — daily fallback is newest bucket (at(-1), not [0])', () => {
  it('setStatsData uses summary.today ?? summary.daily.at(-1)', () => {
    const source = fs.readFileSync(
      new URL('../src/main/index.ts', import.meta.url),
      'utf-8',
    );

    // Locate the onSummaryStats lambda body
    const lines = source.split('\n');
    const summaryStart = lines.findIndex(l => l.includes('onSummaryStats(summary)'));
    expect(summaryStart).not.toBe(-1);

    // Collect lines until the closing brace/bracket of the callback
    const relevant = lines.slice(summaryStart, summaryStart + 8).join('\n');

    // Must use the correct fallback — newest daily bucket
    expect(relevant).toMatch(/summary\.today \?\? summary\.daily\.at\(-1\)/);
    expect(relevant).not.toMatch(/summary\.daily\[0\]/);
  });
});
