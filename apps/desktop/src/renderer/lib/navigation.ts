/**
 * Renderer navigation history and secondary-sidebar coordination.
 *
 * The main process stays the single source of the current page (`onViewChanged`).
 * This module records the locations that flow through it — page switches and,
 * via `useNavLocation`, each page's own position — into a bounded history used
 * by the back/forward commands. It also lets a page publish its secondary
 * sidebar open state so the title bar and Cmd/Ctrl+B can toggle the active page.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ShellPage } from '@/shell-contract';
import { onViewChanged, shell, useShellPage } from '@/renderer/lib/desktop';

export interface NavLocation {
  page: ShellPage;
  /** Page-defined position (for example `{ sessionId }`); the page interprets it. */
  state?: Record<string, string>;
}

const CAPACITY = 50;

let entries: NavLocation[] = [];
let index = -1;
let activePage: ShellPage = 'session';
// A page-level navigation pushed an entry with no state yet; the page's first
// reported state adopts that entry instead of pushing a second one.
let pendingRestore: { page: ShellPage; state: Record<string, string>; direction: 1 | -1 } | null = null;
// Set while a back/forward switch is in flight so the resulting `viewChanged`
// is not recorded as a brand-new page location.
let suppressNextView = false;
let restoreToken = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameState(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.page === b.page && sameState(a.state, b.state);
}

function push(location: NavLocation): void {
  const top = index >= 0 ? entries[index] : undefined;
  if (top && sameLocation(top, location)) return;
  entries = entries.slice(0, index + 1);
  entries.push({ page: location.page, ...(location.state ? { state: { ...location.state } } : {}) });
  if (entries.length > CAPACITY) entries = entries.slice(entries.length - CAPACITY);
  index = entries.length - 1;
  emit();
}

/** Move the cursor one step and ask the target page to restore its position. */
function step(direction: 1 | -1): void {
  const next = index + direction;
  if (next < 0 || next >= entries.length) return;
  const location = entries[next];
  index = next;
  pendingRestore = { page: location.page, state: location.state ?? {}, direction };
  restoreToken += 1;
  if (location.page !== activePage) {
    suppressNextView = true;
    emit();
    void shell.navigate(location.page);
    return;
  }
  emit();
}

/** Navigate to a page, optionally with an initial page-defined position. */
export async function navigate(page: ShellPage, state?: Record<string, string>): Promise<void> {
  push(state ? { page, state } : { page });
  if (state) {
    pendingRestore = { page, state: { ...state }, direction: 1 };
    restoreToken += 1;
    emit();
  }
  if (page !== activePage) {
    suppressNextView = true;
    await shell.navigate(page);
  }
}

/** Go to the previous location, skipping entries whose target no longer exists. */
export function back(): void {
  step(-1);
}

/** Go to the next location, skipping entries whose target no longer exists. */
export function forward(): void {
  step(1);
}

/* The main process remains authoritative; record the page switches it reports. */
onViewChanged((page) => {
  activePage = page;
  if (suppressNextView) {
    suppressNextView = false;
    emit();
    return;
  }
  const top = index >= 0 ? entries[index] : undefined;
  if (top?.page === page) {
    emit();
    return;
  }
  push({ page });
});

let navSnapshot = { canBack: false, canForward: false };

function getNavigation(): { canBack: boolean; canForward: boolean } {
  const canBack = index > 0;
  const canForward = index >= 0 && index < entries.length - 1;
  if (navSnapshot.canBack !== canBack || navSnapshot.canForward !== canForward) {
    navSnapshot = { canBack, canForward };
  }
  return navSnapshot;
}

/** Back/forward availability for the title bar buttons. */
export function useNavigation(): { canBack: boolean; canForward: boolean } {
  return useSyncExternalStore(subscribe, getNavigation, getNavigation);
}

function stateKey(state: Record<string, string>): string {
  const keys = Object.keys(state).sort();
  let key = '';
  for (const name of keys) key += `${name}=${state[name]}\u0000`;
  return key;
}

/**
 * Register a page's internal location. When `state` changes while the page is
 * active the new location is pushed; on back/forward `restore` receives the
 * recorded state. Returning `false` marks the target as gone and the history
 * continues in the same direction.
 */
export function useNavLocation(
  state: Record<string, string>,
  restore: (state: Record<string, string>) => boolean | void,
): void {
  const page = useShellPage();
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const key = stateKey(state);
  const token = useSyncExternalStore(subscribe, () => restoreToken, () => restoreToken);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (page !== activePage) return;
    const top = index >= 0 ? entries[index] : undefined;
    // Adopt a page-level entry that has no state yet: the page's own location
    // describes the entry that was just pushed.
    if ((!pendingRestore || pendingRestore.page !== page) && top && top.page === page && top.state === undefined) {
      entries[index] = { page, state: { ...state } };
      previous.current = key;
      emit();
      return;
    }
    if (pendingRestore && pendingRestore.page === page) {
      previous.current = key;
      return;
    }
    if (previous.current === null) {
      previous.current = key;
      if (entries.length === 0) push({ page, state });
      return;
    }
    if (previous.current === key) return;
    previous.current = key;
    push({ page, state });
  }, [page, key]);

  useEffect(() => {
    if (!pendingRestore || pendingRestore.page !== page) return;
    const request = pendingRestore;
    pendingRestore = null;
    let accepted: boolean | void;
    try {
      accepted = restoreRef.current(request.state);
    } catch {
      accepted = false;
    }
    if (accepted === false) step(request.direction);
  }, [token, page]);
}

/* ------------------------------------------------------------------ */
/* Secondary sidebar coordination                                      */
/* ------------------------------------------------------------------ */

interface SecondarySidebarRegistration {
  page: ShellPage;
  open: boolean;
  setOpen: (open: boolean) => void;
}

let secondary: SecondarySidebarRegistration | null = null;
const secondaryListeners = new Set<() => void>();
let secondarySnapshot = { available: false, open: false };

function emitSecondary(): void {
  const available = secondary !== null;
  const open = secondary?.open ?? false;
  if (secondarySnapshot.available !== available || secondarySnapshot.open !== open) {
    secondarySnapshot = { available, open };
  }
  for (const listener of secondaryListeners) listener();
}

function subscribeSecondary(listener: () => void): () => void {
  secondaryListeners.add(listener);
  return () => {
    secondaryListeners.delete(listener);
  };
}

function getSecondary(): { available: boolean; open: boolean } {
  return secondarySnapshot;
}

/**
 * Publish a page's secondary sidebar to the shell. Only the active page has a
 * live effect, so at most one registration exists at a time.
 */
export function useSecondarySidebar({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }): void {
  const page = useShellPage();
  useEffect(() => {
    secondary = { page, open, setOpen };
    emitSecondary();
    return () => {
      if (secondary?.page === page) {
        secondary = null;
        emitSecondary();
      }
    };
  }, [page, open, setOpen]);
}

/** Whether the active page has a secondary sidebar, and whether it is open. */
export function useSecondarySidebarToggle(): { available: boolean; open: boolean } {
  return useSyncExternalStore(subscribeSecondary, getSecondary, getSecondary);
}

export function toggleSecondarySidebar(): void {
  if (!secondary) return;
  secondary.setOpen(!secondary.open);
}

// Cmd/Ctrl+B toggles only the active page's secondary sidebar. Capture phase
// with `stopPropagation` keeps the shadcn `SidebarProvider` shortcut (which
// would toggle its own provider) from firing as well.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return;
      if (document.visibilityState !== 'visible' || secondary === null) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSecondarySidebar();
    },
    { capture: true },
  );
}
