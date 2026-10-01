import { formatDivider } from '@/renderer/lib/format';
import type { TurnModel } from './types.js';

/** A divider is inserted once chat messages are this far apart. */
export const DIVIDER_GAP_MS = 15 * 60 * 1000;

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The stamp of a turn's last visible chat message: its final reply, the
 * terminal fallback shown when it ended without one, else its user message.
 */
function lastVisibleChatAt(turn: TurnModel): string {
  if (turn.final) return turn.final.at;
  if (turn.endedAt !== undefined) return turn.endedAt;
  return turn.user.at;
}

/**
 * Label for the divider before `turn`, or `undefined` when none belongs there.
 * A divider opens the conversation, then appears after a 15 minute gap or when
 * the local calendar day changes, measured from the previous turn's last
 * visible chat message. Invalid stamps never produce a divider.
 */
export function dividerBefore(previous: TurnModel | undefined, turn: TurnModel, now: number): string | undefined {
  const at = turn.user.at;
  if (previous === undefined) return formatDivider(at, now);
  const previousAt = Date.parse(lastVisibleChatAt(previous));
  const currentAt = Date.parse(at);
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) return undefined;
  if (currentAt - previousAt >= DIVIDER_GAP_MS) return formatDivider(at, now);
  if (startOfLocalDay(previousAt) !== startOfLocalDay(currentAt)) return formatDivider(at, now);
  return undefined;
}
