import type { MenuItemConstructorOptions } from 'electron';
import type { QuitOrigin } from './desktop-interaction-policy.js';

/**
 * Persisted interface-zoom actions replacing the Electron zoom roles, so the
 * View menu and `appearance.zoom` share one value. Accelerators mirror the
 * roles they replace and the read-only shortcut table.
 */
export interface DesktopMenuZoomActions {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

export function desktopMenuTemplate(
  platform: NodeJS.Platform,
  checkForUpdates: () => void,
  requestQuit: (origin: QuitOrigin) => void = () => undefined,
  zoom?: DesktopMenuZoomActions,
): MenuItemConstructorOptions[] {
  const quitItem: MenuItemConstructorOptions = {
    label: '退出啾啾工坊',
    accelerator: 'CmdOrCtrl+Q',
    click: (_menuItem, _browserWindow, event) => {
      requestQuit(event.triggeredByAccelerator ? 'accelerator' : 'direct');
    },
  };

  const viewItems: MenuItemConstructorOptions[] = zoom === undefined
    ? [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
    : [
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: zoom.reset },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: zoom.zoomIn },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: zoom.zoomOut },
      ];

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
    {
      label: 'View',
      submenu: [
        ...viewItems,
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
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
