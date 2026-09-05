import {
  Menu,
  Tray,
  app,
  screen,
  type MenuItemConstructorOptions,
} from 'electron';
import type { AppConfig, EntityVisibilityConfig } from '@wrenyard/pet/config';
import { createDesktopTrayIcon } from './tray-icon.js';
import { createQuotaMenuProviderIcon } from './quota-menu-icon.js';
import type { QuotaSnapshot } from './shell-contract.js';

export interface DesktopTrayOptions {
  getPetConfig(): AppConfig;
  setPetEnabled(enabled: boolean): Promise<void>;
  setPetEntityVisibility(key: keyof EntityVisibilityConfig, visible: boolean): Promise<void>;
  selectPetDisplay(displayId: number): Promise<void>;
  restartPet(): Promise<void>;
  openDesktop(): void;
  getQuotaSnapshot(): QuotaSnapshot;
}

export interface DesktopTrayHandle {
  tray: Tray;
  rebuild(): void;
  destroy(): void;
}

export function createDesktopTray(options: DesktopTrayOptions): DesktopTrayHandle {
  const tray = new Tray(createDesktopTrayIcon());
  tray.setToolTip('啾啾工坊');
  tray.on('click', () => options.openDesktop());

  const run = (operation: () => Promise<void>): void => {
    void operation()
      .then(() => rebuild())
      .catch((error: unknown) => console.warn('[wrenyard-desktop] tray action failed:', error));
  };

  const rebuild = (): void => {
    const config = options.getPetConfig();
    const displays = screen.getAllDisplays();
    const displayItems: MenuItemConstructorOptions[] = displays.map((display, index) => ({
      label: `显示器 ${index + 1}${display.id === screen.getPrimaryDisplay().id ? '（主显示器）' : ''}`,
      type: 'radio',
      checked: config.house.displayId === display.id
        || (config.house.displayId === undefined && display.id === screen.getPrimaryDisplay().id),
      click: () => run(() => options.selectPetDisplay(display.id)),
    }));
    const quota = options.getQuotaSnapshot();
    const quotaItems: MenuItemConstructorOptions[] = quota.providers.length > 0
      ? quota.providers.map((provider) => {
          const icon = createQuotaMenuProviderIcon(provider);
          return icon.isEmpty()
            ? { label: provider.displayLine ?? `${provider.id} · ${provider.message ?? provider.status}`, enabled: false }
            : { label: '\u200B', icon, enabled: false };
        })
      : [{ label: quota.status === 'available' ? '暂无可展示额度' : '额度暂不可用', enabled: false }];

    const contextMenu = Menu.buildFromTemplate([
      { label: '打开', click: options.openDesktop },
      { type: 'separator' },
      {
        label: '桌宠',
        submenu: [
          {
            label: '启用',
            type: 'checkbox',
            checked: config.enabled,
            click: (item) => run(() => options.setPetEnabled(item.checked)),
          },
          { type: 'separator' },
          {
            label: '显示器',
            submenu: displayItems,
            enabled: displayItems.length > 0,
          },
          {
            label: '显示内容',
            submenu: [
              entityItem('房屋', 'house', config.entities, options, run),
              entityItem('工人', 'workers', config.entities, options, run),
              entityItem('图纸燕', 'taskgraphs', config.entities, options, run),
            ],
          },
          { type: 'separator' },
          {
            label: '重新载入',
            enabled: config.enabled,
            click: () => run(options.restartPet),
          },
        ],
      },
      { label: '额度', submenu: quotaItems },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    tray.setContextMenu(contextMenu);
  };

  rebuild();
  return {
    tray,
    rebuild,
    destroy: () => tray.destroy(),
  };
}

function entityItem(
  label: string,
  key: keyof EntityVisibilityConfig,
  visibility: EntityVisibilityConfig,
  options: DesktopTrayOptions,
  run: (operation: () => Promise<void>) => void,
): MenuItemConstructorOptions {
  return {
    label,
    type: 'checkbox',
    checked: visibility[key],
    click: (item) => run(() => options.setPetEntityVisibility(key, item.checked)),
  };
}
