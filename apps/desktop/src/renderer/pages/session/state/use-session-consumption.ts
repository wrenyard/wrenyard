import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskRunUsage } from '@/shell-contract';
import { statsQuery } from '@/renderer/pages/stats/queries';
import type { SessionBridgeTaskBrief } from '../model/types.js';
import { consumptionRows, type ConsumptionView } from '../model/usage.js';
import { getSessionApi } from '../api.js';
import { useSessionUsage } from './session-usage.js';
import { useTaskStatus } from './use-task-status.js';

/**
 * Headless session-consumption projection for the status bar's metrics item.
 * The per-conversation usage is derived from the loaded ledger calls, while the
 * dispatched-task usage is read from the existing `getStats` snapshot (the same
 * query the stats page uses), whose `recentTaskRuns` is capped to the 50 most
 * recent runs. No daemon method, IPC channel or bridge function is added.
 */

/** Re-read the stats snapshot at this cadence while a dispatched task runs. */
const RUNNING_REFRESH_MS = 30_000;

export interface SessionConsumption extends ConsumptionView {
  /** Tasks this session dispatched, whether or not the snapshot holds usage. */
  tasks: number;
}

export function useSessionConsumption(): SessionConsumption {
  const { turns } = useSessionUsage();
  const api = getSessionApi();

  const calls = useMemo(() => turns.flatMap((turn) => turn.calls), [turns]);
  // Every dispatch action this session produced, mirroring what
  // `RunningDispatchTasks` filters in SessionPage; `useTaskStatus` narrows to
  // the currently running ones itself.
  const dispatches = useMemo(
    () => turns.flatMap((turn) => turn.actions.filter(
      (action) => action.kind === 'dispatch' && action.taskRunId !== undefined,
    )),
    [turns],
  );

  const [tasks, setTasks] = useState<Record<string, SessionBridgeTaskBrief>>({});
  useTaskStatus(api, dispatches, setTasks);

  const running = Object.values(tasks).some(
    (task) => task.status === 'running' || task.status === 'queued',
  );

  const stats = useQuery({
    ...statsQuery,
    refetchInterval: running ? RUNNING_REFRESH_MS : false,
  });

  const taskRunIds = useMemo(
    () => [...new Set(dispatches.map((action) => action.taskRunId!))],
    [dispatches],
  );
  const usageByRun = useMemo(() => {
    const map = new Map<string, TaskRunUsage>();
    for (const run of stats.data?.recentTaskRuns ?? []) map.set(run.taskRunId, run.usage);
    return map;
  }, [stats.data]);
  const taskUsages = useMemo(
    () => taskRunIds.map((taskRunId) => usageByRun.get(taskRunId)),
    [taskRunIds, usageByRun],
  );

  const view = useMemo(() => consumptionRows(calls, taskUsages), [calls, taskUsages]);

  // A dispatched task leaving the running set refreshes the snapshot once, so a
  // just-finished run enters `recentTaskRuns` without waiting for the interval.
  const refetch = stats.refetch;
  const previousRunning = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      Object.entries(tasks)
        .filter(([, task]) => task.status === 'running' || task.status === 'queued')
        .map(([taskRunId]) => taskRunId),
    );
    const finished = [...previousRunning.current].some((taskRunId) => !current.has(taskRunId));
    previousRunning.current = current;
    if (finished) void refetch();
  }, [tasks, refetch]);

  return { ...view, tasks: taskRunIds.length };
}
