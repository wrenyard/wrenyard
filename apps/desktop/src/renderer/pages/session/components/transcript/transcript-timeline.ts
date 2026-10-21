/**
 * Timeline model of the session transcript: the chronological entries of one
 * folded turn, kept apart from the component that renders them.
 */
import { isHiddenCallRole, isHiddenContextSource } from '../../model/describe.js';
import type { ActionModel, ActivityItem, CallModel, ErrorItem, ReplyModel, TurnModel } from '../../model/types.js';
import type { GroupActivityItem } from './ActivityGroup.js';

function parseStamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A call belongs to an action when its parent or id prefix names that action. */
function attachedToAction(call: CallModel, actions: readonly ActionModel[]): boolean {
  return actions.some((action) => call.parent === action.id || call.id.startsWith(`${action.id}.`));
}

export type TranscriptEntry =
  | { kind: 'activity'; item: GroupActivityItem }
  | { kind: 'reply'; reply: ReplyModel }
  | { kind: 'error'; error: ErrorItem };

/** Engine-internal calls and context sources stay out of the transcript. */
function visibleActivityItem(item: ActivityItem): GroupActivityItem | undefined {
  switch (item.kind) {
    case 'call':
      if (isHiddenCallRole(item.call.role)) return undefined;
      break;
    case 'context':
      if (isHiddenContextSource(item.item.source)) return undefined;
      break;
    default:
      break;
  }
  return item;
}

/** Cycle errors that only reflect failed engine auxiliaries stay in the trace view. */
function omitTranscriptError(turn: TurnModel, error: ErrorItem): boolean {
  const cycle = error.cycle;
  if (cycle === undefined) return false;
  const failedCalls = turn.calls.filter((call) => call.cycle === cycle && call.status === 'failed');
  if (failedCalls.length === 0) return false;
  return failedCalls.every((call) => isHiddenCallRole(call.role));
}

/** Chronological entries of a turn: activity items, prose replies and errors. */
export function transcriptEntries(turn: TurnModel): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const turnCalls = turn.calls.filter(
    (call) => (call.cycle === undefined || call.cycle === 0)
      && call.role !== 'reason'
      && !isHiddenCallRole(call.role)
      && !attachedToAction(call, turn.actions),
  );
  const firstCycleStart = turn.cycles[0]?.startedAt;
  const beforeFirstCycle = (call: CallModel): boolean => firstCycleStart === undefined
    || parseStamp(call.startedAt) < parseStamp(firstCycleStart);
  for (const call of turnCalls.filter(beforeFirstCycle)) {
    const item = visibleActivityItem({ kind: 'call', call });
    if (item !== undefined) entries.push({ kind: 'activity', item });
  }

  for (const cycle of turn.cycles) {
    for (const item of cycle.context.filter((context) => context.actionId === undefined)) {
      const activity = visibleActivityItem({ kind: 'context', item });
      if (activity !== undefined) entries.push({ kind: 'activity', item: activity });
    }
    const inCycle: { at: string; item: ActivityItem }[] = [];
    const reasoning = turn.calls.find((call) => call.role === 'reason' && call.cycle === cycle.index);
    if (reasoning !== undefined) {
      inCycle.push({
        at: reasoning.startedAt,
        item: { kind: 'reason', call: reasoning, reasoning: cycle.reasoning },
      });
    }
    const standalone = turn.calls.filter(
      (call) => call.cycle === cycle.index
        && call.role !== 'reason'
        && !isHiddenCallRole(call.role)
        && !attachedToAction(call, turn.actions),
    );
    for (const call of standalone) {
      inCycle.push({ at: call.startedAt, item: { kind: 'call', call } });
    }
    const actions = cycle.actionIds
      .map((id) => turn.actions.find((action) => action.id === id))
      .filter((action): action is ActionModel => action !== undefined);
    for (const action of actions) {
      const calls = turn.calls.filter(
        (call) => (call.parent === action.id || call.id.startsWith(`${action.id}.`))
          && !isHiddenCallRole(call.role),
      );
      inCycle.push({ at: action.startedAt, item: { kind: 'action', action, calls } });
    }
    inCycle.sort((a, b) => parseStamp(a.at) - parseStamp(b.at));
    for (const entry of inCycle) {
      const item = visibleActivityItem(entry.item);
      if (item !== undefined) entries.push({ kind: 'activity', item });
    }
    for (const error of cycle.errors) {
      if (!omitTranscriptError(turn, error)) entries.push({ kind: 'error', error });
    }
    for (const reply of turn.replies.filter((reply) => reply.cycle === cycle.index)) {
      entries.push({ kind: 'reply', reply });
    }
  }

  for (const call of turnCalls.filter((call) => !beforeFirstCycle(call))) {
    const item = visibleActivityItem({ kind: 'call', call });
    if (item !== undefined) entries.push({ kind: 'activity', item });
  }
  const cycleIndices = new Set(turn.cycles.map((cycle) => cycle.index));
  for (const reply of turn.replies.filter((reply) => reply.cycle === undefined || !cycleIndices.has(reply.cycle))) {
    entries.push({ kind: 'reply', reply });
  }
  for (const error of turn.errors.filter((error) => error.cycle === undefined)) {
    entries.push({ kind: 'error', error });
  }
  return entries;
}

