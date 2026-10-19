/**
 * Registry and open state of the image lightbox, free of bridge imports so the
 * pure Markdown renderer can register its images too. A thumbnail registers
 * with `useLightboxItem`; opening collects every registered image inside the
 * same `[data-lightbox-root]` in document order.
 */
import { useCallback } from 'react';

/** One image the lightbox can show. */
export interface LightboxItem {
  name: string;
  /** Preview source shown until the original loads, or the only source. */
  src: string;
  /** The session file behind the image; enables original resolution and file actions. */
  media?: { sessionId: string; path: string };
}

const ITEMS = new WeakMap<Element, LightboxItem>();

export interface LightboxState {
  items: LightboxItem[];
  index: number;
  /** Focus returns here on close. */
  trigger: HTMLElement;
}

let state: LightboxState | null = null;
const listeners = new Set<() => void>();

/** Replace the open state; `null` closes the lightbox. */
export function setLightboxState(next: LightboxState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

/** A ref callback that registers the element's image while it is mounted. */
export function useLightboxItem(item: LightboxItem | undefined): (element: HTMLElement | null) => void {
  const { name, src, media } = item ?? { name: '', src: '' };
  const sessionId = media?.sessionId;
  const path = media?.path;
  return useCallback((element: HTMLElement | null) => {
    if (element === null || src === '') return;
    ITEMS.set(element, {
      name,
      src,
      ...(sessionId === undefined || path === undefined ? {} : { media: { sessionId, path } }),
    });
    element.dataset.lightboxItem = '';
  }, [name, src, sessionId, path]);
}

/** Open the lightbox on a registered thumbnail, with its turn's images as the set. */
export function openLightbox(trigger: HTMLElement): void {
  const root = trigger.closest('[data-lightbox-root]') ?? document.body;
  const elements = [...root.querySelectorAll('[data-lightbox-item]')];
  const items: LightboxItem[] = [];
  let index = 0;
  for (const element of elements) {
    const item = ITEMS.get(element);
    if (item === undefined) continue;
    if (element === trigger) index = items.length;
    items.push(item);
  }
  if (items.length === 0) return;
  setLightboxState({ items, index, trigger });
}

/** Subscribe to the open state. */
export function subscribeLightbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current open state. */
export function lightboxState(): LightboxState | null {
  return state;
}
