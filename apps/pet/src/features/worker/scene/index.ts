/**
 * Worker entity presenter (PixiJS via src/render).
 *
 * Assembles the worker node tree from pure sub-layers: sprite (drawPixelMascot),
 * client badge, tool cue, speech bubble, and the age/task label. Frame updates
 * recompute hover/passthrough, the phase animation frame, the activity/content
 * gesture shifts, and push updates to each sub-layer.
 *
 * Not wired into the production entry point or the Electron event loop.
 *
 * FU-002 / IU-002
 */

import type { RenderContainer, RenderPixel, RenderSurface } from '../../../render';
import { PixelBuilder } from '../../../render';
import type { Appearance, WorkerClient } from '../../../shared/snapshot';
import type { Phase } from '../../../shared/snapshot';
import { drawPixelMascot } from './skin-drawer';
import { drawClientBadge } from './badge';
import { ANIM_FRAME_MS, ACTIVITY_PULSE_MS, CONTENT_GESTURE_MS, activityPulseOffset, contentGestureShift } from './timing';
import {
  computeHitRegion,
  isHovering,
  isPassthrough,
  type PointerInput,
  type WorkerHitRegion,
} from './hit-regions';
import { createWorkerBubble, updateWorkerBubble, type WorkerBubbleNode, type WorkerBubbleState } from './bubble';
import { createWorkerLabel, resolveWorkerLabelText, updateWorkerLabel, type WorkerLabelNode, type WorkerLabelState } from './label';
import { createToolCue, updateToolCue, type ToolCueNode, type ToolCueState } from './tool-cue';

const BOX_W = 40;
const BOX_H = 44;
const HIT_H = 32;

/** Inputs into the worker presenter, all visual/transport-free. */
export interface WorkerNodeState {
  appearance: Appearance;
  phase: Phase;
  client: WorkerClient;
  sinceMs: number;
  toolCount: number;
  lastToolTs?: number;
  lastActivityTs?: number;
  lastContentTs?: number;
  startedAt: number;
  taskLabel?: string;
  taskId?: string;
  taskName?: string;
  bubble?: { text: string; untilMs: number };
}

export interface WorkerNodeViewport {
  /** Logical (unscaled) window width in CSS px. */
  width: number;
  /** Logical (unscaled) window height in CSS px. */
  height: number;
  /** Integer pixel scale. */
  scale: number;
}

export interface WorkerNodeOutput {
  /** Root container holding every layer. */
  root: RenderContainer;
  hitRegion: WorkerHitRegion;
  hovering: boolean;
  passthrough: boolean;
}

export interface WorkerScene {
  readonly root: RenderContainer;
  update(
    state: WorkerNodeState,
    pointer: PointerInput,
    dragging: boolean,
    viewport: WorkerNodeViewport,
    nowMs: number,
  ): WorkerNodeOutput;
  destroy(): void;
}

interface WorkerNodeLayers {
  root: RenderContainer;
  sprite: RenderPixel;
  badge: RenderPixel;
  toolCue: ToolCueNode;
  bubble: WorkerBubbleNode;
  label: WorkerLabelNode;
  /** Remembered worker logical top-left + scale for per-frame updates. */
  x: number;
  y: number;
  scale: number;
  /** Bubble reveal start timestamp (ms), reset when text changes. */
  bubbleRevealStartMs: number;
  bubbleText: string;
}

/**
 * Create the worker scene tree. Returns the root container plus handles.
 * `viewport` is the logical (unscaled) window size and integer scale.
 */
export function createWorkerScene(
  surface: RenderSurface,
  state: WorkerNodeState,
  pointer: PointerInput,
  dragging: boolean,
  viewport: WorkerNodeViewport,
): WorkerScene {
  const root = surface.createContainer();

  const sprite = surface.createPixel(new PixelBuilder(1, 1).build());
  const badge = surface.createPixel(new PixelBuilder(1, 1).build());
  const toolCueContainer = surface.createContainer();
  const bubbleContainer = surface.createContainer();
  const labelContainer = surface.createContainer();

  root.add(sprite);
  root.add(badge);
  root.add(toolCueContainer);
  root.add(bubbleContainer);
  root.add(labelContainer);

  const toolCue = createToolCue(toolCueContainer, surface);
  const bubble = createWorkerBubble(bubbleContainer, surface);
  const label = createWorkerLabel(labelContainer, surface);

  const x = Math.max(0, Math.floor((viewport.width - BOX_W) / 2));
  const y = Math.max(0, viewport.height - HIT_H);

  const layers: WorkerNodeLayers = {
    root,
    sprite,
    badge,
    toolCue,
    bubble,
    label,
    x,
    y,
    scale: viewport.scale,
    bubbleRevealStartMs: 0,
    bubbleText: '',
  };

  // Initial paint.
  const hitRegion = computeHitRegion(x, y, viewport.scale);
  const hovering = isHovering(hitRegion, pointer, dragging);
  const passthrough = isPassthrough(hovering, dragging);

  paintSprite(layers, state, 0, 0, 0);
  paintBadge(layers, state);

  let output: WorkerNodeOutput = {
    root,
    hitRegion,
    hovering,
    passthrough,
  };
  let destroyed = false;

  surface.root.add(root);

  return {
    root,
    update(nextState, nextPointer, nextDragging, nextViewport, nowMs) {
      output = updateWorkerSceneOutput(output, layers, nextState, nextPointer, nextDragging, nextViewport, nowMs);
      return output;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      safeRemove(surface, root);
      safeDestroy(root);
    },
  };
}