/** A user message on the timeline, placed at the moment it was sent. */
export interface TimelineUser {
  kind: 'user';
  turn: TurnModel;
  at: number;
}

/** One stretch of agent work, closed by the reply that ends it. */
export interface TimelineBlock {
  kind: 'block';
  turn: TurnModel;
  /** 0-based ordinal of the block within its turn; stable because blocks only append. */
  index: number;
  /** Entries of the block in order; when `reply` is set it is also the last entry. */
  entries: TranscriptEntry[];
  /** The reply that closed the block, absent for an open block or a reply-less tail. */
  reply?: ReplyModel;
  /** True for the running turn's last, unclosed block. */
  open: boolean;
  /** Show the one-line quote of the turn's user message above the block. */
  quote: boolean;
  /** Closing time for a finished block, start time for an open block (ms). */
  at: number;
}

export type TimelineItem = TimelineUser | TimelineBlock;

/** Turn ids order as strings, so the timeline does not depend on the id type. */
function compareTurnId(a: number, b: number): number {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The transcript as one timeline: user messages and finished blocks placed by
 * time, plus the still open blocks of running turns, rendered last.
 */
export function transcriptTimeline(
  turns: readonly TurnModel[],
  hasPending: boolean,
): { timeline: TimelineItem[]; open: TimelineBlock[] } {
  const timeline: TimelineItem[] = [];
  const open: TimelineBlock[] = [];

  for (const turn of turns) {
    timeline.push({ kind: 'user', turn, at: parseStamp(turn.user.at) });
    const finished: TimelineBlock[] = [];
    let entries: TranscriptEntry[] = [];
    let start = parseStamp(turn.user.at);
    for (const entry of transcriptEntries(turn)) {
      entries.push(entry);
      if (entry.kind !== 'reply') continue;
      finished.push({
        kind: 'block',
        turn,
        index: finished.length,
        entries,
        reply: entry.reply,
        open: false,
        quote: false,
        at: parseStamp(entry.reply.at),
      });
      start = parseStamp(entry.reply.at);
      entries = [];
    }
    if (turn.status === 'running') {
      open.push({
        kind: 'block',
        turn,
        index: finished.length,
        entries,
        open: true,
        quote: false,
        at: start,
      });
    } else if (entries.length > 0) {
      finished.push({
        kind: 'block',
        turn,
        index: finished.length,
        entries,
        open: false,
        quote: false,
        at: parseStamp(turn.endedAt ?? turn.startedAt),
      });
    }
    for (const block of finished) timeline.push(block);
  }

  timeline.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    const byId = compareTurnId(a.turn.id, b.turn.id);
    if (byId !== 0) return byId;
    if (a.kind === b.kind) return 0;
    return a.kind === 'user' ? -1 : 1;
  });
  open.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    return compareTurnId(a.turn.id, b.turn.id);
  });

  let latestUser: number | undefined;
  let previous: number | undefined;
  for (const item of timeline) {
    if (item.kind === 'user') {
      latestUser = item.turn.id;
      previous = item.turn.id;
      continue;
    }
    item.quote = item.turn.id !== latestUser && item.turn.id !== previous;
    previous = item.turn.id;
  }
  if (hasPending) {
    latestUser = undefined;
    previous = undefined;
  }
  for (const block of open) {
    block.quote = block.turn.id !== latestUser && block.turn.id !== previous;
    previous = block.turn.id;
  }

  return { timeline, open };
}
