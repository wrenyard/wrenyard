/** The only renderer module that reads the typed preload shell facade. */
import { useSyncExternalStore } from 'react';
import type { ResolvedAppearance, NotificationCommandAction, ShellPage, WindowStateSnapshot, WrenyardShellApi } from '@/shell-contract';

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

export function onNotificationsChanged(listener: () => void): () => void {
  return shell.onNotificationsChanged(listener);
}

export function onCommandAction(listener: (action: NotificationCommandAction) => void): () => void {
  return shell.onCommandAction(listener);
}

export function onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void {
  return shell.onWindowStateChanged(listener);
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
