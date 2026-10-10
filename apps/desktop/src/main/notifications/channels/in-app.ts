import { SHELL_CHANNELS } from '../../../shell-contract.js';
import type { ShellWindowController } from '../../../shell-window.js';
import { NotificationCenter, type NotificationSnapshot } from '../center.js';
import type { AppNotification, NotificationChannelSink } from '../notifier.js';

/** The in-app channel surface: the notifier sink plus the renderer operations. */
export interface InAppChannel extends NotificationChannelSink {
  /** The renderer-facing snapshot of the in-app history. */
  snapshot(): NotificationSnapshot;
  /** Remove the history entry with this id. */
  remove(id: string): void;
  /** Remove every history entry. */
  clear(): void;
  markAllRead(): void;
}

export interface InAppChannelDeps {
  getShellWindow(): ShellWindowController | null;
}

export function createInAppChannel(deps: InAppChannelDeps): InAppChannel {
  const send = (channel: string, payload?: unknown): void => {
    const shell = deps.getShellWindow();
    if (shell === null || shell.window.isDestroyed()) return;
    shell.window.webContents.send(channel, payload);
  };
  // The center's one change callback: every mutation pushes the payload-free
  // changed signal so the renderer panel query invalidates.
  const center = new NotificationCenter({
    onChange: () => send(SHELL_CHANNELS.notificationsChanged),
  });
  return {
    show(notification: AppNotification): void {
      center.add(notification);
      send(SHELL_CHANNELS.notificationShow, notification);
    },
    snapshot: () => center.snapshot(),
    remove: (id: string) => center.remove(id),
    clear: () => center.clear(),
    markAllRead: () => center.markAllRead(),
  };
}
