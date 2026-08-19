import { Tray, Menu, app, screen, type MenuItemConstructorOptions } from 'electron';
import { displayMenuLabel } from './display-placement';
import { createQuotaMenuRowIcon } from './quota-menu-icon';
import { createTrayIcon } from './tray-icon';
import type { QuotaMenuRow } from './panel-view-model';

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
  /** Structured remaining-bar rows for the 额度 submenu. */
  getQuotaRows?: () => QuotaMenuRow[];
}

export function createTray(callbacks: TrayCallbacks = {}): { tray: Tray; rebuildMenu: () => void } {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('Wrenyard Pet');

  const rebuildMenu = () => {
    const quotaRows = callbacks.getQuotaRows?.() ?? [];
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

    const quotaSubmenu: MenuItemConstructorOptions[] = quotaRows.length > 0
      ? quotaRows.map((row) => ({
          label: '\u200B',
          icon: createQuotaMenuRowIcon(row),
          enabled: false,
        }))
      : [{ label: '暂无额度', enabled: false }];

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
        label: '统计',
        click: () => callbacks?.onStats?.(),
      },
      {
        label: '额度',
        submenu: quotaSubmenu,
      },
      {
        label: '显示器',
        submenu: displaySubmenu,
        enabled: displaySubmenu.length > 0,
      },
      { type: 'separator' },
      {
        label: '设置',
        click: () => callbacks?.onSettings?.(),
      },
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
