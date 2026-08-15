import { describe, expect, it, vi } from 'vitest';

interface MockMenuItem {
  label: string;
  click?: () => void;
  submenu?: MockMenuItem[];
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
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
    const settings = findMenuItem(menuItems, 'Setting…');
    expect(settings).toBeDefined();
    settings!.click!();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('includes Stats entry that invokes the correct callback', async () => {
    const onStats = vi.fn();
    const { createTray } = await import('../src/main/tray');
    createTray({ onStats, onSettings: vi.fn() });
    const stats = findMenuItem(menuItems, 'Stats…');
    expect(stats).toBeDefined();
    stats!.click!();
    expect(onStats).toHaveBeenCalledTimes(1);
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
    expect(houseVisible).toBeDefined();
    expect(houseVisible!.type).toBe('checkbox');
    expect(workersVisible).toBeDefined();
    expect(workersVisible!.type).toBe('checkbox');
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
