import type { MenuItemConstructorOptions } from 'electron';

export function desktopMenuTemplate(
  platform: NodeJS.Platform,
  checkForUpdates: () => void,
): MenuItemConstructorOptions[] {
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
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
