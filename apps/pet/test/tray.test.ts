import { describe, expect, it, vi } from 'vitest';

interface MockMenuItem {
  label: string;
  click?: (menuItem?: MockMenuItem) => void;
  submenu?: MockMenuItem[];
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  icon?: unknown;
}

function findMenuItem(items: MockMenuItem[], label: string): MockMenuItem | undefined {
  for (const item of items) {
    if (item.label === label) return item;
    if (item.submenu) {
      const found = findMenuItem(item.submenu, label);
      if (found) return found;
    }
  }
  return undefined;
}

const menuItems: MockMenuItem[] = [];

vi.mock('electron', () => {
  const mockDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 2,
    rotation: 0,
    touchSupport: 'unknown',
    accelerometerSupport: 'unknown',
    monochrome: false,
    depthPerComponent: 8,
    displayFrequency: 60,
    internal: false,
  };

  const mockPrimaryDisplay = {
    ...mockDisplay,
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };

  const mockScreen = {
    getAllDisplays: vi.fn(() => [mockDisplay]),
    getPrimaryDisplay: vi.fn(() => mockPrimaryDisplay),
    getDisplayNearestPoint: vi.fn(() => mockPrimaryDisplay),
    getDisplayMatching: vi.fn(() => mockPrimaryDisplay),
    getCursorScreenPoint: vi.fn(() => ({ x: 960, y: 540 })),
    on: vi.fn(),
    off: vi.fn(),
  };

  class MockTray {
    setContextMenu = vi.fn();
    setImage = vi.fn();
    setToolTip = vi.fn();
    setTitle = vi.fn();
    destroy = vi.fn();
  }

  const mockMenu = {
    buildFromTemplate: vi.fn((template: MockMenuItem[]) => {
      menuItems.length = 0;
      menuItems.push(...template);
      return {};
    }),
  };

  const mockNativeImage = {
    createFromPath: vi.fn(() => ({
      resize: vi.fn(() => ({})),
    })),
    createFromBuffer: vi.fn(() => ({
      isEmpty: vi.fn(() => false),
      resize: vi.fn(() => ({})),
      setTemplateImage: vi.fn(),
    })),
  };

  return {
    Tray: MockTray,
    Menu: mockMenu,
    nativeImage: mockNativeImage,
    screen: mockScreen,
    app: {
      getPath: vi.fn(() => '/tmp'),
      getName: vi.fn(() => 'Foreman'),
      quit: vi.fn(),
    },
  };
});

