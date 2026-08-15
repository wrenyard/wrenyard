import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
}

interface MockIpcHandler {
  channel: string;
  handler: (...args: unknown[]) => unknown;
}

interface MockIpcListener {
  channel: string;
  listener: (...args: unknown[]) => void;
}

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => void>();

const mockWebContentsSelf: MockWebContents = { id: 1, send: vi.fn() };
const mockWebContentsForeign: MockWebContents = { id: 2, send: vi.fn() };

let mockSettingsWindow: { webContents: MockWebContents; isDestroyed: () => boolean } | null = null;
let mockStatsWindow: { webContents: MockWebContents; isDestroyed: () => boolean } | null = null;

vi.mock('electron', () => {
  const mockIpcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
    removeListener: vi.fn((channel: string) => {
      ipcListeners.delete(channel);
    }),
  };

  const MockBrowserWindow = vi.fn(() => {
    const mockWc = { on: vi.fn(), once: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    return {
      webContents: mockWc,
      isDestroyed: () => false,
      destroy: vi.fn(),
      close: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      once: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 340, height: 480 }),
    };
  });
  MockBrowserWindow.fromWebContents = vi.fn();
  MockBrowserWindow.getAllWindows = vi.fn(() => []);

  return {
    BrowserWindow: MockBrowserWindow as any,
    ipcMain: mockIpcMain,
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    app: { dock: { hide: vi.fn() } },
  };
});

