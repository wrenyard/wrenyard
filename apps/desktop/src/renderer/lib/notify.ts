/**
 * Notification facade for the renderer. This is the only module allowed to
 * import `sonner`; pages and components call `toast` for transient feedback,
 * and the module itself renders the in-app notifications the main process
 * pushes.
 *
 * Every notification renders as a transient sonner toast that closes
 * automatically (error 6s, others 4s) and carries an X close button. Closing a
 * toast only hides it and never touches the notification history.
 */
import { toast as sonnerToast } from 'sonner';
import type { AppNotification, NotificationLevel } from '@/shell-contract';
import { onNotificationShow } from '@/renderer/lib/desktop';
import { executeCommand } from '@/renderer/lib/commands';
import { getVisibleSessionId } from '@/renderer/lib/visible-session';

const TRANSIENT_ERROR_MS = 6_000;
const TRANSIENT_OTHER_MS = 4_000;

/** Transient feedback: a toast only, never the notification history. */
export function toast(message: string, options?: { level?: NotificationLevel; durationMs?: number }): void {
  const level = options?.level ?? 'info';
  sonnerToast[level](message, {
    duration: options?.durationMs ?? (level === 'error' ? TRANSIENT_ERROR_MS : TRANSIENT_OTHER_MS),
    closeButton: true,
  });
}

function sessionIdFromNotification(notification: AppNotification): string | undefined {
  const prefix = 'session:';
  if (!notification.id.startsWith(prefix)) return undefined;
  return notification.id.slice(prefix.length);
}

function renderNotification(notification: AppNotification): void {
  const visibleSession = sessionIdFromNotification(notification);
  if (visibleSession !== undefined && visibleSession === getVisibleSessionId()) return;

  const description = notification.body !== undefined ? { description: notification.body } : {};
  const action = notification.action;
  const actionOption = action !== undefined
    ? { action: { label: action.label, onClick: () => executeCommand(action.command.id, action.command.args) } }
    : {};

  sonnerToast[notification.level](notification.title, {
    id: notification.id,
    duration: notification.level === 'error' ? TRANSIENT_ERROR_MS : TRANSIENT_OTHER_MS,
    closeButton: true,
    ...description,
    ...actionOption,
  });
}

onNotificationShow((notification) => renderNotification(notification));
