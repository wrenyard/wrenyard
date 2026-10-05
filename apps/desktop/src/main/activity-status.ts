// ── Status-bar activity projection + lifecycle tracking ──────────────
// The main process owns one shared `ActivityPresence` round (see
// `DaemonSubscriptions`). This module derives the bounded, renderer-facing
// `ActivityStatusSnapshot` from that round and decides when its content
// actually changed so the push channel fires only on real change — `sampledAt`
// alone never counts as a change.
//
// It also tracks which active (queued or running) task runs were present in the
// previous complete round, so a run that vanishes can be resolved to its
// terminal fact via `task.run.status` rather than being inferred from its
// disappearance. Cold start seeds the tracker without emitting anything (no
// historical replay).

import type { ActivityPresence } from '../shell-contract.js';
import type { ActivityStatusSnapshot, ActivityStatusTask, ActivityStatusTaskGraph } from '../shell-contract';

/** Empty round used before the first projection; never carries activity. */
export const EMPTY_ACTIVITY_STATUS: ActivityStatusSnapshot = {
  sampledAt: '',
  stale: false,
  tasks: [],
  taskgraphs: [],
};

/** Project the shared presence round into the lean status-bar snapshot. */
export function projectActivityStatus(presence: ActivityPresence): ActivityStatusSnapshot {
  const tasks: ActivityStatusTask[] = presence.tasks.map((task) => ({
    taskRunId: task.taskRunId,
    status: task.status,
    ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
    ...(task.taskLabel !== undefined ? { taskLabel: task.taskLabel } : {}),
    ...(task.project !== undefined ? { project: task.project } : {}),
    ...(task.taskgraphId !== undefined ? { taskgraphId: task.taskgraphId } : {}),
    // A running task's elapsed time counts from its real launch; a queued one from acceptance.
    startedAt: task.startedAt ?? task.createdAt,
  }));

  const taskgraphs: ActivityStatusTaskGraph[] = presence.taskgraphs.map((graph) => ({
    taskgraphId: graph.taskgraphId,
    ...(graph.title !== undefined ? { title: graph.title } : {}),
    ...(graph.project !== undefined ? { project: graph.project } : {}),
    state: graph.state,
    nodeCounts: { ...graph.nodeCounts },
  }));

  return { sampledAt: presence.sampledAt, stale: presence.stale, tasks, taskgraphs };
}

/** Stable content key that excludes the volatile sample timestamp. */
function activityContentKey(snapshot: ActivityStatusSnapshot): string {
  return JSON.stringify({ stale: snapshot.stale, tasks: snapshot.tasks, taskgraphs: snapshot.taskgraphs });
}

/**
 * Keeps the latest projection and reports only content-change rounds. A round
 * whose content is identical replaces the cached snapshot (so `sampledAt`
 * stays current) but returns null, suppressing a redundant push.
 */
export class ActivityStatusProjector {
  private current: ActivityStatusSnapshot = EMPTY_ACTIVITY_STATUS;
  private key = activityContentKey(EMPTY_ACTIVITY_STATUS);

  get(): ActivityStatusSnapshot {
    return this.current;
  }

  /** Returns the fresh snapshot when content changed, otherwise null. */
  update(presence: ActivityPresence): ActivityStatusSnapshot | null {
    const next = projectActivityStatus(presence);
    const nextKey = activityContentKey(next);
    if (nextKey === this.key) {
      this.current = next;
      return null;
    }
    this.key = nextKey;
    this.current = next;
    return next;
  }
}

export interface VanishedTaskRun {
  taskRunId: string;
  taskLabel?: string;
  project?: string;
}

/**
 * Detects any observed active (queued or running) task run that dropped out of
 * the active set between two complete rounds. The first round only seeds state
 * (no historical replay) and a stale round is ignored, so a vanished run is
 * always a real transition that the caller must resolve to a terminal fact via
 * the authoritative run status. Both statuses are reported because a queued run
 * can start and finish inside one 2-second sampling interval, so it would
 * otherwise never be observed as running; its disappearance is never itself
 * treated as success or failure.
 */
export class TaskRunLifecycleTracker {
  private active = new Map<string, ActivityStatusTask>();
  private seeded = false;

  observe(snapshot: ActivityStatusSnapshot): VanishedTaskRun[] {
    if (snapshot.stale) return [];
    const next = new Map(snapshot.tasks.map((task) => [task.taskRunId, task]));
    if (!this.seeded) {
      this.seeded = true;
      this.active = next;
      return [];
    }
    const vanished: VanishedTaskRun[] = [];
    for (const [id, task] of this.active) {
      if (next.has(id)) continue;
      vanished.push({
        taskRunId: id,
        ...(task.taskLabel !== undefined ? { taskLabel: task.taskLabel } : {}),
        ...(task.project !== undefined ? { project: task.project } : {}),
      });
    }
    this.active = next;
    return vanished;
  }
}
