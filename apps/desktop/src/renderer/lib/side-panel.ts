import { useSyncExternalStore } from 'react';

export type SidePanelViewId = 'tasks';

interface SidePanelState {
  view: SidePanelViewId | null;
  focusSession: string;
  openRequestId: number;
}

let state: SidePanelState = { view: null, focusSession: '', openRequestId: 0 };
const listeners = new Set<() => void>();

function publish(next: SidePanelState): void {
  if (
    next.view === state.view &&
    next.focusSession === state.focusSession &&
    next.openRequestId === state.openRequestId
  ) return;
  state = next;
  for (const listener of listeners) listener();
}

export function openSidePanel(view: SidePanelViewId, options?: { sessionId?: string }): void {
  publish({
    view,
    focusSession: options?.sessionId ?? '',
    openRequestId: state.openRequestId + 1,
  });
}

export function toggleSidePanel(view: SidePanelViewId, options?: { sessionId?: string }): void {
  if (state.view === view && options?.sessionId === undefined) {
    closeSidePanel();
  } else {
    openSidePanel(view, options);
  }
}

export function closeSidePanel(): void {
  publish({ view: null, focusSession: '', openRequestId: state.openRequestId });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): SidePanelState {
  return state;
}

export function useSidePanelState(): SidePanelState {
  return useSyncExternalStore(subscribe, getState, getState);
}
