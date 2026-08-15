import { Tray, Menu, app, nativeImage, screen, type MenuItemConstructorOptions } from 'electron';
import { displayMenuLabel } from './display-placement';

export interface TrayCallbacks {
  entities?: {
    getVisibility: () => { house: boolean; workers: boolean };
    setHouseVisible: (visible: boolean) => void;
    setWorkersVisible: (visible: boolean) => void;
  };
  displays?: {
    getActiveDisplayId: () => number | undefined;
    onSelect: (displayId: number) => void;
  };
  onSettings?: () => void;
  onStats?: () => void;
}

// Generate a simple 16x16 hard-hat pixel icon as a PNG data URL
function createTrayIcon(): Electron.NativeImage {
  // 16x16 hard-hat (simplified)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4); // RGBA

  // Fill transparent
  for (let i = 0; i < size * size * 4; i += 4) {
    buf[i] = 0;     // R
    buf[i + 1] = 0; // G
    buf[i + 2] = 0; // B
    buf[i + 3] = 0; // A
  }

  // Simple yellow hard-hat shape
  const yellow = [0xFF, 0xCC, 0x00, 0xFF];
  const dark = [0xCC, 0x99, 0x00, 0xFF];

  function setPixel(x: number, y: number, color: number[]) {
    const i = (y * size + x) * 4;
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = color[3];
  }

  // Hat dome (rows 2-6, x=4..11)
  for (let y = 1; y <= 5; y++) {
    const left = 5 - y;
    const right = 10 + y;
    for (let x = left; x <= right; x++) {
      if (x >= 0 && x < size) setPixel(x, y, yellow);
    }
  }
  // Hat brim (rows 7-8, full width 2-13)
  for (let y = 6; y <= 7; y++) {
    for (let x = 2; x <= 13; x++) {
      setPixel(x, y, dark);
    }
  }
  // Ears (row 8, x=1 and x=14)
  setPixel(1, 7, dark);
  setPixel(14, 7, dark);
  // Head band accent
  for (let x = 4; x <= 11; x++) {
    setPixel(x, 5, dark);
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 2 });
}

export function createTray(callbacks: TrayCallbacks = {}): { tray: Tray; rebuildMenu: () => void } {
  const icon = createTrayIcon();
  const tray = new Tray(icon);
  tray.setToolTip('Foreman Pet');

  const rebuildMenu = () => {
    const displays = screen.getAllDisplays();
    const activeDisplayId = callbacks?.displays?.getActiveDisplayId();
    const visibility = callbacks.entities?.getVisibility() ?? { house: true, workers: true };
    const displaySubmenu: MenuItemConstructorOptions[] = displays.map((display, index) => ({
      label: displayMenuLabel(display, index),
      type: 'radio',
      checked: display.id === activeDisplayId,
      click: () => {
        callbacks?.displays?.onSelect(display.id);
        rebuildMenu();
      },
    }));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '实体',
        submenu: [
          {
            label: '房屋',
            type: 'checkbox',
            checked: visibility.house,
            click: (menuItem) => {
              callbacks.entities?.setHouseVisible(menuItem.checked);
              rebuildMenu();
            },
          },
          {
            label: '工人',
            type: 'checkbox',
            checked: visibility.workers,
            click: (menuItem) => {
              callbacks.entities?.setWorkersVisible(menuItem.checked);
              rebuildMenu();
            },
          },
        ],
      },
      {
        label: 'Setting…',
        click: () => callbacks?.onSettings?.(),
      },
      {
        label: 'Stats…',
        click: () => callbacks?.onStats?.(),
      },
      {
        label: '显示器',
        submenu: displaySubmenu,
        enabled: displaySubmenu.length > 0,
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
  };

  rebuildMenu();
  return { tray, rebuildMenu };
}
