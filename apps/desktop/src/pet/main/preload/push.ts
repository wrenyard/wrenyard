// ── Buffered preload pushes ──────────────────────────────────────────
// The main process can push the initial slip/transcript state before the React
// root mounts and its effect calls the narrow preload API, and the same race
// reappears after a renderer reload. These helpers bind the main->renderer
// channel at preload module load, remember what arrived, and replay it to the
// first subscriber. They add no IPC endpoint and expose no shell facade.

import { ipcRenderer, type IpcRendererEvent } from 'electron';

type PushListener<T> = (value: T) => void;

export interface PushBuffer<T> {
  /** Replay the buffered value (if any), then receive every later push. */
  subscribe(listener: PushListener<T>): () => void;
  /** Drop the buffered value so a later subscriber starts empty. */
  reset(): void;
}

/**
 * Keep only the most recent value of a channel. `onPush` runs synchronously on
 * arrival before listeners, so a caller can invalidate a related buffer (for
 * example an error that a newer snapshot supersedes).
 */
export function latestPush<T>(channel: string, onPush?: (value: T) => void): PushBuffer<T> {
  let hasValue = false;
  let latest!: T;
  const listeners = new Set<PushListener<T>>();

  ipcRenderer.on(channel, (_event: IpcRendererEvent, value: T) => {
    latest = value;
    hasValue = true;
    onPush?.(value);
    for (const listener of [...listeners]) listener(value);
  });

  return {
    subscribe(listener: PushListener<T>): () => void {
      listeners.add(listener);
      if (hasValue) listener(latest);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(): void {
      hasValue = false;
    },
  };
}

/**
 * Queue every value of a channel until the first subscriber attaches, then
 * deliver the queue in order followed by live pushes, so the initial
 * incremental pages are never dropped.
 */
export function queuePush<T>(channel: string): PushBuffer<T> {
  const queue: T[] = [];
  const listeners = new Set<PushListener<T>>();

  ipcRenderer.on(channel, (_event: IpcRendererEvent, value: T) => {
    if (listeners.size === 0) {
      queue.push(value);
      return;
    }
    for (const listener of [...listeners]) listener(value);
  });

  return {
    subscribe(listener: PushListener<T>): () => void {
      listeners.add(listener);
      while (queue.length > 0) listener(queue.shift() as T);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(): void {
      queue.length = 0;
    },
  };
}
