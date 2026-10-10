import type { Notification as ElectronNotification } from 'electron';
import type { ShellWindowController } from '../../../shell-window.js';
import type { AppNotification, NotificationChannelSink } from '../notifier.js';

export interface SystemChannelDeps {
  /** The Electron `Notification` constructor; injected for testability. */
  notificationConstructor: typeof ElectronNotification;
  isWindowFocused(): boolean;
  /** Raise/focus the main window; used by a native-notification click. */
  showDesktop(): void;
  getShellWindow(): ShellWindowController | null;
}

export function createSystemChannel(deps: SystemChannelDeps): NotificationChannelSink {
  return {
    show(notification: AppNotification): void {
      if (deps.isWindowFocused()) return;
      if (!deps.notificationConstructor.isSupported()) return;
      const native = new deps.notificationConstructor({
        title: notification.title,
        body: notification.body ?? '',
      });
      native.on('click', () => {
        deps.showDesktop();
        const command = notification.action?.command;
        if (command) deps.getShellWindow()?.deliverCommandAction(command);
      });
      native.show();
    },
  };
}
