// Notification IPC: snapshot, renderer-originated notify, dismiss, clear,
// mark-read, and the do-not-disturb toggle. Handler semantics are unchanged
// from the original inline registrations.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';
import { NOTIFICATION_ID_MAX, isBoundedString, validateNotificationInput } from './validation.js';

export function registerNotificationsIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.notificationsSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getNotifications();
  });
  ipcMain.handle(SHELL_CHANNELS.notificationNotify, async (event, input: unknown) => {
    assertShellSender(event.sender);
    return options.notify(validateNotificationInput(input));
  });
  ipcMain.handle(SHELL_CHANNELS.notificationDismiss, async (event, id: unknown) => {
    assertShellSender(event.sender);
    if (!isBoundedString(id, NOTIFICATION_ID_MAX)) throw new Error('通知 id 无效');
    return options.dismissNotification(id);
  });
  ipcMain.handle(SHELL_CHANNELS.notificationsClear, async (event) => {
    assertShellSender(event.sender);
    return options.clearNotifications();
  });
  ipcMain.handle(SHELL_CHANNELS.notificationsMarkRead, async (event) => {
    assertShellSender(event.sender);
    return options.markNotificationsRead();
  });
  ipcMain.handle(SHELL_CHANNELS.notificationsSetDoNotDisturb, async (event, value: unknown) => {
    assertShellSender(event.sender);
    if (typeof value !== 'boolean') throw new Error('勿扰参数无效');
    return options.setDoNotDisturb(value);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.notificationsSnapshot,
      SHELL_CHANNELS.notificationNotify,
      SHELL_CHANNELS.notificationDismiss,
      SHELL_CHANNELS.notificationsClear,
      SHELL_CHANNELS.notificationsMarkRead,
      SHELL_CHANNELS.notificationsSetDoNotDisturb,
    ]) ipcMain.removeHandler(channel);
  };
}
