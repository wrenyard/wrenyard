/** The only renderer module that reads the typed preload shell facade. */
import { useSyncExternalStore } from 'react';
import type { ActivityStatusSnapshot, AppNotification, DesktopPreferences, ResolvedAppearance, NotificationCommandAction, RemoteConnectionSnapshot, ShellPage, WindowStateSnapshot, WrenyardShellApi, BotMethod, BotMethodMap, TodoMethod, TodoMethodMap } from '@/shell-contract';

declare global {
  interface Window {
    wrenyardShell: WrenyardShellApi;
  }
}

export const shell: WrenyardShellApi = window.wrenyardShell;

/** Copy through the native bridge, falling back to the browser clipboard. */
export async function copyText(text: string): Promise<void> {
  if (shell && typeof shell.copyText === 'function') {
    try {
      await shell.copyText(text);
      return;
    } catch {
      // Fall through to the browser clipboard when the bridge rejects.
    }
  }
  await navigator.clipboard.writeText(text);
}

/* ------------------------------------------------------------------ */
/* Bot mode bridge                                                     */
/* ------------------------------------------------------------------ */

/**
 * Forward one allowlisted `bot.*` call through the shell bridge. The main
 * process rejects any method outside `BOT_METHODS`, and the daemon accepts
 * `bot.*` only over local IPC, so every renderer bot read and write goes
 * through this typed facade instead of the preload object directly.
 */
export function botRequest<M extends BotMethod>(
  method: M,
  params?: BotMethodMap[M]['params'],
): Promise<BotMethodMap[M]['result']> {
  return shell.bot(method, params);
}

/* ------------------------------------------------------------------ */
/* Workspace todo bridge                                               */
/* ------------------------------------------------------------------ */

/**
 * Forward one allowlisted `todo.*` call through the shell bridge. The main
 * process rejects any method outside `TODO_METHODS`, and the daemon addresses
 * todos only inside the configured workspace, so every renderer todo read and
 * write goes through this typed facade instead of the preload object directly.
 */
export function todoRequest<M extends TodoMethod>(
  method: M,
  params?: TodoMethodMap[M]['params'],
): Promise<TodoMethodMap[M]['result']> {
  return shell.todo(method, params);
}

/* ------------------------------------------------------------------ */
/* Bridge subscriptions                                                */
/* ------------------------------------------------------------------ */

export function onQuotaChanged(listener: () => void): () => void {
  return shell.onQuotaChanged(listener);
}

export function onUpdateChanged(listener: () => void): () => void {
  return shell.onUpdateChanged(listener);
}

export function onDaemonChanged(listener: () => void): () => void {
  return shell.onDaemonChanged(listener);
}

export function onViewChanged(listener: (page: ShellPage) => void): () => void {
  return shell.onViewChanged(listener);
}

export function onAppearanceChanged(listener: (appearance: ResolvedAppearance) => void): () => void {
  return shell.onAppearanceChanged(listener);
}

export function onNotificationShow(listener: (notification: AppNotification) => void): () => void {
  return shell.onNotificationShow(listener);
}

export function onNotificationsChanged(listener: () => void): () => void {
  return shell.onNotificationsChanged(listener);
}

export function onCommandAction(listener: (action: NotificationCommandAction) => void): () => void {
  return shell.onCommandAction(listener);
}

export function onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void {
  return shell.onWindowStateChanged(listener);
}

export function onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void {
  return shell.onPreferencesChanged(listener);
}

export function onActivityChanged(listener: (snapshot: ActivityStatusSnapshot) => void): () => void {
  return shell.onActivityChanged(listener);
}

/**
 * The committed remote-connection state changed: every endpoint-bound view must
 * reset together (the app query client invalidates on this push).
 */
export function onRemoteChanged(listener: (snapshot: RemoteConnectionSnapshot) => void): () => void {
  return shell.onRemoteChanged(listener);
}

/* ------------------------------------------------------------------ */
/* Remote connection (WY Remote)                                       */
/* ------------------------------------------------------------------ */