/**
 * Update the worker scene for the current frame. Mutates the sub-layer nodes
 * and returns refreshed hit/hover/passthrough output.
 */
function updateWorkerSceneOutput(
  node: WorkerNodeOutput,
  layers: WorkerNodeLayers,
  state: WorkerNodeState,
  pointer: PointerInput,
  dragging: boolean,
  viewport: WorkerNodeViewport,
  nowMs: number,
): WorkerNodeOutput {
  layers.x = Math.max(0, Math.floor((viewport.width - BOX_W) / 2));
  layers.y = Math.max(0, viewport.height - HIT_H);
  layers.scale = viewport.scale;

  const hitRegion = computeHitRegion(layers.x, layers.y, layers.scale);
  const hovering = isHovering(hitRegion, pointer, dragging);
  const passthrough = isPassthrough(hovering, dragging);

  // Phase-specific animation frame, activity bob, and content gesture shift.
  const elapsed = Math.max(0, nowMs - state.sinceMs);
  const frame = Math.floor(elapsed / ANIM_FRAME_MS);
  const activityOffset = activityPulseOffset(nowMs, state.lastActivityTs ?? state.lastToolTs);
  const workArmShift = contentGestureShift(nowMs, state.lastContentTs);

  paintSprite(layers, state, frame, activityOffset, workArmShift);

  // Tool cue: render at physical CSS scale. gx/gy and icon rects are
  // scaled by viewport scale so Pixi Text textures are at full resolution.
  updateToolCue(
    layers.toolCue,
    {
      toolCount: state.toolCount,
      lastToolTs: state.lastToolTs,
      hovered: hovering,
      skinId: state.appearance.skin.id,
      appearance: state.appearance,
    },
    Math.round((layers.x + 31) * layers.scale),
    Math.round((layers.y + (state.appearance.skin.id === 'classic-voxel-miner' ? 10 : 17)) * layers.scale),
    layers.scale,
    nowMs,
  );

  // Bubble.
  updateBubble(layers, state, nowMs);

  // Label.
  updateLabel(layers, state, viewport, nowMs, hovering);

  return {
    root: node.root,
    hitRegion,
    hovering,
    passthrough,
  };
}

// ─── Layer painters ─────────────────────────────────────────────────────

function paintSprite(
  layers: WorkerNodeLayers,
  state: WorkerNodeState,
  frame: number,
  activityOffset: number,
  workArmShift: number,
): void {
  const builder = new PixelBuilder(BOX_W, BOX_H);
  drawPixelMascot(builder, state.appearance, state.phase, frame, activityOffset, workArmShift);
  layers.sprite.setProgram(builder.build());
  layers.sprite.setScale(layers.scale);
  layers.sprite.setPosition(Math.round(layers.x * layers.scale), Math.round(layers.y * layers.scale));
}

function paintBadge(layers: WorkerNodeLayers, state: WorkerNodeState): void {
  const builder = new PixelBuilder(10, 10);
  drawClientBadge(builder, state.client, 0.9);
  layers.badge.setProgram(builder.build());
  layers.badge.setScale(layers.scale);
  layers.badge.setPosition(Math.round((layers.x + 29) * layers.scale), Math.round((layers.y + 2) * layers.scale));
}

function updateBubble(layers: WorkerNodeLayers, state: WorkerNodeState, nowMs: number): void {
  let bubbleState: WorkerBubbleState | undefined;
  if (state.bubble?.text) {
    if (state.bubble.text !== layers.bubbleText) {
      layers.bubbleText = state.bubble.text;
      layers.bubbleRevealStartMs = nowMs;
    }
    bubbleState = {
      text: state.bubble.text,
      untilMs: state.bubble.untilMs,
      revealStartMs: layers.bubbleRevealStartMs,
    };
  } else {
    layers.bubbleText = '';
  }

  const anchorX = Math.round((layers.x + 20) * layers.scale);
  const anchorY = Math.round(layers.y * layers.scale - 2);
  updateWorkerBubble(layers.bubble, bubbleState, anchorX, anchorY, nowMs);
}

function updateLabel(
  layers: WorkerNodeLayers,
  state: WorkerNodeState,
  viewport: WorkerNodeViewport,
  nowMs: number,
  hovering: boolean,
): void {
  const { kind, text } = resolveWorkerLabelText({
    hovering,
    taskName: state.taskName,
    taskLabel: state.taskLabel,
    taskId: state.taskId,
    startedAt: state.startedAt,
    nowMs,
  });

  const labelState: WorkerLabelState = {
    kind,
    windowWidth: viewport.width * viewport.scale,
    workerX: layers.x,
    workerY: layers.y,
    scale: layers.scale,
    labelWidth: 60,
    labelHeight: kind === 'task' ? 14 : 12,
    text,
  };
  updateWorkerLabel(layers.label, labelState);
}

function safeRemove(surface: RenderSurface, root: RenderContainer): void {
  try {
    surface.root.remove(root);
  } catch {
    // Surface may already be gone during page unload.
  }
}

function safeDestroy(root: RenderContainer): void {
  try {
    root.destroy();
  } catch {
    // Destroy remains best-effort during unload.
  }
}

// Re-export constants/helpers consumed by callers.
export { ANIM_FRAME_MS, ACTIVITY_PULSE_MS, CONTENT_GESTURE_MS, activityPulseOffset, contentGestureShift };
