/**
 * Open state of the app-level activity side panel. The panel lives in the
 * shell (`app/ActivityPanel.tsx`) while its openers — the title-bar toggle,
 * the transcript task chip and the `activity.toggle` command — are spread
 * across lower layers, so the state is a small store here: one open flag and
 * the session a chip asked to focus when opening.
 */
import { useSyncExternalStore } from 'react';

interface ActivityPanelState {
  open: boolean;
  /**
   * Session the last opener asked to focus (`''` when the opener had no
   * session, e.g. the title bar or the command). Retained for AppShell
   * compatibility; the panel list is not filtered by this value.
   */
  scopeSession: string;
  /** Monotonic counter bumped on every `openActivityPanel` call. */
  openRequestId: number;
}

let state: ActivityPanelState = { open: false, scopeSession: '', openRequestId: 0 };
const listeners = new Set<() => void>();

function publish(next: ActivityPanelState): void {
  if (
    next.open === state.open &&
    next.scopeSession === state.scopeSession &&
    next.openRequestId === state.openRequestId
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

/** Open the panel; optional `sessionId` sets the focus target for this open. */
export function openActivityPanel(sessionId?: string): void {
  publish({
    open: true,
    scopeSession: sessionId ?? '',
    openRequestId: state.openRequestId + 1,
  });
}

export function closeActivityPanel(): void {
  publish({ open: false, scopeSession: '', openRequestId: state.openRequestId });
}

/** Toggle the panel; the scoped-open always keeps it open. */
export function toggleActivityPanel(sessionId?: string): void {
  if (state.open && sessionId === undefined) {
    publish({ open: false, scopeSession: '', openRequestId: state.openRequestId });
  } else {
    openActivityPanel(sessionId);
  }
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
