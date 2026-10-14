/**
 * Renderer seen state for the session status dots. Every window (the shell and
 * each mini card) shares one snapshot loaded from the main-process store:
 * `getSeen()` loads it once and `onSeenChanged` keeps it current for the whole
 * module lifetime, following the module-level useSyncExternalStore convention
 * of `lib/mini.ts`.
 */
import { useSyncExternalStore } from 'react';
import { getSessionBridge } from '@/renderer/lib/session';
import type { SessionBridge, SessionSeenState } from '@/session/preload';

let state: SessionSeenState | null = null;
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

function getSnapshot(): SessionSeenState | null {
  return state;
}

const bridge: SessionBridge | undefined = getSessionBridge();

// The bridge is missing in windows that do not expose the session API, and an
// older bridge may lack the seen methods. In either case skip the load and the
// subscription, keep `state` null (so no unread dot shows) and make
// `markSessionSeen` a no-op, instead of throwing synchronously at import time.
if (
  bridge &&
  typeof bridge.getSeen === 'function' &&
  typeof bridge.onSeenChanged === 'function' &&
  typeof bridge.markSeen === 'function'
) {
  // A push that arrives before the initial load resolves must win: bump the
  // generation in the listener and apply the load only if it is unchanged.
  let generation = 0;
  const loadGeneration = generation;

  void bridge.getSeen().then((next) => {
    if (generation !== loadGeneration) return;
    state = next;
    emit();
  }).catch(() => undefined);

  // Kept for the module lifetime; the main process broadcasts to every window.
  bridge.onSeenChanged((next) => {
    generation += 1;
    state = next;
    emit();
  });
}

/** The shared seen state, or null until the first load resolves. */
export function useSessionSeen(): SessionSeenState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Mark one session as seen now; the new snapshot broadcasts to every window. */
export function markSessionSeen(id: string): void {
  if (!bridge || typeof bridge.markSeen !== 'function') return;
  void bridge.markSeen(id).catch(() => undefined);
}
