/**
 * A pure convergence gate over the session ledger: it refuses a second full
 * implementation dispatch for the same target while the same failure is
 * unresolved and the ledger records no new evidence or condition change.
 *
 * It reads only existing ledger events and adds no new event types.
 */
import type { LedgerEvent, TaskSpanRequest } from '../ledger/store.ts';

/** The dispatch target identity: project, task and optional managed worktree. */
export interface DispatchTarget {
  project: string;
  task: string;
  worktree?: string;
}

/** A stable key for one target, so repeats of the same target compare equal. */
export function targetKeyOf(target: DispatchTarget): string {
  return `${target.project}::${target.task}::${target.worktree ?? ''}`;
}

/** The gate's verdict: allowed, or refused as blocked or in-flight. */
export type DispatchGateDecision =
  | { allowed: true }
  | { allowed: false; kind: 'blocked'; message: string }
  | { allowed: false; kind: 'in-flight'; message: string; taskRunIds: string[]; hasMissingTaskRunId: boolean };

/** Bound for the refusal message; keeps the blocked summary readable. */
const MESSAGE_LIMIT = 160;

function truncate(text: string): string {
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

function isTaskSpanOfTarget(event: LedgerEvent, target: DispatchTarget): boolean {
  return event.type === 'span.started'
    && event.kind === 'task'
    && event.request.task === target.task
    && event.request.project === target.project
    && (event.request.worktree ?? '') === (target.worktree ?? '');
}

/**
 * An event that counts as new evidence after a failed dispatch for the target.
 * Only a real condition change counts: an explicitly recorded recovery, a
 * different action that completed real work, or an actual document write.
 * A later ordinary turn, attached files, a document read or instruction load,
 * and a recalled memory are not progress on the blocker and never unblock.
 */
function isEvidenceEvent(event: LedgerEvent, failedActionId: string): boolean {
  switch (event.type) {
    case 'document.content':
      return event.source === 'write';
    case 'action.finished':
      return event.status === 'done' && event.id !== failedActionId;
    case 'system.info':
      return event.code === 'dispatch.condition-change';
    default:
      return false;
  }
}

/**
 * Decide whether one more implementation dispatch may open a task run for the
 * target. A matching task span whose own `span.finished` is still absent is an
 * open span: it may mean a dispatch is still in flight, so the gate reports
 * its task run id and the caller verifies the run is still live before
 * refusing. Otherwise the latest matching failed action blocks a repeat until
 * an evidence event with a greater seq is recorded.
 */
export function evaluateDispatchGate(
  events: readonly LedgerEvent[],
  target: DispatchTarget,
): DispatchGateDecision {
  const finishedTaskSpans = new Set<string>();
  for (const event of events) {
    if (event.type === 'span.finished' && event.kind === 'task') finishedTaskSpans.add(event.id);
  }

  const matchingParents = new Set<string>();
  const taskRunIds: string[] = [];
  let hasMissingTaskRunId = false;
  for (const event of events) {
    if (!isTaskSpanOfTarget(event, target)) continue;
    const parent = 'parent' in event ? (event as { parent?: string }).parent : undefined;
    if (parent === undefined) continue;
    matchingParents.add(parent);
    const span = event as Extract<LedgerEvent, { type: 'span.started' }>;
    // A span that closed itself never blocks, even if its parent action
    // never recorded action.finished.
    if (finishedTaskSpans.has(span.id)) continue;
    const taskRunId = (span.request as TaskSpanRequest).taskRunId;
    if (typeof taskRunId === 'string' && taskRunId !== '') taskRunIds.push(taskRunId);
    else hasMissingTaskRunId = true;
  }
  if (taskRunIds.length > 0 || hasMissingTaskRunId) {
    return {
      allowed: false,
      kind: 'in-flight',
      message: truncate(
        'Dispatch refused: another dispatch for this target is still running; no second run was created.',
      ),
      taskRunIds,
      hasMissingTaskRunId,
    };
  }

  let latestFailure: Extract<LedgerEvent, { type: 'action.finished' }> | undefined;
  for (const event of events) {
    if (event.type !== 'action.finished') continue;
    if (!matchingParents.has(event.id)) continue;
    if (event.status === 'failed' && (event.taskStatus === undefined || event.taskStatus === 'failed')
      && (latestFailure === undefined || event.seq > latestFailure.seq)) {
      latestFailure = event;
    }
  }
  if (latestFailure === undefined) return { allowed: true };

  const hasNewerEvidence = events.some(
    (event) => event.seq > latestFailure!.seq && isEvidenceEvent(event, latestFailure!.id),
  );
  if (hasNewerEvidence) return { allowed: true };

  const taskStatus = latestFailure.taskStatus ?? 'failed';
  const firstLine = latestFailure.result.split('\n', 1)[0] ?? '';
  const summary = truncate(`task ${taskStatus}: ${firstLine}`);
  return {
    allowed: false,
    kind: 'blocked',
    message: `Dispatch refused: the previous run for this target failed and no new evidence or condition change was recorded since (${summary}). This refusal created no task run. The next step is one focused diagnosis or an explicit block report, not another full implementation dispatch.`,
  };
}