describe('tray', () => {
  it('includes Settings entry that invokes the correct callback', async () => {
    const onSettings = vi.fn();
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings, onStats: vi.fn() });
    const settings = findMenuItem(menuItems, '设置');
    expect(settings).toBeDefined();
    settings!.click!();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('includes Stats entry that invokes the correct callback', async () => {
    const onStats = vi.fn();
    const { createTray } = await import('../src/main/tray');
    createTray({ onStats, onSettings: vi.fn() });
    const stats = findMenuItem(menuItems, '统计');
    expect(stats).toBeDefined();
    stats!.click!();
    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it('includes quota submenu with one disabled icon item per provider group', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({
      onSettings: vi.fn(),
      onStats: vi.fn(),
      getQuotaRows: () => [
        {
          provider: 'kimi-coding',
          window: '5h',
          remainingPct: 100,
          expectedRemainingPct: null,
          label: 'kimi-coding 5h 100%',
        },
        {
          provider: '',
          window: '7d',
          remainingPct: 97,
          expectedRemainingPct: 52,
          label: 'kimi-coding 7d 97%',
        },
        {
          provider: 'codex',
          window: '7d',
          remainingPct: 40,
          expectedRemainingPct: null,
          label: 'codex 7d 40%',
        },
      ],
    });
    const quota = menuItems.find((item) => item.label === '额度');
    expect(quota).toBeDefined();
    // Two consecutive rows of kimi-coding collapse to one item; codex is another.
    expect(quota!.submenu).toHaveLength(2);
    expect(quota!.submenu?.every((item) => item.enabled === false)).toBe(true);
    expect(quota!.submenu?.every((item) => item.icon !== undefined)).toBe(true);
  });

  it('shows a placeholder when quota rows are empty', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn(), getQuotaRows: () => [] });
    const quota = menuItems.find((item) => item.label === '额度');
    expect(quota?.submenu).toEqual([{ label: '暂无额度', enabled: false }]);
  });

  it('rebuilds quota submenu when quota rows change', async () => {
    const { createTray } = await import('../src/main/tray');
    let rows = [{
      provider: 'codex',
      window: '7d',
      remainingPct: 0,
      expectedRemainingPct: 8,
      label: 'codex 7d 0%',
    }];
    const { tray, rebuildMenu } = createTray({
      onSettings: vi.fn(),
      onStats: vi.fn(),
      getQuotaRows: () => rows,
    });
    rows = [{
      provider: 'codex-spark',
      window: '7d',
      remainingPct: 100,
      expectedRemainingPct: 0,
      label: 'codex-spark 7d 100%',
    }];
    rebuildMenu();
    const quota = menuItems.find((item) => item.label === '额度');
    expect(quota!.submenu).toHaveLength(1);
    expect(quota!.submenu![0].icon).toBeDefined();
    expect(tray.setImage).not.toHaveBeenCalled();
  });

  it('does not include a Demo entry', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    expect(findMenuItem(menuItems, 'Demo')).toBeUndefined();
  });

  it('includes entity visibility toggle entries in entities submenu', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    const houseVisible = findMenuItem(menuItems, '房屋');
    const workersVisible = findMenuItem(menuItems, '工人');
    const taskgraphsVisible = findMenuItem(menuItems, '图纸燕');
    expect(houseVisible).toBeDefined();
    expect(houseVisible!.type).toBe('checkbox');
    expect(workersVisible).toBeDefined();
    expect(workersVisible!.type).toBe('checkbox');
    expect(taskgraphsVisible).toBeDefined();
    expect(taskgraphsVisible!.type).toBe('checkbox');
  });

  it('reflects and updates taskgraph entity visibility', async () => {
    const setTaskgraphsVisible = vi.fn();
    const { createTray } = await import('../src/main/tray');
    createTray({
      onSettings: vi.fn(),
      onStats: vi.fn(),
      entities: {
        getVisibility: () => ({ house: true, workers: true, taskgraphs: false }),
        setHouseVisible: vi.fn(),
        setWorkersVisible: vi.fn(),
        setTaskgraphsVisible,
      },
    });

    const taskgraphsVisible = findMenuItem(menuItems, '图纸燕');
    expect(taskgraphsVisible?.checked).toBe(false);
    taskgraphsVisible!.click!({ ...taskgraphsVisible!, checked: true });
    expect(setTaskgraphsVisible).toHaveBeenCalledWith(true);
  });

  it('includes display submenu with radio entries', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    const display = menuItems.find((item) => item.label === '显示器');
    expect(display).toBeDefined();
    expect(display!.submenu).toBeDefined();
    expect(display!.submenu!.length).toBeGreaterThan(0);
    expect(display!.submenu!.every((item) => item.type === 'radio')).toBe(true);
  });

  it('places Settings then Restart immediately before Quit', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    const labels = menuItems.map((item) => item.label ?? item.type);
    expect(labels).toEqual(['实体', '统计', '额度', '显示器', 'separator', '设置', '重启', '退出']);
  });

  it('includes Restart entry that invokes the correct callback', async () => {
    const onRestart = vi.fn();
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn(), onRestart });
    const restart = findMenuItem(menuItems, '重启');
    expect(restart).toBeDefined();
    restart!.click!();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('includes a Quit entry that calls app.quit', async () => {
    const { createTray } = await import('../src/main/tray');
    createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    const quit = findMenuItem(menuItems, '退出');
    expect(quit).toBeDefined();
    const { app } = await import('electron');
    quit!.click!();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('createTray returns a tray property that is a Tray instance', async () => {
    const { createTray } = await import('../src/main/tray');
    const result = createTray({ onSettings: vi.fn(), onStats: vi.fn() });
    const { Tray } = await import('electron');
    expect(result.tray).toBeInstanceOf(Tray);
  });
});
