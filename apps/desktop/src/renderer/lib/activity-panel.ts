/**
 * Open state of the app-level activity side panel. The panel lives in the
 * shell (`app/ActivityPanel.tsx`) while its openers — the title-bar toggle,
 * the transcript task chip and the `activity.toggle` command — are spread
 * across lower layers, so the state is a small store here.
 */
import { useSyncExternalStore } from 'react';
import { setQuotaFocus } from '@/renderer/lib/quota-focus';

export type ActivityPanelTab = 'activity' | 'usage';

interface ActivityPanelState {
  open: boolean;
  /**
   * Session the last opener asked to scope the list to (`''` when the opener
   * had no session, e.g. the title bar or the command). The panel
   * defaults its 本会话/全部 toggle from this on open.
   */
  scopeSession: string;
  /** Last selected tab; remembered while the panel is closed. */
  tab: ActivityPanelTab;
}

let state: ActivityPanelState = { open: false, scopeSession: '', tab: 'activity' };
const listeners = new Set<() => void>();

function publish(next: ActivityPanelState): void {
  if (next.open === state.open && next.scopeSession === state.scopeSession && next.tab === state.tab) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Open the panel, scoped to `sessionId` when given (the transcript chip). */
export function openActivityPanel(sessionId?: string, tab?: ActivityPanelTab): void {
  publish({
    open: true,
    scopeSession: sessionId ?? '',
    tab: tab ?? state.tab,
  });
}

export function closeActivityPanel(): void {
  publish({ open: false, scopeSession: '', tab: state.tab });
}

/** Toggle the panel; the scoped-open always keeps it open on the current tab. */
export function toggleActivityPanel(sessionId?: string): void {
  if (state.open && sessionId === undefined) publish({ open: false, scopeSession: '', tab: state.tab });
  else openActivityPanel(sessionId);
}

/** Open the side panel on the 用量 tab, optionally focusing one quota provider. */
export function openUsagePanel(providerId?: string): void {
  if (providerId !== undefined) setQuotaFocus(providerId);
  publish({ open: true, scopeSession: state.scopeSession, tab: 'usage' });
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
