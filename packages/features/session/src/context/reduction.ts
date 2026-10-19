/**
 * session context reduction: release the bulky content of cold, older context
 * events programmatically so the next reasoning request fits without a summary
 * call.
 *
 * The timeline splits in two at a step boundary. The hot zone — the current
 * turn plus the most recent earlier steps whose rendered size fits in a quarter
 * of the threshold — is never reduced. Everything older, back to the current
 * floor, is the cold zone: it renders in the reduced form of `render.ts`, which
 * cuts long texts and results to head plus tail and replaces documents,
 * memories and attachments with stubs.
 *
 * This module is pure and deterministic: it reads the timeline, measures
 * rendered sizes with the same tokenizer the request uses, and never calls a
 * model, never writes the ledger and never depends on wall-clock state.
 */
import { CONTEXT_EVENT_TYPES, type LedgerEvent } from '../ledger/store.ts';
import { estimateTokens } from '../model/request.ts';
import { renderCompactionBlock } from './compaction.ts';
import { renderEventText, resumedOriginalTurns } from './render.ts';

/** Share of the threshold the hot zone may occupy. */
const HOT_SHARE = 0.25;

/** One reduction: the floor it renders from and what it released. */
export interface ReductionPlan {
  /** Highest ledger sequence rendered in reduced form from now on. */
  throughSeq: number;
  /** Tokens the reduction releases; absent when the estimate is unknown. */
  releasedTokens?: number;
}

/**
 * Plan one reduction of `events`, or `undefined` when there is nothing to
 * release: no cold event, no floor to advance, or a reduction that would free
 * nothing.
 */
export function computeReduction(
  events: readonly LedgerEvent[],
  threshold: number,
): ReductionPlan | undefined {
  if (threshold <= 0) return undefined;
  // The cold zone starts above every floor already recorded, so a reduction
  // never re-releases what an earlier reduction or summary already bounded.
  const floor = previousFloor(events);
  const resumedTurns = resumedOriginalTurns(events);
  const contextEvents = events.filter(
    (event) => event.seq > floor && CONTEXT_EVENT_TYPES.has(event.type),
  );
  if (contextEvents.length === 0) return undefined;

  const renderFull = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event, resumedTurns) ?? '');
  const renderReduced = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event, resumedTurns, { reduced: true }) ?? '');

  const hotStart = hotZoneStart(contextEvents, (event) => estimateTokens(renderFull(event)), Math.floor(HOT_SHARE * threshold));
  if (hotStart <= 0) return undefined;

  const cold = contextEvents.slice(0, hotStart);
  const throughSeq = cold[cold.length - 1]!.seq;
  let released = 0;
  for (const event of cold) {
    released += estimateTokens(renderFull(event)) - estimateTokens(renderReduced(event));
  }
  if (throughSeq <= floor || released <= 0) return undefined;
  return { throughSeq, releasedTokens: released };
}

/** The highest sequence an earlier compaction or reduction already covered. */
function previousFloor(events: readonly LedgerEvent[]): number {
  let floor = 0;
  for (const event of events) {
    if (event.type !== 'context.compacted' && event.type !== 'context.reduced') continue;
    if (event.throughSeq > floor) floor = event.throughSeq;
  }
  return floor;
}

/** True for the events a reduction boundary may fall on. */
function isStepBoundary(event: LedgerEvent): boolean {
  return event.type === 'step.started' || event.type === 'turn.started';
}

/**
 * The index the hot zone starts at: the newest suffix whose rendered size fits
 * the budget, aligned to the start of a step, widened to hold the whole current
 * turn and never splitting an action from its result.
 */
function hotZoneStart(
  events: readonly LedgerEvent[],
  size: (event: LedgerEvent) => number,
  budget: number,
): number {
  let start = events.length;
  let total = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const next = size(events[index]!);
    if (total + next > budget) break;
    total += next;
    start = index;
  }

  // The boundary is the start of a step, never the middle of one.
  for (let index = start; index < events.length; index += 1) {
    if (!isStepBoundary(events[index]!)) continue;
    start = index;
    break;
  }
  // The current turn is hot in full: its own start is the latest boundary the
  // reduced zone may reach.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type !== 'turn.started') continue;
    if (start > index) start = index;
    break;
  }

  // An action is never separated from its result, and an action that has not
  // finished is hot: the boundary moves back to the start of the step that
  // started it. Pairs are visited newest first, so one pass settles it.
  for (const pair of actionPairs(events)) {
    if (pair.start >= start) continue;
    if (pair.finish !== undefined && pair.finish < start) continue;
    start = Math.min(start, stepBoundaryAtOrBefore(events, pair.start));
  }
  return start;
}

/** The nearest step or turn start at or before `index`; `index` itself if none. */
function stepBoundaryAtOrBefore(events: readonly LedgerEvent[], index: number): number {
  for (let at = index; at >= 0; at -= 1) {
    if (isStepBoundary(events[at]!)) return at;
  }
  return index;
}

interface ActionPair {
  start: number;
  /** Absent when the action never finished. */
  finish?: number;
}

/** One action.started and its action.finished, newest start first. */
function actionPairs(events: readonly LedgerEvent[]): ActionPair[] {
  const pending = new Map<string, number[]>();
  const byStart = new Map<number, ActionPair>();
  const pairs: ActionPair[] = [];
  events.forEach((event, index) => {
    if (event.type === 'action.started') {
      const pair: ActionPair = { start: index };
      pairs.push(pair);
      const key = occurrenceKey(event.id, event.turn, event.step);
      if (key === undefined) return;
      byStart.set(index, pair);
      pending.set(key, [...(pending.get(key) ?? []), index]);
    } else if (event.type === 'action.finished') {
      const key = occurrenceKey(event.id, event.turn, event.step);
      if (key === undefined) return;
      const start = pending.get(key)?.shift();
      if (start === undefined) return;
      const pair = byStart.get(start);
      if (pair !== undefined) pair.finish = index;
    }
  });
  return pairs.sort((left, right) => right.start - left.start);
}

/** A start and its finish pair by the same id inside the same turn and step. */
function occurrenceKey(id: string, turn: number | undefined, step: number | undefined): string | undefined {
  return typeof turn === 'number' && typeof step === 'number' ? `${id}:${turn}:${step}` : undefined;
}
