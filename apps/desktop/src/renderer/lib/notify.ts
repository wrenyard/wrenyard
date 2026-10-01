/**
 * Notification facade for the renderer. This is the only module allowed to
 * import `sonner`; pages and components call `toast` for transient feedback
 * and `notify` for events that also belong in the notification history.
 *
 * `toast` never enters the history. `notify` records the event in the main
 * process (the single history owner) and the resulting push is what surfaces
 * the toast, so a renderer event and a main-origin event follow one path and
 * do-not-disturb suppresses both consistently.
 */
import { toast as sonnerToast } from 'sonner';
import type {
  NotificationAction as ShellNotificationAction,
  NotificationInput,
  NotificationLevel,
  NotificationSource,
  ShellNotification,
} from '@/shell-contract';
import {
  shell,
  onNotificationsChanged,
} from '@/renderer/lib/desktop';

/** Reserved command id for a renderer-local notification callback. */
export const LOCAL_NOTIFICATION_ACTION_ID = 'notification.localAction';

export interface NotifyActionCallback {
  label: string;
  run: () => void;
}

export interface NotifyActionCommand {
  label: string;
  command: { id: string; args?: unknown };
}

export type NotifyAction = NotifyActionCallback | NotifyActionCommand;

export interface NotifyInput {
  /** Same id updates the existing notification instead of adding a new one. */
  id?: string;
  level: NotificationLevel;
  source: NotificationSource;
  title: string;
  description?: string;
  action?: NotifyAction;
}

/** Locally-held callbacks, addressed by a stable key instead of an IPC function. */
const localActions = new Map<string, () => void>();
let localSequence = 0;

/** Resolve a command action through the app command table; injected by the app layer. */
let actionRunner: (action: ShellNotificationAction) => void = () => {};

export function setNotificationActionRunner(runner: (action: ShellNotificationAction) => void): void {
  actionRunner = runner;
}

/** Run a callback registered by a prior `notify({ action: { run } })`. */
export function runLocalNotificationAction(args: unknown): void {
  const key = args !== null && typeof args === 'object' ? (args as { key?: unknown }).key : undefined;
  if (typeof key !== 'string') return;
  localActions.get(key)?.();
}

/** Transient feedback: a toast only, never history. */
export function toast(message: string, options?: { level?: NotificationLevel }): void {
  const level = options?.level ?? 'info';
  if (doNotDisturb && level !== 'error') return;
  sonnerToast[level](message, durationFor(level));
}

/** Event notification: toast plus history, with an optional single action. */
export function notify(input: NotifyInput): void {
  const payload: NotificationInput = {
    ...(input.id !== undefined ? { id: input.id } : {}),
    level: input.level,
    source: input.source,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  if (input.action) payload.action = serializeAction(input);
  void shell.notify(payload).catch(() => toast('通知保存失败', { level: 'error' }));
}

function serializeAction(input: NotifyInput): ShellNotificationAction {
  const action = input.action!;
  if ('run' in action) {
    const key = input.id ?? `local-${(localSequence += 1)}`;
    localActions.set(key, action.run);
    return {
      label: action.label,
      command: { id: LOCAL_NOTIFICATION_ACTION_ID, args: { key } },
    };
  }
  return action;
}

/* ------------------------------------------------------------------ */
/* Main-process push → toast                                           */
/* ------------------------------------------------------------------ */

let doNotDisturb = false;
let seeded = false;
const seen = new Map<string, string>();

function fingerprint(item: ShellNotification): string {
  return JSON.stringify([item.level, item.title, item.description, item.action]);
}

async function refresh(): Promise<void> {
  let snapshot;
  try {
    snapshot = await shell.getNotifications();
  } catch {
    return;
  }
  doNotDisturb = snapshot.doNotDisturb;
  if (!seeded) {
    // The first snapshot after load establishes the baseline; history from a
    // previous renderer session must not replay as a burst of toasts.
    seeded = true;
    for (const item of snapshot.items) seen.set(item.id, fingerprint(item));
    return;
  }
  for (const item of [...snapshot.items].reverse()) {
    const version = fingerprint(item);
    if (seen.get(item.id) === version) continue;
    seen.set(item.id, version);
    if (doNotDisturb && item.level !== 'error') continue;
    showNotificationToast(item);
  }
}

function showNotificationToast(item: ShellNotification): void {
  const action = item.action;
  sonnerToast[item.level](item.title, {
    id: item.id,
    ...durationFor(item.level),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(action !== undefined
      ? { action: { label: action.label, onClick: () => actionRunner(action) } }
      : {}),
  });
}

function durationFor(level: NotificationLevel): { duration: number } {
  if (level === 'error') return { duration: Number.POSITIVE_INFINITY };
  if (level === 'warning') return { duration: 6_000 };
  return { duration: 4_000 };
}

onNotificationsChanged(() => {
  void refresh();
});
void refresh();
