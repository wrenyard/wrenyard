/**
 * Inclusive scaled worker AABB and the pure footline hit test.
 *
 * Domain-free: imports only src/render public types. No Electron or pixi.js.
 */

import type { RenderPoint } from '../../../render';

/** Logical worker sprite box and the visible (footline) hit height. */
export const WORKER_BOX_W = 40;
export const WORKER_HIT_H = 32;

/** A scaled axis-aligned bounding box expressed in screen/CSS pixels. */
export interface WorkerHitRegion {
  /** Left edge in CSS px (logical x × scale). */
  x: number;
  /** Top edge in CSS px (logical y × scale). */
  y: number;
  /** Width in CSS px (40 × scale). */
  width: number;
  /** Height in CSS px (32 × scale). */
  height: number;
}

/**
 * Compute the scaled worker hit region. `x`/`y` are the worker's logical
 * top-left (already centered/floored), `scale` is the integer pixel scale.
 */
export function computeHitRegion(
  x: number,
  y: number,
  scale: number,
): WorkerHitRegion {
  return {
    x: x * scale,
    y: y * scale,
    width: WORKER_BOX_W * scale,
    height: WORKER_HIT_H * scale,
  };
}

/**
 * Inclusive AABB test: returns true iff point is within the closed box.
 */
export function hitTest(
  region: WorkerHitRegion,
  point: RenderPoint,
): boolean {
  return (
    point.x >= region.x &&
    point.x <= region.x + region.width &&
    point.y >= region.y &&
    point.y <= region.y + region.height
  );
}
