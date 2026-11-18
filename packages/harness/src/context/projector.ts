/**
 * `@wrenyard/session` projector adapter over the harness XML prompt renderer.
 *
 * Projects surface events (`CONTEXT_EVENT_TYPES`), applies compaction horizon
 * replacements (`context.compacted` replacing `[1..throughSeq]`), and preserves
 * `context.reduced` floor inspection from the full timeline.
 */

import type { Projector } from '@wrenyard/session';
import { CONTEXT_EVENT_TYPES, type LedgerEvent } from '../events.ts';
import type { BuiltView } from '../ports.ts';
import { buildReason, latestReduction, type ReasonViewInput } from './prompt.ts';

export type ReasoningProjectorInput = Omit<ReasonViewInput, 'events' | 'reducedThroughSeq'> & {
  id?: string;
};

/** Build a cached `@wrenyard/session` projector for one reasoning request view. */
export function createReasoningProjector(
  input: ReasoningProjectorInput,
): Projector<LedgerEvent, BuiltView> {
  const id = input.id ?? [
    'reasoning',
    input.session.turn,
    input.session.step,
    input.session.model,
    input.allowImages === false ? '0' : '1',
    input.systemOverride === undefined ? 'default' : 'override',
  ].join(':');
  return {
    id,
    isSurfaceEvent: (event) => CONTEXT_EVENT_TYPES.has(event.type),
    replaceRange: (event) => (event.type === 'context.compacted'
      ? { startSeq: 1, endSeq: event.throughSeq }
      : undefined),
    fold: (activeEvents, allEvents) => buildReason({
      ...input,
      events: [...activeEvents],
      reducedThroughSeq: latestReduction(allEvents)?.throughSeq,
    }),
  };
}
