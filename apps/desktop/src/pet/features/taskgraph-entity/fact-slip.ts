// ── Blueprint Wren paper-tag fact slip ───────────────────────────────
// Pure presentation helpers for the centered Lamplight paper tag. The only
// visible text is `${title} · ${done}/${total}`; when the revision-safe task
// counts are unavailable the tag shows just the title. Lifecycle prose is
// forbidden — state is communicated exclusively through the 2px stitch color.

export const WREN_FALLBACK_TITLE = '未命名任务图';

export interface WrenFactSlipCounts {
  done: number;
  total: number;
}

export interface WrenFactSlipInput {
  title?: string;
  counts?: WrenFactSlipCounts;
}

/**
 * Resolve the one-line paper-tag label.
 * - A missing/empty title falls back to 未命名任务图 (never the graph id).
 * - Counts render only when both are nonnegative safe integers; otherwise the
 *   title stands alone with no parentheses and no guessed number.
 */
export function wrenFactSlipLabel(input: WrenFactSlipInput): string {
  const title = input.title && input.title.length > 0 ? input.title : WREN_FALLBACK_TITLE;
  const counts = input.counts;
  if (
    counts &&
    Number.isSafeInteger(counts.total) && counts.total >= 0 &&
    Number.isSafeInteger(counts.done) && counts.done >= 0
  ) {
    return `${title} · ${counts.done}/${counts.total}`;
  }
  return title;
}

// ── Lifecycle stitch presentation ────────────────────────────────────
// State is carried by the stitch color alone. running/done use moss,
// created and manual pause use slate, error pause and error exit use
// terracotta; stale adds a dashed border and 65% opacity on top.

export type WrenStitchTone = 'moss' | 'slate' | 'terracotta';

export interface WrenStitchInput {
  state: 'created' | 'running' | 'paused';
  stale: boolean;
  exiting: boolean;
  terminal?: 'done' | 'cancelled';
  terminal_reason?: 'success' | 'node_failed' | 'cancelled';
  error_paused?: boolean;
}

export function wrenStitchTone(input: WrenStitchInput): WrenStitchTone {
  if (input.terminal === 'done') return 'moss';
  if (input.terminal === 'cancelled') {
    return input.terminal_reason === 'node_failed' ? 'terracotta' : 'slate';
  }
  if (input.state === 'running') return 'moss';
  if (input.state === 'paused') return input.error_paused ? 'terracotta' : 'slate';
  return 'slate'; // created
}

/** State classes applied to the paper tag element (stitch tone + stale). */
export function wrenStitchClasses(input: WrenStitchInput): string {
  const classes = [`stitch-${wrenStitchTone(input)}`];
  if (input.stale) classes.push('stale');
  return classes.join(' ');
}
