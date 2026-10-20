import { useEffect, useRef } from 'react';
import type { ActionModel, SessionApi, SessionBridgeTaskBrief } from '../model/types.js';

const POLL_INTERVAL_MS = 3000;

/**
 * Resolves a brief for every dispatch action that opened a task run: ids the
 * task cache does not know yet get a single one-time fetch (finished turns and
 * reopened sessions included), while only still-running actions keep polling
 * every 3 seconds. When a running action ends, one extra poll fetches its
 * terminal status, then polling stops until another dispatch starts. Fetched
 * briefs merge into the existing task map so earlier reads are never dropped.
 */
export function useTaskStatus(
  api: SessionApi,
  actions: readonly ActionModel[],
  tasks: Record<string, SessionBridgeTaskBrief>,
  onTasks: (tasks: Record<string, SessionBridgeTaskBrief>) => void,
): void {
  const previous = useRef<Set<string>>(new Set());
  // Ids already given their one-time fetch, so a transient tasks-prop lag or a
  // failed fetch can never issue a duplicate request.
  const fetched = useRef<Set<string>>(new Set());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const runningIds = actions
    .filter((action) => action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined)
    .map((action) => action.taskRunId!);
  const allIds = actions
    .filter((action) => action.kind === 'dispatch' && action.taskRunId !== undefined)
    .map((action) => action.taskRunId!);
  const runningKey = [...new Set(runningIds)].sort().join(',');
  const allKey = [...new Set(allIds)].sort().join(',');

  useEffect(() => {
    const current = new Set(runningIds);
    const justEnded = [...previous.current].filter((id) => !current.has(id));
    previous.current = current;

    // Dispatch ids with no cached brief get exactly one fetch, whether their
    // action (and turn) is still running or long finished.
    const missing = [...new Set(allIds)].filter(
      (id) => tasksRef.current[id] === undefined && !fetched.current.has(id),
    );
    for (const id of missing) fetched.current.add(id);

    const ids = [...new Set([...current, ...justEnded, ...missing])];
    if (ids.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const resolved = await api.tasks(ids);
        if (cancelled) return;
        onTasks({
          ...tasksRef.current,
          ...Object.fromEntries(resolved.map((task) => [task.taskRunId, task])),
        });
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
    // `runningKey`/`allKey` capture the polled ids; both id lists are rebuilt
    // per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runningKey, allKey, onTasks]);
}
