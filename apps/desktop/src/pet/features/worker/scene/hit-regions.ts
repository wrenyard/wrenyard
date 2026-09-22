/**
 * Inclusive 40x32 scaled worker AABB and pure hit/visibility helpers.
 *
 * Domain-free: imports only src/render public types. No Electron or pixi.js.
 *
 * FU-002 / IU-002
 */

import type { RenderPoint } from '../../../render';

/** Logical worker sprite box and the visible (footline) hit height. */
export const WORKER_BOX_W = 40;
export const WORKER_BOX_H = 44;
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

/** Visual pointer state used for hover targeting. */
export interface PointerInput {
  /** Pointer x in CSS px. */
  x: number;
  /** Pointer y in CSS px. */
  y: number;
  /** Whether the pointer is currently inside the window. */
  inside: boolean;
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

/**
 * Whether the worker body is hovered. Hover requires the pointer to be inside
 * the window, not currently dragging, and to fall within the inclusive
 * worker hit region.
 */
export function isHovering(
  region: WorkerHitRegion,
  pointer: PointerInput,
  dragging: boolean,
): boolean {
  if (dragging || !pointer.inside) return false;
  return hitTest(region, { x: pointer.x, y: pointer.y });
}

/**
 * Mouse passthrough: true when the worker is neither hovered nor being
 * dragged, so window mouse events fall through to the page beneath.
 */
export function isPassthrough(hovering: boolean, dragging: boolean): boolean {
  return !hovering && !dragging;
}