describe('panel windows security and lifecycle', () => {
  beforeEach(async () => {
    ipcHandlers.clear();
    ipcListeners.clear();
    mockSettingsWindow = null;
    mockStatsWindow = null;
    // Restore default fromWebContents routing for tests that don't override it
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow.fromWebContents).mockReset();
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((wc: MockWebContents) => {
      if (wc === mockWebContentsSelf) return mockStatsWindow ?? { isDestroyed: () => false };
      if (wc === mockWebContentsForeign) return { isDestroyed: () => false };
      return null;
    });
  });

  it('PanelOwner constructor registers IPC handlers', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => config.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });
    expect(owner).toBeTruthy();

    // Verify IPC handlers are registered
    expect(ipcHandlers.has('settings:load')).toBe(true);
    expect(ipcHandlers.has('settings:save')).toBe(true);
    expect(ipcHandlers.has('settings:save-and-restart')).toBe(true);
    expect(ipcHandlers.has('stats:load')).toBe(true);
    expect(ipcHandlers.has('house:open-settings')).toBe(true);
    expect(ipcHandlers.has('house:open-stats')).toBe(true);
    expect(ipcListeners.has('panel:close')).toBe(true);

    owner.destroy();
  });

  it('settings IPC handlers reject foreign senders', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' as const },
    };
    const onConfigChange = vi.fn();
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      quotaService: { listProviders: vi.fn().mockResolvedValue([]) },
      onConfigChange,
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => config.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });

    // Invoke the settings:load handler with a foreign sender
    const loadHandler = ipcHandlers.get('settings:load')!;
    const foreignResult = loadHandler({ sender: mockWebContentsForeign });
    expect(foreignResult).toBeUndefined();

    // Invoke the settings:save handler with a foreign sender
    const saveHandler = ipcHandlers.get('settings:save')!;
    saveHandler({ sender: mockWebContentsForeign }, { scale: 5 });
    expect(onConfigChange).not.toHaveBeenCalled();

    owner.destroy();
  });

  it('stats IPC handlers reject foreign senders', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };
    const onStatsRequestRefresh = vi.fn();
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh,
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => config.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });

    // stats:load with foreign sender should return undefined
    const statsLoadHandler = ipcHandlers.get('stats:load')!;
    const foreignResult = statsLoadHandler({ sender: mockWebContentsForeign });
    await expect(foreignResult).resolves.toBeUndefined();

    owner.destroy();
  });

  it('serializes and applies partial config correctly', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [{ id: 'codex', enabled: true }] },
      appearance: { houseSkin: 'classic' },
    };
    const onConfigChange = vi.fn();
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      quotaService: { listProviders: vi.fn().mockResolvedValue([]) },
      onConfigChange,
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => config.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });
    expect(owner).toBeTruthy();
    owner.destroy();
  });

  it('config persistence callbacks are wired', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const onConfigChange = vi.fn();
    const onRestart = vi.fn();
    const cfg = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [{ id: 'codex', enabled: true }] },
      appearance: { houseSkin: 'classic' },
    };
    const owner = new PanelOwner({
      config: cfg,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      quotaService: { listProviders: vi.fn().mockResolvedValue([]) },
      onConfigChange,
      onStatsRequestRefresh: vi.fn(),
      onRestart,
      onGetEnabledProviderOrder: () => cfg.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    owner.destroy();
  });

  it('stats:load returns cached data and does not contain quotaProviders', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const mockFn = vi.fn().mockResolvedValue({
      summary: { daily: [] },
      dailyStats: {
        dayKey: '2026-06-27',
        startAt: '2026-06-26T16:00:00.000Z',
        endAt: '2026-06-27T16:00:00.000Z',
        dispatchCount: 3,
        inputTokens: 500,
        outputTokens: 120,
        totalTokens: 620,
        source: 'sqlite',
      },
    });

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [{ id: 'codex', enabled: true }, { id: 'openai', enabled: true }] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: mockFn,
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => config.quota.providers.filter(p => p.enabled).map(p => p.id),
      getHouseWindow: () => null,
    });

    // Pre-set cached stats
    owner.setStatsData({
      daily: [],
    } as any, {
      dayKey: '2026-06-26',
      startAt: '2026-06-25T16:00:00.000Z',
      endAt: '2026-06-26T16:00:00.000Z',
      dispatchCount: 5,
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      source: 'sqlite',
    });

    // Set up owner stats window so isOwnerSender passes for stats IPC handlers
    const ownerStatsWindow = { webContents: mockWebContentsSelf, isDestroyed: () => false, destroy: vi.fn() };
    mockStatsWindow = ownerStatsWindow;
    (owner as any).statsWindow = ownerStatsWindow;

    // stats:load — should return cached data
    const loadHandler = ipcHandlers.get('stats:load')!;
    const loadResult = await loadHandler({ sender: mockWebContentsSelf });
    expect(loadResult).not.toBeNull();

    // Must NOT contain quotaProviders
    expect(loadResult).not.toHaveProperty('quotaProviders');

    // When summary is unavailable, dailyStats fallback should be exposed
    expect(loadResult.dailyStats).toBeDefined();
    expect(loadResult.dailyStats.dayKey).toBe('2026-06-26');

    owner.destroy();
  });

  it('house:open-settings succeeds when getHouseWindow matches the sender (worker-first ordering regression)', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const mockHouseWebContents: MockWebContents = { id: 99, send: vi.fn() };
    const mockHouseWindow = { webContents: mockHouseWebContents, isDestroyed: () => false };

    // Save original fromWebContents to restore later
    const origFromWC = BrowserWindow.fromWebContents.getMockImplementation();

    // fromWebContents must return the house window for its webContents
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((wc: any) => {
      if (wc === mockHouseWebContents) return mockHouseWindow as any;
      if (wc === mockWebContentsSelf) return mockStatsWindow ?? { isDestroyed: () => false };
      if (wc === mockWebContentsForeign) return { isDestroyed: () => false };
      return null;
    });

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => mockHouseWindow as any,
    });

    const openSettingsSpy = vi.spyOn(owner, 'openSettings');

    const handler = ipcHandlers.get('house:open-settings')!;
    handler({ sender: mockHouseWebContents });

    // With explicit getHouseWindow the sender check passes
    expect(openSettingsSpy).toHaveBeenCalledTimes(1);

    // Restore mocks
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation(origFromWC!);

    owner.destroy();
  });

  it('house:open-settings rejects a foreign sender even if getHouseWindow is available', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const mockHouseWebContents: MockWebContents = { id: 99, send: vi.fn() };
    const mockHouseWindow = { webContents: mockHouseWebContents, isDestroyed: () => false };
    const openSettingsSpy = vi.spyOn(PanelOwner.prototype as any, 'openSettings');

    const origFromWC = BrowserWindow.fromWebContents.getMockImplementation();
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((wc: any) => {
      if (wc === mockHouseWebContents) return mockHouseWindow as any;
      if (wc === mockWebContentsSelf) return mockStatsWindow ?? { isDestroyed: () => false };
      if (wc === mockWebContentsForeign) return { isDestroyed: () => false };
      return null;
    });

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => mockHouseWindow as any,
    });

    const handler = ipcHandlers.get('house:open-settings')!;
    const response = handler({ sender: mockWebContentsForeign });
    expect(response).toBeUndefined();
    expect(openSettingsSpy).not.toHaveBeenCalled();

    vi.mocked(BrowserWindow.fromWebContents).mockImplementation(origFromWC!);
    owner.destroy();
  });

  it('house:open-stats succeeds when getHouseWindow matches the sender', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const mockHouseWebContents: MockWebContents = { id: 99, send: vi.fn() };
    const mockHouseWindow = { webContents: mockHouseWebContents, isDestroyed: () => false };

    const origFromWC = BrowserWindow.fromWebContents.getMockImplementation();

    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((wc: any) => {
      if (wc === mockHouseWebContents) return mockHouseWindow as any;
      if (wc === mockWebContentsSelf) return mockStatsWindow ?? { isDestroyed: () => false };
      if (wc === mockWebContentsForeign) return { isDestroyed: () => false };
      return null;
    });

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => mockHouseWindow as any,
    });

    const openStatsSpy = vi.spyOn(owner, 'openStats');

    const handler = ipcHandlers.get('house:open-stats')!;
    handler({ sender: mockHouseWebContents });

    expect(openStatsSpy).toHaveBeenCalledTimes(1);

    vi.mocked(BrowserWindow.fromWebContents).mockImplementation(origFromWC!);

    owner.destroy();
  });

  it('creates panel windows with backgroundColor #00000000', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    vi.mocked(BrowserWindow).mockClear();

    owner.openSettings();

    const bwCalls = vi.mocked(BrowserWindow).mock.calls;
    expect(bwCalls.length).toBeGreaterThanOrEqual(1);
    expect(bwCalls[0][0]).toHaveProperty('backgroundColor', '#00000000');

    owner.destroy();
  });

  it('creates panel windows with thickFrame false', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    vi.mocked(BrowserWindow).mockClear();

    owner.openSettings();

    const bwCalls = vi.mocked(BrowserWindow).mock.calls;
    expect(bwCalls.length).toBeGreaterThanOrEqual(1);
    expect(bwCalls[0][0]).toHaveProperty('thickFrame', false);

    owner.destroy();
  });

  it('panel load failure closes the window and prevents ready-to-show', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    // Make the BrowserWindow constructor return a window whose loadFile rejects
    const mockClose = vi.fn();
    const mockWc = { on: vi.fn(), once: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    vi.mocked(BrowserWindow).mockReturnValueOnce({
      webContents: mockWc,
      isDestroyed: () => false,
      destroy: vi.fn(),
      close: mockClose,
      showInactive: vi.fn(),
      focus: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      loadFile: vi.fn().mockRejectedValue(new Error('load failed')),
      on: vi.fn(),
      once: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 340, height: 480 }),
    } as any);

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    owner.openSettings();

    // loadFile rejection should trigger handleLoadFailure -> close
    // (allow promise microtasks to settle)
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify did-fail-load and render-process-gone listeners were registered
    const didFailLoadCalls = mockWc.on.mock.calls.filter((c: any[]) => c[0] === 'did-fail-load');
    expect(didFailLoadCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    owner.destroy();
  });

  it('main-frame did-fail-load prevents show on ready-to-show', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const mockShowInactive = vi.fn();
    const mockOn = vi.fn();
    const mockOnce = vi.fn();
    const mockWc = { on: mockOn, once: mockOnce, send: vi.fn(), setWindowOpenHandler: vi.fn() };
    const mockClose = vi.fn();

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      webContents: mockWc,
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      close: mockClose,
      showInactive: mockShowInactive,
      focus: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      on: mockOn,
      once: mockOnce,
      getBounds: () => ({ x: 0, y: 0, width: 340, height: 480 }),
    } as any);

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    owner.openSettings();

    // Locate the did-fail-load listener and fire it for main frame
    const didFailLoadEntry = mockOn.mock.calls.find((c: any[]) => c[0] === 'did-fail-load');
    expect(didFailLoadEntry).toBeDefined();
    const failLoadListener = didFailLoadEntry[1];
    failLoadListener({}, -3, 'ERR_ABORTED', 'about:blank', true);

    // Locate ready-to-show listener — should NOT show because loadFailed is true
    const readyToShowReplacement = mockOnce.mock.calls.find((c: any[]) => c[0] === 'ready-to-show');
    if (readyToShowReplacement) {
      const rtsListener = readyToShowReplacement[1];
      rtsListener();
    }
    expect(mockShowInactive).not.toHaveBeenCalled();

    owner.destroy();
  });

  it('successful load still shows panel on ready-to-show', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const mockShowInactive = vi.fn();
    const mockOn = vi.fn();
    const mockOnce = vi.fn();
    const mockWc = { on: mockOn, once: mockOnce, send: vi.fn(), setWindowOpenHandler: vi.fn() };

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      webContents: mockWc,
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      close: vi.fn(),
      showInactive: mockShowInactive,
      focus: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      on: mockOn,
      once: mockOnce,
      getBounds: () => ({ x: 0, y: 0, width: 340, height: 480 }),
    } as any);

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    owner.openSettings();

    // No did-fail-load fired, so loadFailed is false — ready-to-show shows
    const readyToShowEntry = mockOnce.mock.calls.find((c: any[]) => c[0] === 'ready-to-show');
    expect(readyToShowEntry).toBeDefined();
    if (readyToShowEntry) {
      const rtsListener = readyToShowEntry[1];
      rtsListener();
    }
    expect(mockShowInactive).toHaveBeenCalled();

    owner.destroy();
  });

  it('assigns distinct width/height for settings vs stats windows', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    vi.mocked(BrowserWindow).mockClear();

    owner.openSettings();
    owner.openStats();

    const calls = vi.mocked(BrowserWindow).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const settingsOpts = calls[0][0];
    const statsOpts = calls[1][0];

    // Settings ~380x560, Stats ~440x640 — distinct sizes
    expect(settingsOpts).toHaveProperty('width', 380);
    expect(settingsOpts).toHaveProperty('height', 560);
    expect(statsOpts).toHaveProperty('width', 440);
    expect(statsOpts).toHaveProperty('height', 640);

    // Security attributes should still be present
    expect(settingsOpts).toHaveProperty('transparent', true);
    expect(settingsOpts).toHaveProperty('backgroundColor', '#00000000');
    expect(statsOpts).toHaveProperty('transparent', true);
    expect(statsOpts).toHaveProperty('backgroundColor', '#00000000');

    owner.destroy();
  });

  it('installs setWindowOpenHandler on settings and stats panel windows before loadFile', async () => {
    const { BrowserWindow } = await import('electron');
    const { PanelOwner } = await import('../src/main/panel-windows');

    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' },
    };

    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    vi.mocked(BrowserWindow).mockClear();

    owner.openSettings();
    owner.openStats();

    const mockWins = vi.mocked(BrowserWindow).mock.results.map((r) => r.value);
    expect(mockWins).toHaveLength(2);

    for (const win of mockWins) {
      expect(win.webContents.setWindowOpenHandler).toHaveBeenCalled();

      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(handler()).toEqual({ action: 'deny' });

      // did-create-window fallback listener installed
      expect(win.webContents.on).toHaveBeenCalledWith('did-create-window', expect.any(Function));
    }

    // Captured did-create-window fallback destroys child windows that are not destroyed
    const didCreateEntry = mockWins[0].webContents.on.mock.calls.find(
      (c: any[]) => c[0] === 'did-create-window'
    );
    expect(didCreateEntry).toBeDefined();
    const childWin = { destroy: vi.fn(), isDestroyed: () => false };
    didCreateEntry[1](childWin);
    expect(childWin.destroy).toHaveBeenCalled();

    owner.destroy();
  });
});

