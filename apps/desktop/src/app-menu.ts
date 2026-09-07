import type { MenuItemConstructorOptions } from 'electron';
import type { QuitOrigin } from './desktop-interaction-policy.js';

export function desktopMenuTemplate(
  platform: NodeJS.Platform,
  checkForUpdates: () => void,
  requestQuit: (origin: QuitOrigin) => void = () => undefined,
): MenuItemConstructorOptions[] {
  const quitItem: MenuItemConstructorOptions = {
    label: '退出啾啾工坊',
    accelerator: 'CmdOrCtrl+Q',
    click: (_menuItem, _browserWindow, event) => {
      requestQuit(event.triggeredByAccelerator ? 'accelerator' : 'direct');
    },
  };

  return [
    ...(platform === 'darwin'
      ? [
          {
            role: 'appMenu' as const,
            label: '啾啾工坊',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              quitItem,
            ],
          },
          {
            label: '文件',
            submenu: [{ role: 'close' as const, label: '关闭窗口', accelerator: 'CmdOrCtrl+W' }],
          },
        ]
      : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: '检查更新…',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: checkForUpdates,
        },
      ],
    },
  ];
}
