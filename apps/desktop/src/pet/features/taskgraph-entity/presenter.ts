// ── Blueprint Wren entity presenter ─────────────────────────────────
// Small deterministic presenter surface for the entity input loop.

import type { RenderSurface } from '../../render';
import { createWrenScene, type WrenOutput, type WrenScene, WREN_W, WREN_H } from './scene';
import type { TaskGraphEntityDtoWithPresentation } from '../../shared/taskgraph';

export interface WrenEntityPresenter {
  setDto(dto: TaskGraphEntityDtoWithPresentation, nowMs?: number): WrenOutput | undefined;
  updatePose(
    id: string,
    state: string,
    stale: boolean,
    exiting: boolean,
    nowMs: number,
    lifecycle?: {
      terminal?: 'done' | 'cancelled';
      terminalReason?: 'success' | 'node_failed' | 'cancelled';
      errorPaused?: boolean;
      motion?: 'full' | 'reduced';
    },
  ): WrenOutput['clickRect'];
  /** Move the whole bird sprite to the owner-provided placement, in CSS px. */
  setPosition(x: number, y: number): void;
  destroy(): void;
}

export function createWrenEntityPresenter(surface: RenderSurface): WrenEntityPresenter {
  let scene: WrenScene | undefined;

  function ensureScene(): WrenScene {
    if (!scene) {
      scene = createWrenScene(surface);
    }
    return scene;
  }

  function setDto(dto: TaskGraphEntityDtoWithPresentation, nowMs: number = Date.now()): WrenOutput | undefined {
    const s = ensureScene();
    const output = s.update(dto, nowMs);
    surface.render();
    return output;
  }

  function updatePose(
    id: string,
    state: string,
    stale: boolean,
    exiting: boolean,
    nowMs: number,
    lifecycle?: {
      terminal?: 'done' | 'cancelled';
      terminalReason?: 'success' | 'node_failed' | 'cancelled';
      errorPaused?: boolean;
      motion?: 'full' | 'reduced';
    },
  ): WrenOutput['clickRect'] {
    const dto: TaskGraphEntityDtoWithPresentation = {
      id,
      state: (state === 'running' || state === 'paused' || state === 'created' ? state : 'paused') as 'created' | 'running' | 'paused',
      revision: 0,
      created_at: '',
      presentation: exiting ? 'exiting' : stale ? 'stale' : undefined,
    };
    if (lifecycle?.terminal !== undefined) dto.terminal = lifecycle.terminal;
    if (lifecycle?.terminalReason !== undefined) dto.terminal_reason = lifecycle.terminalReason;
    if (lifecycle?.errorPaused !== undefined) dto.error_paused = lifecycle.errorPaused;
    if (lifecycle?.motion !== undefined) dto.motion = lifecycle.motion;
    const s = ensureScene();
    const output = s.update(dto, nowMs);
    surface.render();
    return output.clickRect;
  }

  function destroy(): void {
    scene?.destroy();
    scene = undefined;
  }

  function setPosition(x: number, y: number): void {
    ensureScene().root.setPosition(x, y);
  }

  return { setDto, updatePose, setPosition, destroy };
}

// ── Fact-slip presentation helpers ───────────────────────────────────
// Pure text/tone helpers for the React {@link EntityOverlay} paper tag. The
// only visible text is `${title} · ${done}/${total}`; when the revision-safe
// counts are unavailable the tag shows just the title. Lifecycle prose is
// forbidden — state is communicated exclusively through the stitch color.

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

/** Shared theme token class used for the paper-tag stitch (state by color only). */
export function wrenStitchTokenClass(input: WrenStitchInput): string {
  const tone = wrenStitchTone(input);
  if (tone === 'moss') return 'text-success';
  if (tone === 'terracotta') return 'text-destructive';
  return 'text-muted-foreground';
}

/** Legacy class string kept for the taskgraph e2e capture selectors. */
export function wrenStitchClasses(input: WrenStitchInput): string {
  const classes = [`stitch-${wrenStitchTone(input)}`];
  if (input.stale) classes.push('stale');
  return classes.join(' ');
}