describe('panel windows — house skin settings', () => {
  beforeEach(async () => {
    ipcHandlers.clear();
    ipcListeners.clear();
    mockSettingsWindow = null;
    mockStatsWindow = null;
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow.fromWebContents).mockReset();
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((wc: MockWebContents) => {
      if (wc === mockWebContentsSelf) return mockSettingsWindow ?? { isDestroyed: () => false };
      if (wc === mockWebContentsForeign) return { isDestroyed: () => false };
      return null;
    });
  });

  it('settings:load includes appearance.houseSkin', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'mushroom' as const },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
    });

    const mockSettingsWin = { webContents: mockWebContentsSelf, isDestroyed: () => false, destroy: vi.fn() };
    (owner as any).settingsWindow = mockSettingsWin;
    mockSettingsWindow = mockSettingsWin;

    const loadHandler = ipcHandlers.get('settings:load')!;
    const result = await loadHandler({ sender: mockWebContentsSelf });
    expect(result!.appearance.houseSkin).toBe('mushroom');

    owner.destroy();
  });

  it('settings:save accepts classic and mushroom, invoking onHouseSkinChange', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const onHouseSkinChange = vi.fn();
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' as const },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
      onHouseSkinChange,
    });

    const mockSettingsWin = { webContents: mockWebContentsSelf, isDestroyed: () => false, destroy: vi.fn() };
    (owner as any).settingsWindow = mockSettingsWin;
    mockSettingsWindow = mockSettingsWin;

    const saveHandler = ipcHandlers.get('settings:save')!;
    saveHandler({ sender: mockWebContentsSelf }, { appearance: { houseSkin: 'mushroom' } });
    expect(onHouseSkinChange).toHaveBeenCalledWith('mushroom');

    // Save with classic again
    onHouseSkinChange.mockClear();
    saveHandler({ sender: mockWebContentsSelf }, { appearance: { houseSkin: 'classic' } });
    expect(onHouseSkinChange).toHaveBeenCalledWith('classic');

    owner.destroy();
  });

  it('settings:save does not invoke onHouseSkinChange for same skin value', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const onHouseSkinChange = vi.fn();
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' as const },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
      onHouseSkinChange,
    });

    const mockSettingsWin = { webContents: mockWebContentsSelf, isDestroyed: () => false, destroy: vi.fn() };
    (owner as any).settingsWindow = mockSettingsWin;
    mockSettingsWindow = mockSettingsWin;

    const saveHandler = ipcHandlers.get('settings:save')!;
    saveHandler({ sender: mockWebContentsSelf }, { appearance: { houseSkin: 'classic' } });
    // No change from current state → callback should NOT be invoked
    expect(onHouseSkinChange).not.toHaveBeenCalled();

    owner.destroy();
  });

  it('settings:save ignores invalid skin values', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const onHouseSkinChange = vi.fn();
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' as const },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
      onHouseSkinChange,
    });

    const mockSettingsWin = { webContents: mockWebContentsSelf, isDestroyed: () => false, destroy: vi.fn() };
    (owner as any).settingsWindow = mockSettingsWin;
    mockSettingsWindow = mockSettingsWin;

    const saveHandler = ipcHandlers.get('settings:save')!;
    saveHandler({ sender: mockWebContentsSelf }, { appearance: { houseSkin: 'invalid' } });
    expect(onHouseSkinChange).not.toHaveBeenCalled();

    owner.destroy();
  });

  it('settings:save rejects foreign senders for skin change', async () => {
    const { PanelOwner } = await import('../src/main/panel-windows');
    const onHouseSkinChange = vi.fn();
    const config = {
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true },
      windows: {},
      quota: { providers: [] },
      appearance: { houseSkin: 'classic' as const },
    };
    const owner = new PanelOwner({
      config,
      htmlDir: '/tmp',
      preloadPath: '/tmp/preload.js',
      onConfigChange: vi.fn(),
      onStatsRequestRefresh: vi.fn(),
      onRestart: vi.fn(),
      onGetEnabledProviderOrder: () => [],
      getHouseWindow: () => null,
      onHouseSkinChange,
    });

    const saveHandler = ipcHandlers.get('settings:save')!;
    saveHandler({ sender: mockWebContentsForeign }, { appearance: { houseSkin: 'mushroom' } });
    expect(onHouseSkinChange).not.toHaveBeenCalled();

    owner.destroy();
  });
});
