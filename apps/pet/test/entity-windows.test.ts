import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeMockWin } = vi.hoisted(() => {
  let uid = 0;
  return {
    makeMockWin: () => {
      const id = ++uid;
      let destroyed = false;
      const mockWc = {
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };
      return {
        _mockId: id,
        webContents: mockWc,
        isDestroyed: () => destroyed,
        destroy: () => { destroyed = true; },
        close: vi.fn(),
        setOpacity: vi.fn(),
        loadFile: vi.fn().mockResolvedValue(undefined),
        showInactive: vi.fn(),
        hide: vi.fn(),
        setBounds: vi.fn(),
        getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
        setIgnoreMouseEvents: vi.fn(),
        setMenuBarVisibility: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        setVisibleOnAllWorkspaces: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
      };
    },
  };
});

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

describe('entity windows', () => {
  beforeEach(async () => {
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow).mockClear();
  });

  it('creates house and worker windows with backgroundColor #00000000', async () => {
    const { createHouseWindow, createWorkerWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const bounds = { x: 0, y: 0, width: 120, height: 160 };

    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
    });

    createWorkerWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/worker.html',
      bounds,
      visible: true,
    });

    const calls = vi.mocked(BrowserWindow).mock.calls;
    expect(calls).toHaveLength(2);

    for (const [opts] of calls) {
      expect(opts).toHaveProperty('backgroundColor', '#00000000');
      expect(opts).toHaveProperty('thickFrame', false);
    }
  });

  it('main-frame did-fail-load prevents showing the window', async () => {
    const { createHouseWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const mockOn = vi.fn();
    const mockOnce = vi.fn();
    const mockWc = { on: mockOn, once: mockOnce, send: vi.fn(), setWindowOpenHandler: vi.fn() };
    const mockShowInactive = vi.fn();
    const mockClose = vi.fn();
    let destroyed = false;

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      _mockId: 99,
      webContents: mockWc,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: mockClose,
      setOpacity: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      showInactive: mockShowInactive,
      hide: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
      setIgnoreMouseEvents: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      on: mockOn,
      once: mockOnce,
    } as any);

    const bounds = { x: 0, y: 0, width: 120, height: 160 };
    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
    });

    // Fire did-fail-load for main frame — should set loadFailed
    const failLoadEntry = mockOn.mock.calls.find(
      (c: any[]) => c[0] === 'did-fail-load'
    );
    expect(failLoadEntry).toBeDefined();
    const failLoadListener = failLoadEntry[1];
    failLoadListener({}, -3, 'ERR_ABORTED', 'about:blank', true);

    // ready-to-show should NOT show the window
    const rtsEntry = mockOnce.mock.calls.find(
      (c: any[]) => c[0] === 'ready-to-show'
    );
    if (rtsEntry) {
      rtsEntry[1]();
    }

    expect(mockShowInactive).not.toHaveBeenCalled();
  });

  it('loadFile rejection prevents showing the window', async () => {
    const { createHouseWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const mockShowInactive = vi.fn();
    const mockOnce = vi.fn();
    const mockOn = vi.fn();
    const mockWc = { on: mockOn, once: mockOnce, send: vi.fn(), setWindowOpenHandler: vi.fn() };
    let destroyed = false;

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      _mockId: 99,
      webContents: mockWc,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: vi.fn(),
      setOpacity: vi.fn(),
      loadFile: vi.fn().mockRejectedValue(new Error('load failed')),
      showInactive: mockShowInactive,
      hide: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
      setIgnoreMouseEvents: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      on: mockOn,
      once: mockOnce,
    } as any);

    const bounds = { x: 0, y: 0, width: 120, height: 160 };
    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
    });

    // Allow microtask to settle after loadFile rejection
    await new Promise(resolve => setTimeout(resolve, 0));

    // ready-to-show should not show the window
    const rtsEntry = mockOnce.mock.calls.find(
      (c: any[]) => c[0] === 'ready-to-show'
    );
    if (rtsEntry) {
      rtsEntry[1]();
    }

    expect(mockShowInactive).not.toHaveBeenCalled();
  });

  it('normal ready-to-show is preserved when load succeeds', async () => {
    const { createHouseWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const mockShowInactive = vi.fn();
    const mockOnce = vi.fn();
    const mockOn = vi.fn();
    const mockWc = { on: mockOn, once: mockOnce, send: vi.fn(), setWindowOpenHandler: vi.fn() };
    let destroyed = false;

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      _mockId: 99,
      webContents: mockWc,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: vi.fn(),
      setOpacity: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      showInactive: mockShowInactive,
      hide: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
      setIgnoreMouseEvents: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      on: mockOn,
      once: mockOnce,
    } as any);

    const bounds = { x: 0, y: 0, width: 120, height: 160 };
    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
    });

    // No load failure, so ready-to-show should show the window
    const rtsEntry = mockOnce.mock.calls.find(
      (c: any[]) => c[0] === 'ready-to-show'
    );
    expect(rtsEntry).toBeDefined();
    if (rtsEntry) {
      rtsEntry[1]();
    }

    expect(mockShowInactive).toHaveBeenCalled();
  });

  it('installs setWindowOpenHandler before loadFile on every entity window', async () => {
    const { createHouseWindow, createWorkerWindow } = await import('../src/main/entity-windows');

    const bounds = { x: 0, y: 0, width: 120, height: 160 };

    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
    });

    createWorkerWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/worker.html',
      bounds,
      visible: true,
    });

    const { BrowserWindow } = await import('electron');
    const mockWins = vi.mocked(BrowserWindow).mock.results.map((r) => r.value);

    expect(mockWins).toHaveLength(2);

    for (const win of mockWins) {
      expect(win.webContents.setWindowOpenHandler).toHaveBeenCalled();

      // The handler must deny all window.open requests
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
  });

  it('late main-frame did-fail-load hides an already-visible window; successful renderer recovery does not', async () => {
    const { createHouseWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const mockShowInactive = vi.fn();
    const mockOnce = vi.fn();
    const mockOn = vi.fn();
    const mockHide = vi.fn();
    const mockClose = vi.fn();
    const mockRecovered = vi.fn();
    const mockReload = vi.fn();
    let destroyed = false;

    vi.mocked(BrowserWindow).mockReturnValueOnce({
      _mockId: 99,
      webContents: { on: mockOn, once: mockOnce, send: vi.fn(), reload: mockReload, setWindowOpenHandler: vi.fn() },
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: mockClose,
      setOpacity: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      showInactive: mockShowInactive,
      hide: mockHide,
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 120, height: 160 }),
      setIgnoreMouseEvents: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      on: mockOn,
      once: mockOnce,
    } as any);

    const bounds = { x: 0, y: 0, width: 120, height: 160 };
    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds,
      visible: true,
      onRendererRecovered: mockRecovered,
    });

    // 1. ready-to-show fires first (no prior failure) → window shown
    const rtsEntry = mockOnce.mock.calls.find(
      (c: any[]) => c[0] === 'ready-to-show'
    );
    expect(rtsEntry).toBeDefined();
    rtsEntry[1]();
    expect(mockShowInactive).toHaveBeenCalledTimes(1);

    // 2. Late main-frame did-fail-load → hides exactly once
    const failEntry = mockOn.mock.calls.find(
      (c: any[]) => c[0] === 'did-fail-load'
    );
    expect(failEntry).toBeDefined();
    const failListener = failEntry[1];
    failListener({}, -3, 'ERR_ABORTED', 'about:blank', true);

    expect(mockHide).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled();

    // Duplicate did-fail-load must NOT hide again
    failListener({}, -3, 'ERR_ABORTED', 'about:blank', true);
    expect(mockHide).toHaveBeenCalledTimes(1);

    // 3. render-process-gone → successful reload without did-fail-load keeps window intact
    mockHide.mockClear();
    mockClose.mockClear();

    const rpgEntry = mockOn.mock.calls.find(
      (c: any[]) => c[0] === 'render-process-gone'
    );
    expect(rpgEntry).toBeDefined();
    rpgEntry[1]();

    expect(mockReload).toHaveBeenCalledTimes(1);

    // did-finish-load fires (no did-fail-load in between) → no hide/close
    const dflEntry = mockOnce.mock.calls.find(
      (c: any[]) => c[0] === 'did-finish-load'
    );
    expect(dflEntry).toBeDefined();
    dflEntry[1]();

    expect(mockRecovered).toHaveBeenCalledTimes(1);
    expect(mockHide).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('suppresses the default context menu on overlay entities', async () => {
    const { createHouseWindow } = await import('../src/main/entity-windows');
    const { BrowserWindow } = await import('electron');

    const mockOn = vi.fn();
    const mockWc = { on: mockOn, once: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    vi.mocked(BrowserWindow).mockReturnValueOnce({
      ...makeMockWin(),
      webContents: mockWc,
      once: vi.fn(),
    } as any);

    createHouseWindow({
      preloadPath: '/tmp/preload.js',
      htmlPath: '/tmp/house.html',
      bounds: { x: 0, y: 0, width: 120, height: 160 },
      visible: true,
    });

    const contextMenu = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'context-menu');
    expect(contextMenu).toBeDefined();
    const event = { preventDefault: vi.fn() };
    (contextMenu![1] as (event: { preventDefault: () => void }) => void)(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
