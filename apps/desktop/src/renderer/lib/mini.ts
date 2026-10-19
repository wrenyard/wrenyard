/**
 * Renderer mini-card state. `mini` is fixed for a window by its `?mini=1`
 * query: the shell window is the full layout and every card is the compact
 * layout. The main process owns each card window; this module only tracks the
 * per-window 置顶 flag and forwards the card commands.
 */
import { useSyncExternalStore } from 'react';
import type { NotificationCommandAction } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';
import { flushDraft, flushDraftAttachments } from '@/renderer/pages/session/state/drafts';

const params = new URLSearchParams(window.location.search);

/** Whether this window is a mini card (fixed at load from the URL query). */
export const mini = params.get('mini') === '1';

/** The session a card was opened for; '' means a new draft. */
export const miniSession = params.get('session') ?? '';

let pinned = true;
const listeners = new Set<() => void>();

/** Toggle this card's always-on-top (置顶) switch; default on. */
export function setMiniPinned(next: boolean): void {
  if (next === pinned) return;
  pinned = next;
  for (const listener of listeners) listener();
  void shell.setAlwaysOnTop(next).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPinned(): boolean {
  return pinned;
}

/** Whether this window shows the compact mini-card layout. */
export function useMiniMode(): boolean {
  return mini;
}

/** Whether the mini card is pinned always-on-top (default on). */
export function useMiniPinned(): boolean {
  return useSyncExternalStore(subscribe, getPinned, getPinned);
}

/**
 * The session this window currently shows, published by the session page. The
 * shell title bar opens a card for it and a card returns to it.
 */
let currentSession = '';

export function setCurrentSession(sessionId: string): void {
  currentSession = sessionId;
}

export function getCurrentSession(): string {
  return currentSession;
}

/** Persist a session's composer draft before another window takes it over. */
function flushSessionDrafts(sessionId: string): void {
  const key = sessionId === '' ? 'draft' : sessionId;
  flushDraft(key);
  flushDraftAttachments(key);
}

/** Open a new mini card for a session ('' starts a new draft chat). */
export function openMiniCard(sessionId: string): void {
  flushSessionDrafts(sessionId);
  void shell.openMiniCard(sessionId).catch(() => undefined);
}

/** Close this card and bring the shell back, opened to `sessionId`. */
export function restoreMain(sessionId: string, command?: NotificationCommandAction): void {
  flushSessionDrafts(sessionId);
  void shell.restoreMain(sessionId, command).catch(() => undefined);
}

/** Close this card only; the shell returns when the last card closes. */
export function closeCard(): void {
  flushSessionDrafts(getCurrentSession());
  void shell.closeWindow().catch(() => undefined);
}
