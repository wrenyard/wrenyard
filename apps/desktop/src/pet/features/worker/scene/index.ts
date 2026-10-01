/**
 * Worker sprite scene (PixiJS via src/render).
 *
 * Art only: the mascot pixel sprite plus its animation frames and the
 * footline hit region used by the React overlay for drag targeting. Speech
 * bubbles, labels, tool cues and client badges are React DOM
 * ({@link WorkerOverlay}).
 */

import type { RenderContainer, RenderPixel, RenderSurface } from '../../../render';
import { PixelBuilder } from '../../../render';
import type { Appearance, WorkerClient } from '../../../shared/snapshot';
import type { Phase } from '../../../shared/snapshot';
import { drawPixelMascot } from './skin-drawer';
import { ANIM_FRAME_MS, ACTIVITY_PULSE_MS, CONTENT_GESTURE_MS, activityPulseOffset, contentGestureShift } from './timing';
import {
  computeHitRegion,
  type WorkerHitRegion,
} from './hit-regions';

const BOX_W = 40;
const BOX_H = 44;
const HIT_H = 32;

/** Inputs into the worker sprite scene, all visual/transport-free. */
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
  /** Root container holding the sprite. */
  root: RenderContainer;
  hitRegion: WorkerHitRegion;
}

export interface WorkerScene {
  readonly root: RenderContainer;
  update(
    state: WorkerNodeState,
    viewport: WorkerNodeViewport,
    nowMs: number,
  ): WorkerNodeOutput;
  destroy(): void;
}

interface WorkerNodeLayers {
  root: RenderContainer;
  sprite: RenderPixel;
  x: number;
  y: number;
  scale: number;
}

/**
 * Create the worker sprite scene tree. Returns the root container plus handles.
 * `viewport` is the logical (unscaled) window size and integer scale.
 */
export function createWorkerScene(
  surface: RenderSurface,
  state: WorkerNodeState,
  viewport: WorkerNodeViewport,
): WorkerScene {
  const root = surface.createContainer();
  const sprite = surface.createPixel(new PixelBuilder(1, 1).build());
  root.add(sprite);

  const x = Math.max(0, Math.floor((viewport.width - BOX_W) / 2));
  const y = Math.max(0, viewport.height - HIT_H);

  const layers: WorkerNodeLayers = {
    root,
    sprite,
    x,
    y,
    scale: viewport.scale,
  };

  paintSprite(layers, state, 0, 0, 0);

  let output: WorkerNodeOutput = {
    root,
    hitRegion: computeHitRegion(x, y, viewport.scale),
  };
  let destroyed = false;

  surface.root.add(root);

  return {
    root,
    update(nextState, nextViewport, nowMs) {
      layers.x = Math.max(0, Math.floor((nextViewport.width - BOX_W) / 2));
      layers.y = Math.max(0, nextViewport.height - HIT_H);
      layers.scale = nextViewport.scale;

      const elapsed = Math.max(0, nowMs - nextState.sinceMs);
      const frame = Math.floor(elapsed / ANIM_FRAME_MS);
      const activityOffset = activityPulseOffset(nowMs, nextState.lastActivityTs ?? nextState.lastToolTs);
      const workArmShift = contentGestureShift(nowMs, nextState.lastContentTs);

      paintSprite(layers, nextState, frame, activityOffset, workArmShift);

      output = {
        root,
        hitRegion: computeHitRegion(layers.x, layers.y, layers.scale),
      };
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
