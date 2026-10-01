/**
 * Title bar slot registry shared by the shell chrome and the page header.
 *
 * The shell (`app/TitleBar.tsx`) renders one slot element per shell page and
 * registers it here; `components/page.tsx` portals the page header into the
 * slot that belongs to its own page. The registry lives in `lib/` so the lower
 * `components/` layer never imports `app/`. Slots stay in the DOM while a page
 * is hidden, so a hidden page's header keeps its state and simply is not shown.
 */
import { createContext, createElement, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ShellPage } from '@/shell-contract';
import { onWindowStateChanged, shell } from '@/renderer/lib/desktop';

/* ------------------------------------------------------------------ */
/* Platform and fullscreen document markers                            */
/* ------------------------------------------------------------------ */

// The title bar reserves platform-specific space for the window controls. A
// `data-platform` attribute lets the CSS tokens switch without React props.
if (typeof document !== 'undefined') {
  document.documentElement.dataset.platform = shell.platform;
  // Fullscreen is pushed by the main process; macOS releases the traffic-light
  // reserve while fullscreen. Start at false so the reserve is right on first paint.
  document.documentElement.dataset.fullscreen = 'false';
  onWindowStateChanged((state) => {
    document.documentElement.dataset.fullscreen = state.fullscreen ? 'true' : 'false';
  });
}

/* ------------------------------------------------------------------ */
/* Slot registry                                                       */
/* ------------------------------------------------------------------ */

export type TitleBarSlotKind = 'title' | 'auxiliary';

interface TitleBarSlotEntry {
  title: HTMLElement | null;
  auxiliary: HTMLElement | null;
}

const slots = new Map<ShellPage, TitleBarSlotEntry>();
const slotListeners = new Set<() => void>();

function slotEntry(page: ShellPage): TitleBarSlotEntry {
  let entry = slots.get(page);
  if (!entry) {
    entry = { title: null, auxiliary: null };
    slots.set(page, entry);
  }
  return entry;
}

/** Register (or clear, with `null`) one slot element for a page. */
export function registerTitleBarSlot(
  page: ShellPage,
  kind: TitleBarSlotKind,
  element: HTMLElement | null,
): void {
  const entry = slotEntry(page);
  if (entry[kind] === element) return;
  entry[kind] = element;
  for (const listener of slotListeners) listener();
}

function subscribeSlots(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}

function getSlot(page: ShellPage | null, kind: TitleBarSlotKind): HTMLElement | null {
  if (page === null) return null;
  return slots.get(page)?.[kind] ?? null;
}

/** The DOM element a page should portal its header/auxiliary content into. */
export function useTitleBarSlot(page: ShellPage | null, kind: TitleBarSlotKind): HTMLElement | null {
  return useSyncExternalStore(subscribeSlots, () => getSlot(page, kind), () => null);
}

/* ------------------------------------------------------------------ */
/* Page context                                                        */
/* ------------------------------------------------------------------ */

const TitleBarPageContext = createContext<ShellPage | null>(null);

/** Marks the subtree as belonging to one shell page (one per `Activity`). */
export function TitleBarPageProvider({ page, children }: { page: ShellPage; children: ReactNode }) {
  return createElement(TitleBarPageContext.Provider, { value: page }, children);
}

/** The shell page the calling component belongs to, even while hidden. */
export function useTitleBarPage(): ShellPage | null {
  return useContext(TitleBarPageContext);
}
