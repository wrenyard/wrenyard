import { useEffect, useRef } from 'react';
import type { ActionModel, SessionApi, SessionV2BridgeTaskBrief } from '../model/types.js';

const POLL_INTERVAL_MS = 3000;

/**
 * Polls task status for the turn's running dispatch actions every 3 seconds.
 * When an action ends, one extra poll fetches its terminal status, then polling
 * stops until another dispatch starts.
 */
export function useTaskStatus(
  api: SessionApi,
  actions: readonly ActionModel[],
  onTasks: (tasks: Record<string, SessionV2BridgeTaskBrief>) => void,
): void {
  const previous = useRef<Set<string>>(new Set());
  const runningIds = actions
    .filter((action) => action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined)
    .map((action) => action.taskRunId!);
  const runningKey = [...runningIds].sort().join(',');

  useEffect(() => {
    const current = new Set(runningIds);
    const justEnded = [...previous.current].filter((id) => !current.has(id));
    previous.current = current;
    const ids = [...new Set([...current, ...justEnded])];
    if (ids.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const tasks = await api.tasks(ids);
        if (cancelled) return;
        onTasks(Object.fromEntries(tasks.map((task) => [task.taskRunId, task])));
      } catch {
        // A failed poll must not stop the loop; the next tick retries.
      }
      if (!cancelled && current.size > 0) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `runningKey` captures the polled ids; `runningIds` is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runningKey, onTasks]);
}
