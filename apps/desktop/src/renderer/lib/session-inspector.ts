/**
 * Open state of the session-page usage inspector. The panel lives on the
 * session page while its openers — the title-bar toggle, the composer quota
 * ring and the `quota.showPanel` command — are spread across the shell, so
 * the state is a small external store like the activity panel's: one open flag.
 */
import { useSyncExternalStore } from 'react';

interface SessionInspectorState {
  open: boolean;
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
  if (next.open === state.open) return;
  writeStoredOpen(next.open);
  state = next;
  for (const listener of listeners) listener();
}

/** Open the inspector rail. */
export function openSessionInspector(): void {
  publish({ open: true });
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
