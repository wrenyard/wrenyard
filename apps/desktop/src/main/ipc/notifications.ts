// Notification IPC: the renderer→main invokes that read and mutate the in-app
// notification history. The main→renderer show/changed pushes are emitted by
// the in-app channel, so no handler is registered for them here.

import type { IpcMain } from 'electron';
import { NOTIFICATION_ID_MAX, SHELL_CHANNELS } from '../../shell-contract.js';
import { isBoundedString } from './validation.js';
import type { ShellIpcDeps } from './deps.js';

export function registerNotificationsIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.notificationSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getNotificationSnapshot();
  });

  ipcMain.handle(SHELL_CHANNELS.notificationDismissEntry, async (event, id: unknown) => {
    assertShellSender(event.sender);
    // Any entry may be removed by id; the id must be a bounded string.
    if (!isBoundedString(id, NOTIFICATION_ID_MAX)) throw new Error('通知 id 无效');
    options.dismissNotification(id);
  });

  ipcMain.handle(SHELL_CHANNELS.notificationClear, async (event) => {
    assertShellSender(event.sender);
    options.clearNotifications();
  });

  ipcMain.handle(SHELL_CHANNELS.notificationMarkRead, async (event) => {
    assertShellSender(event.sender);
    options.markNotificationsRead();
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.notificationSnapshot);
    ipcMain.removeHandler(SHELL_CHANNELS.notificationDismissEntry);
    ipcMain.removeHandler(SHELL_CHANNELS.notificationClear);
    ipcMain.removeHandler(SHELL_CHANNELS.notificationMarkRead);
  };
}
