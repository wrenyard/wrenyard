/**
 * Open state of the app-level activity side panel. The panel lives in the
 * shell (`app/ActivityPanel.tsx`) while its openers — the status-bar item,
 * the transcript task chip and the `activity.toggle` command — are spread
 * across lower layers, so the state is a small store here like the quota
 * panel's: one open flag, the session scope a chip requested, the selected
 * tab, and a one-shot provider scroll target for the 额度 section.
 */
import { useSyncExternalStore } from 'react';

/** The side panel's selectable tabs. */
export type ActivityPanelTab = 'activity' | 'usage';

interface ActivityPanelState {
  open: boolean;
  /**
   * Session the last opener asked to scope the list to (`''` when the opener
   * had no session, e.g. the status bar item or the command). The panel
   * defaults its 本会话/全部 toggle from this on open.
   */
  scopeSession: string;
  /** The tab the panel shows; the last selected tab is persisted. */
  tab: ActivityPanelTab;
  /**
   * One-shot provider id the 额度 section scrolls to once after it appears.
   * Set by openers that ask for a specific provider (e.g. the quota ring);
   * cleared as soon as the panel consumes it.
   */
  provider?: string;
}

/** localStorage key holding the last selected tab, like the panel width key. */
const TAB_STORAGE_KEY = 'wrenyard.shell.activity-panel-tab';

/** Read the persisted tab; unknown or missing values fall back to 活动. */
function readStoredTab(): ActivityPanelTab {
  try {
    return window.localStorage.getItem(TAB_STORAGE_KEY) === 'usage' ? 'usage' : 'activity';
  } catch {
    return 'activity';
  }
}

/** Persist the tab so a reopen returns to it. */
function writeStoredTab(tab: ActivityPanelTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Storage unavailable: the tab simply is not remembered.
  }
}

let state: ActivityPanelState = { open: false, scopeSession: '', tab: readStoredTab() };
const listeners = new Set<() => void>();

function publish(next: ActivityPanelState): void {
  if (
    next.open === state.open
    && next.scopeSession === state.scopeSession
    && next.tab === state.tab
    && next.provider === state.provider
  ) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Optional extras every opener may pass alongside the session scope. */
export interface ActivityPanelOptions {
  /** Select a tab explicitly; omitting it keeps the remembered tab. */
  tab?: ActivityPanelTab;
  /** One-shot provider id the 额度 section scrolls to after opening. */
  provider?: string;
}

/** Open the panel, scoped to `sessionId` when given (the transcript chip). */
export function openActivityPanel(sessionId?: string, options: ActivityPanelOptions = {}): void {
  publish({
    open: true,
    scopeSession: sessionId ?? '',
    tab: options.tab ?? state.tab,
    provider: options.provider,
  });
}

export function closeActivityPanel(): void {
  publish({ open: false, scopeSession: '', tab: state.tab });
}

/** Toggle the panel; the scoped-open always keeps it open. */
export function toggleActivityPanel(sessionId?: string, options: ActivityPanelOptions = {}): void {
  if (state.open && sessionId === undefined && options.tab === undefined) {
    publish({ open: false, scopeSession: '', tab: state.tab });
  } else {
    openActivityPanel(sessionId, options);
  }
}

/** Switch the selected tab; persists the choice so a reopen returns to it. */
export function setActivityPanelTab(tab: ActivityPanelTab): void {
  writeStoredTab(tab);
  publish({ ...state, tab });
}

/** Read and clear the one-shot provider scroll target. */
export function consumeActivityPanelProvider(): string | undefined {
  const provider = state.provider;
  if (provider !== undefined) publish({ ...state, provider: undefined });
  return provider;
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
