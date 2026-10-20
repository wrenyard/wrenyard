import { useCallback, useSyncExternalStore } from 'react';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { toast } from '@/renderer/lib/notify';

/** Shared optimistic cancellation overrides keyed by task run id. */
let cancelledTasks = new Map<string, number>();
const inflight = new Set<string>();
const subscribers = new Set<() => void>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(): void {
  for (const notify of [...subscribers]) notify();
}

function setCancelled(taskRunId: string, timestamp: number | null): void {
  if (timestamp === null) {
    if (!cancelledTasks.has(taskRunId)) return;
    const next = new Map(cancelledTasks);
    next.delete(taskRunId);
    cancelledTasks = next;
  } else {
    if (cancelledTasks.has(taskRunId)) return;
    const next = new Map(cancelledTasks);
    next.set(taskRunId, timestamp);
    cancelledTasks = next;
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function getSnapshot(): ReadonlyMap<string, number> {
  return cancelledTasks;
}

const CANCEL_CONFIRM = {
  title: '取消任务？',
  description: '任务会立即停止，已产生的改动保留。',
  confirmLabel: '取消任务',
  destructive: true,
};

/**
 * Confirmed, optimistic task cancellation shared across transcript rows and the
 * background tasks panel. A successful override persists until the backend
 * request fails; dismissal leaves state unchanged.
 */
export function useTaskCancellation(): {
  cancelledTasks: ReadonlyMap<string, number>;
  cancelTask: (taskRunId: string, request: (id: string) => Promise<void>) => Promise<boolean>;
} {
  const confirm = useConfirm();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const cancelTask = useCallback(
    async (taskRunId: string, request: (id: string) => Promise<void>): Promise<boolean> => {
      if (cancelledTasks.has(taskRunId) || inflight.has(taskRunId)) return false;

      inflight.add(taskRunId);
      try {
        const confirmed = await confirm(CANCEL_CONFIRM);
        if (!confirmed) return false;
        if (cancelledTasks.has(taskRunId)) return false;

        setCancelled(taskRunId, Date.now());
        void Promise.resolve()
          .then(() => request(taskRunId))
          .catch((error: unknown) => {
            setCancelled(taskRunId, null);
            toast(errorMessage(error), { level: 'error' });
          });
        return true;
      } finally {
        inflight.delete(taskRunId);
      }
    },
    [confirm],
  );

  return { cancelledTasks: snapshot, cancelTask };
}
