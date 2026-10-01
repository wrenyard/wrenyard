/**
 * Shared motion helpers (foundation spec §2). Components use the CSS motion
 * tokens and classes defined in `globals.css`; this module owns the imperative
 * pieces: view transitions, reduced-motion detection, the append-only entry
 * animation state and one-shot effects.
 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Whether motion is reduced by the OS or by an explicit `data-motion="reduce"`. */
export function prefersReducedMotion(): boolean {
  const explicit = document.documentElement.dataset.motion;
  if (explicit === 'reduce') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Run a DOM update inside a View Transition so the browser animates the
 * change. The update is committed synchronously with `flushSync`; reduced
 * motion is handled by the `::view-transition-*` rules in `globals.css`.
 */
export function startViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function') {
    update();
    return;
  }
  doc.startViewTransition(() => {
    flushSync(update);
  });
}

/**
 * Run `update` with transitions globally suppressed through the temporary
 * `data-theme-switching` attribute on `<html>` (foundation spec §1.3).
 */
export function runWithoutTransitions(update: () => void): void {
  const root = document.documentElement;
  root.dataset.themeSwitching = '';
  update();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      delete root.dataset.themeSwitching;
    });
  });
}

/**
 * Capture entry eligibility on first render so an element keeps its enter
 * animation even after the append set moves on.
 */
export function useEnterAnimation(eligible: boolean): boolean {
  const [enter] = useState(eligible);
  return enter;
}

export interface NewItemKeyOptions {
  /** Resets the baseline; use the active session id. */
  scope: string;
  /** When false, current keys are treated as baseline (e.g. while loading history). */
  ready: boolean;
}

/**
 * Keys appended after the current scope's baseline. History that loads for a
 * session is absorbed into the baseline instead of reported as new, so only
 * genuinely appended items animate.
 */
export function useNewItemKeys(
  keys: readonly string[],
  { scope, ready }: NewItemKeyOptions,
): ReadonlySet<string> {
  const scopeRef = useRef(scope);
  const seenRef = useRef<ReadonlySet<string>>(EMPTY_KEYS);
  const baselineRef = useRef(true);

  const scopeChanged = scopeRef.current !== scope;
  const seen = scopeChanged ? EMPTY_KEYS : seenRef.current;
  const baseline = scopeChanged ? true : baselineRef.current;

  const next = new Set(seen);
  let fresh: ReadonlySet<string> = EMPTY_KEYS;
  if (baseline) {
    for (const key of keys) next.add(key);
  } else {
    const added: string[] = [];
    for (const key of keys) {
      if (!seen.has(key)) added.push(key);
      next.add(key);
    }
    if (ready && added.length > 0) fresh = new Set(added);
  }
  const nextBaseline = baseline && !ready;

  useEffect(() => {
    scopeRef.current = scope;
    seenRef.current = next;
    baselineRef.current = nextBaseline;
  });

  return fresh;
}

/**
 * Replay the one-shot number flash on `element`. Used by count/percentage
 * surfaces (status bar and meters) when a value changes.
 */
export function flashNumber(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.classList.remove('motion-number-flash');
  // Force a reflow so re-adding the class restarts the animation.
  void element.offsetWidth;
  element.classList.add('motion-number-flash');
  element.addEventListener('animationend', () => element.classList.remove('motion-number-flash'), {
    once: true,
  });
}
