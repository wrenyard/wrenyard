import { useSyncExternalStore } from 'react';

/**
 * One shared wall-clock ticker for the whole page. Every `Elapsed` and the
 * running timeline subscribe here instead of starting their own interval; the
 * timer stops as soon as the last subscriber unsubscribes.
 */

const subscribers = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  current = Date.now();
  for (const notify of [...subscribers]) notify();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (subscribers.size === 1) {
    current = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** Current epoch milliseconds, refreshed once per second while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
