import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionBridgeTaskBrief } from '../model/types.js';
import {
  consumptionRows,
  sessionTaskRows,
  type ConsumptionView,
  type SessionTaskInput,
  type SessionTaskRow,
} from '../model/usage.js';
import { getSessionApi } from '../api.js';
import { useSessionUsage } from './session-usage.js';

/**
 * Headless session-consumption projection for the status bar's metrics item.
 * Every dispatched task is read by its exact `taskRunId` through the existing
 * `session.tasks` API (`task.run.status`), never through the capped
 * `stats.recentTaskRuns` snapshot, so older runs keep their usage. Briefs are
 * merged across polls so a completed task keeps the usage already read for it,
 * while only unresolved ids are re-fetched. The per-conversation usage comes
 * from the loaded ledger calls.
 */

/** Re-read unresolved dispatched tasks at this cadence. */
const RUNNING_REFRESH_MS = 3_000;

/**
 * Task-run statuses the daemon treats as final (`task.run.status`). Every other
 * status — `queued`, `running`, or the brief's `unavailable` marker for a read
 * that failed — stays eligible for polling, so a transient failure recovers at
 * the polling cadence instead of being frozen as a terminal miss.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

function isResolved(brief: SessionBridgeTaskBrief | undefined): boolean {
  return brief !== undefined && TERMINAL_TASK_STATUSES.has(brief.status);
}

export interface SessionConsumption extends ConsumptionView {
  /** Dispatched-task rows, newest first. */
  tasks: SessionTaskRow[];
  /** Number of tasks this session dispatched. */
  dispatched: number;
  /** Terminal dispatched tasks whose usage could not be read. */
  missingTasks: number;
  /** Dispatched tasks still running or queued. */
  runningTasks: number;
}

export function useSessionConsumption(): SessionConsumption {
  const { turns } = useSessionUsage();
  const api = getSessionApi();

  const calls = useMemo(() => turns.flatMap((turn) => turn.calls), [turns]);
  // Every dispatch action this session produced, mirroring what
  // `RunningDispatchTasks` filters in SessionPage.
  const dispatches = useMemo(
    () => turns.flatMap((turn) => turn.actions.filter(
      (action) => action.kind === 'dispatch' && action.taskRunId !== undefined,
    )),
    [turns],
  );
  const taskRunIds = useMemo(
    () => [...new Set(dispatches.map((action) => action.taskRunId!))],
    [dispatches],
  );

  const [briefs, setBriefs] = useState<Record<string, SessionBridgeTaskBrief>>({});
  const briefsRef = useRef(briefs);
  briefsRef.current = briefs;
  // Ids with an in-flight fetch, so an overlapping tick never pulls the same
  // status twice.
  const inFlightRef = useRef<Set<string>>(new Set());
  const idsKey = taskRunIds.join(',');

  // Only ids without a terminal brief are polled; a resolved task keeps the
  // usage already read for it instead of being dropped from the map.
  const hasUnresolved = taskRunIds.some((taskRunId) => !isResolved(briefs[taskRunId]));

  useEffect(() => {
    if (!hasUnresolved) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const current = briefsRef.current;
      const inFlight = inFlightRef.current;
      const targets = taskRunIds.filter(
        (taskRunId) => !isResolved(current[taskRunId]) && !inFlight.has(taskRunId),
      );
      if (targets.length === 0) return;
      for (const taskRunId of targets) inFlight.add(taskRunId);
      try {
        const results = await api.tasks(targets);
        if (cancelled) return;
        const next = { ...briefsRef.current };
        for (const brief of results) next[brief.taskRunId] = brief;
        briefsRef.current = next;
        setBriefs(next);
      } catch {
        // A failed poll keeps the previous briefs; the next tick retries.
      } finally {
        for (const taskRunId of targets) inFlight.delete(taskRunId);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), RUNNING_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `idsKey` captures the exact dispatched ids; `taskRunIds` is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, idsKey, hasUnresolved]);

  // Newest first: dispatch actions are chronological, so walk them backwards.
  // A task dispatched more than once contributes a single row, so dedupe by
  // `taskRunId` while traversing newest-first.
  const taskInputs = useMemo<SessionTaskInput[]>(() => {
    const inputs: SessionTaskInput[] = [];
    const seen = new Set<string>();
    for (let index = dispatches.length - 1; index >= 0; index -= 1) {
      const action = dispatches[index]!;
      const taskRunId = action.taskRunId!;
      if (seen.has(taskRunId)) continue;
      seen.add(taskRunId);
      const brief = briefs[taskRunId];
      const title = brief?.taskName ?? action.task?.taskName ?? action.title;
      inputs.push({
        taskRunId,
        title: title !== '' ? title : taskRunId,
        ...(brief?.runtime === undefined ? {} : { model: brief.runtime }),
        status: brief?.status ?? 'running',
        ...(brief?.usage === undefined ? {} : { usage: brief.usage }),
      });
    }
    return inputs;
  }, [dispatches, briefs]);

  const tasks = useMemo(() => sessionTaskRows(taskInputs), [taskInputs]);
  const view = useMemo(() => consumptionRows(calls, tasks), [calls, tasks]);

  return {
    ...view,
    tasks,
    dispatched: taskRunIds.length,
    missingTasks: tasks.filter((task) => task.missing).length,
    runningTasks: tasks.filter((task) => task.running).length,
  };
}
