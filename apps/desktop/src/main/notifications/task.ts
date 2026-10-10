// Task producer: notify when a vanished run's authoritative status is done or failed; every other status is ignored.

import type { AppNotification, Notifier } from './notifier.js';
import type { VanishedTaskRun } from '../activity-status.js';

export interface TaskNotifierDeps {
  notifier: Notifier;
  /** Raw daemon transport, used to resolve an authoritative terminal run status. */
  requestForeman(method: string, params: unknown): Promise<unknown>;
}

export interface TaskNotifier {
  notifyVanishedTaskRun(run: VanishedTaskRun): Promise<void>;
}

export function createTaskNotifier(deps: TaskNotifierDeps): TaskNotifier {
  async function notifyVanishedTaskRun(run: VanishedTaskRun): Promise<void> {
    let status: string | null = null;
    try {
      const raw = await deps.requestForeman('task.run.status', { task_run_id: run.taskRunId });
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const value = (raw as { status?: unknown }).status;
        if (typeof value === 'string') status = value;
      }
    } catch {
      return;
    }
    if (status !== 'done' && status !== 'failed') return;
    const label = run.taskLabel ?? run.taskRunId;
    const body = run.project !== undefined ? `${label} · ${run.project}` : label;
    const notification: AppNotification = {
      id: `task-run:${run.taskRunId}:${Date.now()}`,
      level: status === 'done' ? 'success' : 'error',
      title: status === 'done' ? '完成' : '失败',
      body,
      action: { label: '查看', command: { id: 'tasks.open', args: { taskRunId: run.taskRunId } } },
    };
    deps.notifier.notify(notification, ['inApp']);
  }

  return { notifyVanishedTaskRun };
}
