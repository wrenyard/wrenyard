/**
 * Open state of the session-page usage inspector. The panel lives on the
 * session page while its openers — the title-bar toggle, the composer quota
 * ring and the `quota.showPanel` command — are spread across the shell, so
 * the state is a small external store like the activity panel's: one open flag
 * and a one-shot provider scroll target for the quota section.
 */
import { useSyncExternalStore } from 'react';

interface SessionInspectorState {
  open: boolean;
  /**
   * One-shot provider id the quota section scrolls to once after it appears.
   * Set by openers that ask for a specific provider (e.g. the quota ring);
   * cleared as soon as the panel consumes it.
   */
  provider?: string;
}

/** localStorage key holding whether the inspector was left open. */
const OPEN_STORAGE_KEY = 'wrenyard.session-inspector.open';

/** Read the persisted open flag; missing or invalid values default to closed. */
function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persist open so a reload returns to the same visibility. */
function writeStoredOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    // Storage unavailable: the open state simply is not remembered.
  }
}

let state: SessionInspectorState = { open: readStoredOpen() };
const listeners = new Set<() => void>();

function publish(next: SessionInspectorState): void {
  if (next.open === state.open && next.provider === state.provider) return;
  if (next.open !== state.open) writeStoredOpen(next.open);
  state = next;
  for (const listener of listeners) listener();
}

/** Open the inspector, optionally scrolling to one provider once it mounts. */
export function openSessionInspector(provider?: string): void {
  publish({
    open: true,
    ...(provider !== undefined ? { provider } : {}),
  });
}

export function closeSessionInspector(): void {
  publish({ open: false });
}

export function toggleSessionInspector(): void {
  if (state.open) {
    closeSessionInspector();
  } else {
    openSessionInspector();
  }
}

/** Read and clear the one-shot provider scroll target. */
export function consumeSessionInspectorProvider(): string | undefined {
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

function getState(): SessionInspectorState {
  return state;
}

export function useSessionInspectorState(): SessionInspectorState {
  return useSyncExternalStore(subscribe, getState, getState);
}
