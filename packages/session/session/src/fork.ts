import type { SessionEventBase, SessionEventDraft } from './types.ts';

export interface DanglingTurnRepair {
  turn: number;
  turnId: string;
  danglingSpanIds: string[];
  danglingActionIds: string[];
  danglingStepIds: string[];
  danglingTaskRunIds: string[];
}

export interface TailRepairPlan<E extends SessionEventBase = SessionEventBase> {
  plans: DanglingTurnRepair[];
  danglingTaskRunIds: string[];
  drafts: SessionEventDraft<E>[];
  hasDanglingWork: boolean;
}

/**
 * Inspect `events` for unfinished turns and collect their dangling spans,
 * actions, steps, and task run ids, emitting child-first closer drafts.
 */
export function repairInterruptedTail<E extends SessionEventBase>(
  events: readonly E[],
  options?: { reason?: 'shutdown' | 'fork' },
): { plans: DanglingTurnRepair[]; drafts: SessionEventDraft<E>[] } {
  const reason = options?.reason ?? 'shutdown';
  const startedTurns = new Map<number, string>();
  const finishedTurns = new Set<number>();

  for (const event of events) {
    if (typeof event.turn !== 'number') continue;
    if (event.type === 'turn.started') {
      if (!startedTurns.has(event.turn)) {
        startedTurns.set(event.turn, typeof event.id === 'string' ? event.id : `t${event.turn}`);
      }
    } else if (event.type === 'turn.finished') {
      finishedTurns.add(event.turn);
    }
  }

  const plans: DanglingTurnRepair[] = [];
  const drafts: SessionEventDraft<E>[] = [];

  for (const [turn, turnId] of startedTurns) {
    if (finishedTurns.has(turn)) continue;

    const finishedSpans = new Set<string>();
    const finishedActions = new Set<string>();
    const finishedSteps = new Set<string>();

    for (const event of events) {
      if (event.turn !== undefined && event.turn !== turn) continue;
      if (typeof event.id !== 'string') continue;
      if (event.type === 'span.finished') finishedSpans.add(event.id);
      else if (event.type === 'action.finished') finishedActions.add(event.id);
      else if (event.type === 'step.finished') finishedSteps.add(event.id);
    }

    const turnEvents = events.filter((event) => event.turn === turn);
    const danglingSpanIds: string[] = [];
    const danglingActionIds: string[] = [];
    const danglingStepIds: string[] = [];
    const danglingTaskRunIds: string[] = [];

    const seenSpans = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'span.started' || typeof event.id !== 'string') continue;
      if (finishedSpans.has(event.id) || seenSpans.has(event.id)) continue;
      seenSpans.add(event.id);
      danglingSpanIds.push(event.id);

      const rec = event as Record<string, unknown>;
      const kind = rec.kind;
      const request = rec.request;
      if (
        kind === 'task'
        && request !== null
        && typeof request === 'object'
        && typeof (request as Record<string, unknown>).taskRunId === 'string'
      ) {
        danglingTaskRunIds.push((request as Record<string, unknown>).taskRunId as string);
      }

      drafts.push({
        type: 'span.finished',
        id: event.id,
        ...(kind === undefined ? {} : { kind }),
        turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
      } as unknown as SessionEventDraft<E>);
    }

    const seenActions = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'action.started' || typeof event.id !== 'string') continue;
      if (finishedActions.has(event.id) || seenActions.has(event.id)) continue;
      seenActions.add(event.id);
      danglingActionIds.push(event.id);

      const rec = event as Record<string, unknown>;
      const action = rec.action;
      const actionType = action !== null
        && typeof action === 'object'
        && typeof (action as Record<string, unknown>).type === 'string'
        ? (action as Record<string, unknown>).type as string
        : undefined;

      drafts.push({
        type: 'action.finished',
        id: event.id,
        ...(actionType === undefined ? {} : { action: { type: actionType } }),
        turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
        result: '',
        afterInterrupt: true,
      } as unknown as SessionEventDraft<E>);
    }

    const seenSteps = new Set<string>();
    for (const event of turnEvents) {
      if (event.type !== 'step.started' || typeof event.id !== 'string') continue;
      if (finishedSteps.has(event.id) || seenSteps.has(event.id)) continue;
      seenSteps.add(event.id);
      danglingStepIds.push(event.id);

      drafts.push({
        type: 'step.finished',
        id: event.id,
        turn,
        ...(event.step === undefined ? {} : { step: event.step }),
        status: 'interrupted',
      } as unknown as SessionEventDraft<E>);
    }

    drafts.push({
      type: 'turn.interrupted',
      turn,
      parent: turnId,
      reason,
    } as unknown as SessionEventDraft<E>);

    drafts.push({
      type: 'turn.finished',
      turn,
      id: turnId,
      status: 'interrupted',
    } as unknown as SessionEventDraft<E>);

    plans.push({
      turn,
      turnId,
      danglingSpanIds,
      danglingActionIds,
      danglingStepIds,
      danglingTaskRunIds,
    });
  }

  return { plans, drafts };
}

/** Analyze a timeline tail and summarize repair work and dangling task runs. */
export function analyzeTailRepair<E extends SessionEventBase>(
  events: readonly E[],
  options?: { reason?: 'shutdown' | 'fork' },
): TailRepairPlan<E> {
  const { plans, drafts } = repairInterruptedTail(events, options);
  const danglingTaskRunIds: string[] = [];
  for (const plan of plans) {
    danglingTaskRunIds.push(...plan.danglingTaskRunIds);
  }
  return {
    plans,
    danglingTaskRunIds,
    drafts,
    hasDanglingWork: plans.length > 0,
  };
}

function eventToDraft<E extends SessionEventBase>(event: E): SessionEventDraft<E> {
  const { seq: _seq, at: _at, ...rest } = event as Record<string, unknown>;
  return rest as unknown as SessionEventDraft<E>;
}

/**
 * Slice a timeline prefix up to `upToSeq` and synthesize closing drafts for
 * any turns that were still open at that cut point.
 */
export function buildForkSeed<E extends SessionEventBase>(
  events: readonly E[],
  upToSeq?: number,
): {
  prefix: E[];
  closers: SessionEventDraft<E>[];
  seed: SessionEventDraft<E>[];
  inheritedSeq: number;
  plans: DanglingTurnRepair[];
} {
  const prefix = upToSeq === undefined
    ? [...events]
    : events.filter((event) => event.seq <= upToSeq);
  const inheritedSeq = prefix.length > 0 ? prefix[prefix.length - 1]!.seq : 0;
  const { plans, drafts: closers } = repairInterruptedTail(prefix, { reason: 'fork' });
  const seed = [...prefix.map(eventToDraft), ...closers];
  return {
    prefix,
    closers,
    seed,
    inheritedSeq,
    plans,
  };
}
