import type { WorkerSnapshot } from './forge-types';

// ── Hit-test ──

export interface WorkerBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Check if mouse coordinates (mx, my) are inside the worker's bounding box.
 */
export function hitTest(bounds: WorkerBounds, mx: number, my: number): boolean {
  return mx >= bounds.x && mx <= bounds.x + bounds.w &&
         my >= bounds.y && my <= bounds.y + bounds.h;
}

// ── Info card ──

export interface InfoCard {
  workerIdentityKey: string;
  profile: string;
  status: string;
  toolCount: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  project?: string;
  isWorktree: boolean;
  firstSentence?: string;
  tail?: string;
  taskId?: string;
  taskName?: string;
  taskLabel?: string;
}

/**
 * Build an info card from a WorkerSnapshot and optional recent texts.
 *
 * @param worker The worker snapshot from SiteModel
 * @param nowMs Current time for duration calculation (defaults to Date.now())
 */
export function buildInfoCard(worker: WorkerSnapshot, nowMs?: number): InfoCard {
  const now = nowMs ?? Date.now();
  const durationMs = Math.max(0, worker.durationMs ?? (now - worker.startedAt));

  return {
    workerIdentityKey: worker.workerIdentityKey,
    profile: worker.profile,
    status: displayStatus(worker.lastToolStatus ?? worker.meta.status),
    toolCount: worker.toolCount,
    durationMs,
    inputTokens: worker.inputTokens,
    outputTokens: worker.outputTokens,
    project: worker.meta.project,
    isWorktree: worker.meta.isWorktree,
    firstSentence: worker.firstSentence,
    tail: worker.lastToolOutputTail ?? worker.lastText,
    taskId: worker.meta.taskId,
    taskName: worker.meta.taskName,
    taskLabel: worker.meta.taskLabel,
  };
}

function displayStatus(status: string | undefined): string {
  const normalized = status?.trim() ?? '';
  if (normalized === 'running' || normalized === 'unknown') return '';
  return normalized;
}
