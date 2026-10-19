import { SHELL_CHANNELS } from '../../../shell-contract.js';
import type { ShellWindowController } from '../../../shell-window.js';
import type { AppNotification, NotificationChannelSink } from '../notifier.js';

export interface InAppChannelDeps {
  getShellWindow(): ShellWindowController | null;
}

/** In-app channel: push a transient toast to the shell renderer only. */
export function createInAppChannel(deps: InAppChannelDeps): NotificationChannelSink {
  return {
    show(notification: AppNotification): void {
      const shell = deps.getShellWindow();
      if (shell === null || shell.window.isDestroyed()) return;
      shell.window.webContents.send(SHELL_CHANNELS.notificationShow, notification);
    },
  };
}
