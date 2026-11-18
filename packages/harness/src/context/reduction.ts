/**
 * Session context reduction: release the bulky content of cold, older context
 * events programmatically so the next reasoning request fits without a summary
 * call.
 */
import { estimateTokens } from '@wrenyard/ai';
import { CONTEXT_EVENT_TYPES, type LedgerEvent } from '../events.ts';
import { renderCompactionBlock } from './compaction.ts';
import { renderEventText } from './render.ts';

/** Share of the threshold the hot zone may occupy. */
const HOT_SHARE = 0.25;

/** One reduction: the floor it renders from and what it released. */
export interface ReductionPlan {
  throughSeq: number;
  releasedTokens?: number;
}

export function computeReduction(
  events: readonly LedgerEvent[],
  threshold: number,
): ReductionPlan | undefined {
  if (threshold <= 0) return undefined;
  const floor = previousFloor(events);
  const contextEvents = events.filter(
    (event) => event.seq > floor && CONTEXT_EVENT_TYPES.has(event.type),
  );
  if (contextEvents.length === 0) return undefined;

  const renderFull = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event) ?? '');
  const renderReduced = (event: LedgerEvent): string => (event.type === 'context.compacted'
    ? renderCompactionBlock(event)
    : renderEventText(event, { reduced: true }) ?? '');

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

function previousFloor(events: readonly LedgerEvent[]): number {
  let floor = 0;
  for (const event of events) {
    if (event.type !== 'context.compacted' && event.type !== 'context.reduced') continue;
    if (event.throughSeq > floor) floor = event.throughSeq;
  }
  return floor;
}

function isStepBoundary(event: LedgerEvent): boolean {
  return event.type === 'step.started' || event.type === 'turn.started';
}

export function hotZoneStart(
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

  for (let index = start; index < events.length; index += 1) {
    if (!isStepBoundary(events[index]!)) continue;
    start = index;
    break;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type !== 'turn.started') continue;
    if (start > index) start = index;
    break;
  }

  for (const pair of actionPairs(events)) {
    if (pair.start >= start) continue;
    if (pair.finish !== undefined && pair.finish < start) continue;
    start = Math.min(start, stepBoundaryAtOrBefore(events, pair.start));
  }
  return start;
}

function stepBoundaryAtOrBefore(events: readonly LedgerEvent[], index: number): number {
  for (let at = index; at >= 0; at -= 1) {
    if (isStepBoundary(events[at]!)) return at;
  }
  return index;
}

interface ActionPair {
  start: number;
  finish?: number;
}

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

function occurrenceKey(id: string, turn: number | undefined, step: number | undefined): string | undefined {
  return typeof turn === 'number' && typeof step === 'number' ? `${id}:${turn}:${step}` : undefined;
}
