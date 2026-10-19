/**
 * Open state of the app-level activity side panel. The panel lives in the
 * shell (`app/ActivityPanel.tsx`) while its openers — the status-bar item,
 * the transcript task chip and the `activity.toggle` command — are spread
 * across lower layers, so the state is a small store here like the quota
 * panel's: one open flag plus the session scope a chip requested.
 */
import { useSyncExternalStore } from 'react';

interface ActivityPanelState {
  open: boolean;
  /**
   * Session the last opener asked to scope the list to (`''` when the opener
   * had no session, e.g. the status bar item or the command). The panel
   * defaults its 本会话/全部 toggle from this on open.
   */
  scopeSession: string;
}

let state: ActivityPanelState = { open: false, scopeSession: '' };
const listeners = new Set<() => void>();

function publish(next: ActivityPanelState): void {
  if (next.open === state.open && next.scopeSession === state.scopeSession) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Open the panel, scoped to `sessionId` when given (the transcript chip). */
export function openActivityPanel(sessionId?: string): void {
  publish({ open: true, scopeSession: sessionId ?? '' });
}

export function closeActivityPanel(): void {
  publish({ open: false, scopeSession: '' });
}

/** Toggle the panel; the scoped-open always keeps it open. */
export function toggleActivityPanel(sessionId?: string): void {
  if (state.open && sessionId === undefined) publish({ open: false, scopeSession: '' });
  else openActivityPanel(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): ActivityPanelState {
  return state;
}

export function useActivityPanelState(): ActivityPanelState {
  return useSyncExternalStore(subscribe, getState, getState);
}