// The committed remote-connection snapshot, kept in one module-level store so
// the renderer subscribes to the bridge exactly once. Every push carries the
// connection generation, so a subscriber can key its own reset on the committed
// generation and drop a late async delivery from a superseded switch.
const DEFAULT_REMOTE_CONNECTION: RemoteConnectionSnapshot = { state: 'local', generation: 0, host: null };
let remoteConnection: RemoteConnectionSnapshot = DEFAULT_REMOTE_CONNECTION;
const remoteConnectionListeners = new Set<() => void>();

function sameRemoteConnection(a: RemoteConnectionSnapshot, b: RemoteConnectionSnapshot): boolean {
  return a.state === b.state
    && a.generation === b.generation
    && a.message === b.message
    && (a.host?.alias ?? null) === (b.host?.alias ?? null);
}

function publishRemoteConnection(snapshot: RemoteConnectionSnapshot): void {
  // Ignore a snapshot that is not newer than the committed one: a stale async
  // read resolving after a push must never roll the context boundary back.
  if (snapshot.generation < remoteConnection.generation) return;
  if (sameRemoteConnection(snapshot, remoteConnection)) return;
  remoteConnection = snapshot;
  for (const listener of remoteConnectionListeners) listener();
}

// Subscribe once at module load so the very first push is never missed; the
// initial async read fills the store if no push has arrived yet.
shell.onRemoteChanged(publishRemoteConnection);
void shell.getRemoteConnection().then(publishRemoteConnection).catch(() => undefined);

function subscribeRemoteConnection(listener: () => void): () => void {
  remoteConnectionListeners.add(listener);
  return () => {
    remoteConnectionListeners.delete(listener);
  };
}

function getRemoteConnectionSnapshot(): RemoteConnectionSnapshot {
  return remoteConnection;
}

/** Latest committed remote-connection snapshot (generation-keyed). */
export function useRemoteConnection(): RemoteConnectionSnapshot {
  return useSyncExternalStore(subscribeRemoteConnection, getRemoteConnectionSnapshot, getRemoteConnectionSnapshot);
}

/* ------------------------------------------------------------------ */
/* Shared activity status                                              */
/* ------------------------------------------------------------------ */

// The main process pushes a fresh projection only when its content changes.
// Cache the latest round at module load and read it through a store so the
// status bar renders the current task/graph activity without its own poller.
const EMPTY_ACTIVITY: ActivityStatusSnapshot = { sampledAt: '', stale: false, tasks: [], taskgraphs: [] };
let activityStatus: ActivityStatusSnapshot | null = null;
const activityListeners = new Set<() => void>();

function publishActivityStatus(snapshot: ActivityStatusSnapshot): void {
  activityStatus = snapshot;
  for (const listener of activityListeners) listener();
}

shell.onActivityChanged(publishActivityStatus);
void shell.getActivityStatus().then(publishActivityStatus).catch(() => undefined);

function subscribeActivityStatus(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

function getActivityStatusSnapshot(): ActivityStatusSnapshot {
  return activityStatus ?? EMPTY_ACTIVITY;
}

/** Latest shared activity round; empty until the first push/read resolves. */
export function useActivityStatus(): ActivityStatusSnapshot {
  return useSyncExternalStore(subscribeActivityStatus, getActivityStatusSnapshot, getActivityStatusSnapshot);
}

/* ------------------------------------------------------------------ */
/* Shell page navigation                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_SHELL_PAGE: ShellPage = 'session';
let shellPage: ShellPage = DEFAULT_SHELL_PAGE;
const pageListeners = new Set<() => void>();

function publishShellPage(page: ShellPage): void {
  if (page === shellPage) return;
  shellPage = page;
  for (const listener of pageListeners) listener();
}

// Register the push subscription at module load so the very first
// `view-changed` event from the main process is never missed.
shell.onViewChanged(publishShellPage);

function subscribeShellPage(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
}

function getShellPage(): ShellPage {
  return shellPage;
}

/** Current shell page, kept in sync by the bridge `view-changed` push. */
export function useShellPage(): ShellPage {
  return useSyncExternalStore(subscribeShellPage, getShellPage, getShellPage);
}
