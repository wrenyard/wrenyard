/**
 * Status-bar item registry and shared metadata (window-chrome spec 4.5, 4.6).
 *
 * This module is the single registration facade for status-bar items so a page
 * can publish an item without importing the `app/` layer. It lives in `lib/`
 * (below `components/` and `pages/`) and only uses React, so:
 *
 * - `app/statusbar/registry.ts` re-exports the registration API, and
 * - pages (e.g. the session page) register a bounded item from an effect, which
 *   is cleaned up when their `<Activity>` hides.
 *
 * {@link STATUS_BAR_CONFIGURABLE_ITEMS} is the exact metadata consumed by both
 * the status-bar context menu and the Settings "外观 › 状态栏" controls; the
 * mandatory ids (`daemon`, `notifications`) are never part of it and can never
 * be hidden. Hidden ids persist in the `statusBar.hidden` preference.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/** Which edge of the status bar an item belongs to. */
export type StatusBarSide = 'start' | 'end';

export interface StatusBarItemDefinition {
  id: string;
  side: StatusBarSide;
  /** Kept longest when the bar runs out of width; lower priorities hide first. */
  priority: number;
  /** Mandatory items are always rendered and are never listed as hideable. */
  mandatory: boolean;
  render: () => ReactNode;
}

/** Always-present items; excluded from {@link STATUS_BAR_CONFIGURABLE_ITEMS}. */
export const STATUS_BAR_MANDATORY_IDS: readonly string[] = ['daemon', 'notifications'];

/**
 * The items a user may hide from the status-bar context menu or Settings. Ids
 * and Chinese labels are the exact shared contract; both consumers read this
 * one list so they can never drift.
 */
export const STATUS_BAR_CONFIGURABLE_ITEMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'activity.tasks', label: '任务' },
  { id: 'activity.taskgraphs', label: '任务图' },
  { id: 'session.turns', label: '会话运行轮次' },
  { id: 'quota', label: '额度' },
  { id: 'update', label: '更新' },
];

const CONFIGURABLE_IDS: ReadonlySet<string> = new Set(STATUS_BAR_CONFIGURABLE_ITEMS.map((item) => item.id));

/** Whether an item id is one the user is allowed to hide. */
export function isConfigurableStatusBarItem(id: string): boolean {
  return CONFIGURABLE_IDS.has(id);
}

/** Whether an item id is mandatory and therefore never hideable. */
export function isMandatoryStatusBarItem(id: string): boolean {
  return STATUS_BAR_MANDATORY_IDS.includes(id);
}

/* ------------------------------------------------------------------ */
/* Registry store                                                      */
/* ------------------------------------------------------------------ */

const items = new Map<string, StatusBarItemDefinition>();
const listeners = new Set<() => void>();
let snapshot: readonly StatusBarItemDefinition[] = [];

function emit(): void {
  snapshot = [...items.values()];
  for (const listener of listeners) listener();
}

/**
 * Register one item; returns a cleanup that removes exactly this definition.
 * A later registration with the same id replaces it (only while it stays the
 * current owner does cleanup actually delete it).
 */
export function registerStatusBarItem(definition: StatusBarItemDefinition): () => void {
  items.set(definition.id, definition);
  emit();
  return () => {
    if (items.get(definition.id) === definition) {
      items.delete(definition.id);
      emit();
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly StatusBarItemDefinition[] {
  return snapshot;
}

/**
 * Wake mounted subscribers after an owner re-rendered with a fresh `render`
 * closure. The definition object identity is unchanged, so the array snapshot
 * identity is refreshed here to make `useSyncExternalStore` re-read it; the
 * call is made from an effect (never during the owner's render) so it can never
 * trigger a render-phase update loop.
 */
function refreshStatusBarItem(id: string): void {
  if (items.has(id)) emit();
}

/** Live status-bar items, re-rendered whenever the registry changes. */
export function useStatusBarItems(): readonly StatusBarItemDefinition[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface UseStatusBarItemOptions {
  id: string;
  side: StatusBarSide;
  priority: number;
  mandatory?: boolean;
  render: () => ReactNode;
}

/**
 * Register a status-bar item for the lifetime of the calling component. The
 * `render` closure is tracked through a ref so it always sees fresh state
 * without re-registering on every render; the item is removed on cleanup, which
 * an `<Activity>` runs when the owning page hides. A second effect (never a
 * render-phase emit) republishes the registry snapshot whenever the owner
 * supplies a new `render` closure, so the mounted status bar re-runs the item
 * with the owner's latest state instead of a stale closure.
 */
export function useStatusBarItem(options: UseStatusBarItemOptions): void {
  const { id, side, priority } = options;
  const mandatory = options.mandatory ?? false;
  const renderRef = useRef(options.render);
  renderRef.current = options.render;

  useEffect(() => {
    return registerStatusBarItem({
      id,
      side,
      priority,
      mandatory,
      render: () => renderRef.current(),
    });
  }, [id, side, priority, mandatory]);

  useEffect(() => {
    refreshStatusBarItem(id);
  }, [id, options.render]);
}

/* ------------------------------------------------------------------ */
/* Popover open requests                                               */
/* ------------------------------------------------------------------ */

// The global `quota.showPanel` command opens the status-bar quota panel from
// any page. The command table lives below `app/`, so the signal is a small
// listener set here and the QuotaItem subscribes to it.

const quotaPanelListeners = new Set<() => void>();

/** Ask the status-bar quota item to open its panel (no-op when not mounted). */
export function requestQuotaPanelOpen(): void {
  for (const listener of quotaPanelListeners) listener();
}

export function onQuotaPanelOpen(listener: () => void): () => void {
  quotaPanelListeners.add(listener);
  return () => {
    quotaPanelListeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */
/* Quota focus                                                         */
/* ------------------------------------------------------------------ */

// The session page publishes the quota provider of the model currently selected
// in the composer, so the status-bar quota item can surface that provider's
// most tense window instead of the global worst one. The store is deliberately
// tiny — one provider id plus a listener set, read through
// `useSyncExternalStore` — because both the session page and the status-bar
// item need it and may not import each other's layer.

let quotaFocus: string | null = null;
const quotaFocusListeners = new Set<() => void>();

/** Focus the given quota provider, or clear the focus with null. */
export function setQuotaFocus(providerId: string | null): void {
  if (quotaFocus === providerId) return;
  quotaFocus = providerId;
  for (const listener of quotaFocusListeners) listener();
}

function subscribeQuotaFocus(listener: () => void): () => void {
  quotaFocusListeners.add(listener);
  return () => {
    quotaFocusListeners.delete(listener);
  };
}

function getQuotaFocusSnapshot(): string | null {
  return quotaFocus;
}

/** The quota provider of the model currently selected in the composer. */
export function useQuotaFocus(): string | null {
  return useSyncExternalStore(subscribeQuotaFocus, getQuotaFocusSnapshot, getQuotaFocusSnapshot);
}
