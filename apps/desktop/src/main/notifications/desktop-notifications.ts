// ── Desktop notification glue ────────────────────────────────────────
// Main-origin notification producers: the event-preference gate shared by
// renderer- and main-originated events, the native OS notification for
// background-worthy events, and the update/daemon/Pet/task runners that push
// into the single notification center. Every dependency the original inline
// functions read from `main.ts` module scope is injected here, so this module
// owns no mutable state of its own.

import { Notification } from 'electron';
import type { NotificationCenter, NotificationInput, ShellNotification } from '../notification-center.js';
import type { DesktopSettingsStore } from '../settings/desktop-settings.js';
import type { DesktopUpdateController } from '../../updater/controller.js';
import type { ShellWindowController } from '../../shell-window.js';
import type { DaemonLifecycleSnapshot } from '../../shell-contract.js';
import type { VanishedTaskRun } from '../activity-status.js';

export interface DesktopNotificationsDeps {
  getNotificationCenter(): NotificationCenter | null;
  /** Live settings store, mirrored for notification preference reads. */
  getSettingsStore(): DesktopSettingsStore | null;
  getShellWindow(): ShellWindowController | null;
  getUpdateController(): DesktopUpdateController | null;
  /** Raise/focus the main window; used by a native-notification click. */
  showDesktop(): void;
  /** Raw daemon transport, used to resolve an authoritative terminal run status. */
  requestForeman(method: string, params: unknown): Promise<unknown>;
  /** The Electron `Notification` constructor; injected for testability. */
  notificationConstructor: typeof Notification;
}

export interface DesktopNotifications {
  isNotificationEventEnabled(input: NotificationInput): boolean;
  showSystemNotification(notification: ShellNotification): void;
  notifyUpdateAvailable(): void;
  notifyDaemonStateChanged(snapshot: DaemonLifecycleSnapshot): void;
  petNotificationSink(input: NotificationInput): void;
  notifyVanishedTaskRun(run: VanishedTaskRun): Promise<void>;
}

export function createDesktopNotifications(deps: DesktopNotificationsDeps): DesktopNotifications {
  /** Last observed daemon state; owned by this closure, never module scope. */
  let lastDaemonState: DaemonLifecycleSnapshot['state'] | undefined;

  /** Gate for `notifications.events`, shared by renderer- and main-origin events. */
  function isNotificationEventEnabled(input: NotificationInput): boolean {
    const store = deps.getSettingsStore();
    if (store === null) return true;
    const events = store.load().notifications.events;
    switch (input.source) {
      case 'task':
        return input.level === 'error' ? events.taskFailed : events.taskCompleted;
      case 'session':
        // Only the completed-reply success event is gated; session errors such as
        // context_overflow stay independent of the completion setting.
        return input.level === 'success' ? events.sessionReplyCompleted : true;
      case 'update':
        return events.updateAvailable;
      case 'quota':
        return events.quotaWarning;
      case 'daemon':
        return events.daemonDisconnected;
      default:
        return true;
    }
  }

  /**
   * OS notification for a background-worthy event. Clicking it focuses the main
   * window and delivers the event's command action to the renderer, which owns
   * the command table.
   */
  function showSystemNotification(notification: ShellNotification): void {
    if (!deps.notificationConstructor.isSupported()) return;
    const native = new deps.notificationConstructor({
      title: notification.title,
      body: notification.description ?? '',
      silent: !(deps.getSettingsStore()?.load().notifications.sound ?? true),
    });
    native.on('click', () => {
      deps.showDesktop();
      const command = notification.action?.command;
      if (command) deps.getShellWindow()?.deliverCommandAction(command);
    });
    native.show();
  }

  /** An available update feeds the notification center once per version. */
  function notifyUpdateAvailable(): void {
    const center = deps.getNotificationCenter();
    const store = deps.getSettingsStore();
    if (center === null || store === null) return;
    const snapshot = deps.getUpdateController()?.snapshot();
    if (!snapshot || snapshot.state !== 'available') return;
    if (!store.load().notifications.events.updateAvailable) return;
    center.push({
      id: 'update-available',
      level: 'info',
      source: 'update',
      title: '有可用更新',
      ...(snapshot.availableVersion !== undefined ? { description: `新版本 ${snapshot.availableVersion} 已可用` } : {}),
      action: { label: '查看', command: { id: 'settings.open', args: 'update' } },
    });
  }

  /** A daemon drop feeds the center; recovery clears the stale disconnect. */
  function notifyDaemonStateChanged(snapshot: DaemonLifecycleSnapshot): void {
    const previous = lastDaemonState;
    lastDaemonState = snapshot.state;
    const center = deps.getNotificationCenter();
    const store = deps.getSettingsStore();
    if (center === null || store === null) return;
    if (snapshot.state === 'running') {
      center.dismiss('daemon-disconnected');
      return;
    }
    if (previous !== 'running') return;
    if (!store.load().notifications.events.daemonDisconnected) return;
    center.push({
      id: 'daemon-disconnected',
      level: 'warning',
      source: 'daemon',
      title: 'Daemon 已断开',
      ...(snapshot.message !== undefined ? { description: snapshot.message } : {}),
    });
  }

  /** Preference gate for task events the Pet module reports. */
  function petNotificationSink(input: NotificationInput): void {
    const center = deps.getNotificationCenter();
    const store = deps.getSettingsStore();
    if (center === null || store === null) return;
    const events = store.load().notifications.events;
    const enabled = input.level === 'success'
      ? events.taskCompleted
      : input.level === 'error'
        ? events.taskFailed
        : true;
    if (!enabled) return;
    center.push(input);
  }

  /** Resolve and report the terminal fact for a task run that vanished. */
  async function notifyVanishedTaskRun(run: VanishedTaskRun): Promise<void> {
    const center = deps.getNotificationCenter();
    const store = deps.getSettingsStore();
    if (center === null || store === null) return;
    // Resolve the terminal fact from the authoritative run status; a run that
    // merely vanished is never reported as success or failure on its own.
    let status: string | null = null;
    try {
      const raw = await deps.requestForeman('task.run.status', { task_run_id: run.taskRunId });
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const value = (raw as { status?: unknown }).status;
        if (typeof value === 'string') status = value;
      }
    } catch {
      return;
    }
    if (status !== 'done' && status !== 'failed' && status !== 'interrupted') return;
    const events = store.load().notifications.events;
    if (status === 'done' ? !events.taskCompleted : !events.taskFailed) return;
    const label = run.taskLabel ?? run.taskRunId;
    center.push({
      id: `task-run:${run.taskRunId}`,
      level: status === 'done' ? 'success' : 'error',
      source: 'task',
      title: status === 'done' ? `任务完成：${label}` : `任务失败：${label}`,
      ...(run.project !== undefined ? { description: run.project } : {}),
      action: { label: '查看', command: { id: 'tasks.open', args: { taskRunId: run.taskRunId } } },
    });
  }

  return {
    isNotificationEventEnabled,
    showSystemNotification,
    notifyUpdateAvailable,
    notifyDaemonStateChanged,
    petNotificationSink,
    notifyVanishedTaskRun,
  };
}
