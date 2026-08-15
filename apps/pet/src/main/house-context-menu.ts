import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

interface MinimalLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface HouseContextMenuOptions {
  onRestart: () => void | Promise<unknown>;
  onOpenSettings: () => void;
  logger?: MinimalLogger;
}

export function attachHouseContextMenu(win: BrowserWindow, options: HouseContextMenuOptions): void {
  win.webContents.on('context-menu', (event, _params) => {
    event.preventDefault();

    const template: MenuItemConstructorOptions[] = [
      {
        label: '设置…',
        click: () => {
          options.onOpenSettings();
        },
      },
      { type: 'separator' },
      {
        label: '重启',
        click: () => {
          Promise.resolve(options.onRestart()).catch((err: unknown) => {
            const log = options.logger ?? console;
            log.warn('House restart callback rejected:', err);
          });
        },
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win });
  });
}
