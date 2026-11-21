/**
 * Shared motion helpers (foundation spec §2). Components use the CSS motion
 * tokens and classes defined in `globals.css`; this module owns the imperative
 * pieces: view transitions, reduced-motion detection, the append-only entry
 * animation state and one-shot effects.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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

/** Lifecycle phases of a presence-animated element (`.wy-panel-animated`). */
export type AnimatedPresenceState = 'entering' | 'open' | 'exiting' | 'closed';

/**
 * Mount/unmount wrapper that keeps an element in the DOM for its exit
 * transition. Consumers render while `mounted` and mirror `state` onto a
 * `data-presence` attribute; the CSS motion classes do the animating.
 */
export function useAnimatedPresence(open: boolean, exitMs = 240): {
  mounted: boolean;
  state: AnimatedPresenceState;
} {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<AnimatedPresenceState>(
    open ? 'entering' : 'closed',
  );

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (prefersReducedMotion()) {
        setState('open');
        return;
      }
      setState('entering');
      // Promote to `open` only after the entering styles have painted twice,
      // so the transition from the offset pose actually runs.
      let secondFrame = 0;
      const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => setState('open'));
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
      };
    }

    setState((current) => (current === 'closed' ? 'closed' : 'exiting'));
    if (prefersReducedMotion()) {
      setMounted(false);
      setState('closed');
      return;
    }
    const timer = window.setTimeout(() => {
      setMounted(false);
      setState('closed');
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted, state };
}

/**
 * Input of `triggerM3Ripple`: a React pointer event. The DOM-flavoured name is
 * a local alias so both spellings of the union refer to the same shape.
 */
type PointerEvent<TTarget extends HTMLElement = HTMLElement> =
  ReactPointerEvent<TTarget>;

/** Fallback removal window; the ripple animation itself runs 480ms. */
const RIPPLE_REMOVE_FALLBACK_MS = 520;

/**
 * Spawn an M3 state-layer ripple inside `event.currentTarget` from the press
 * point. The ink element carries the `.wy-ripple-ink` class from
 * `globals.css`; it removes itself on `animationend`, with a timeout fallback.
 */
export function triggerM3Ripple(
  event: PointerEvent<HTMLElement> | ReactPointerEvent<HTMLElement>,
): void {
  if (prefersReducedMotion()) return;
  // Primary button only; anything else (right/middle click, touch idles) bails.
  if (event.button !== 0) return;
  const host = event.currentTarget;
  if (!host) return;
  if (
    host.hasAttribute('disabled') ||
    host.getAttribute('aria-disabled') === 'true' ||
    (host instanceof HTMLButtonElement && host.disabled)
  ) {
    return;
  }

  const rect = host.getBoundingClientRect();
  const diameter = Math.max(rect.width, rect.height) * 1.9;
  const radius = diameter / 2;
  const ink = document.createElement('span');
  ink.className = 'wy-ripple-ink';
  ink.style.left = `${event.clientX - rect.left - radius}px`;
  ink.style.top = `${event.clientY - rect.top - radius}px`;
  ink.style.width = `${diameter}px`;
  ink.style.height = `${diameter}px`;
  ink.addEventListener('animationend', () => ink.remove(), { once: true });
  window.setTimeout(() => ink.remove(), RIPPLE_REMOVE_FALLBACK_MS);
  host.appendChild(ink);
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
