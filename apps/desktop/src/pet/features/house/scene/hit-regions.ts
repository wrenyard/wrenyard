import type { RenderPoint } from '../../../render';

export interface HouseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointerInput extends RenderPoint {
  inside: boolean;
}

export type HouseHitTarget = 'house' | 'broadcast-close' | 'tips-card';

export interface HouseHitRect extends HouseRect {
  target: HouseHitTarget;
}

export function pointInRect(x: number, y: number, rect: HouseRect): boolean {
  return x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;
}

export function houseBodyRect(houseRect: HouseRect): HouseHitRect {
  return { ...houseRect, target: 'house' };
}

export function closeTargetRect(closeRect: HouseRect): HouseHitRect {
  return { ...closeRect, target: 'broadcast-close' };
}

export function tipsCardRect(houseRect: HouseRect, tipsLayout?: { x: number; y: number; width: number; height: number }): HouseRect | undefined {
  return tipsLayout ? { x: tipsLayout.x, y: tipsLayout.y, width: tipsLayout.width, height: tipsLayout.height } : undefined;
}

export function collectHitRects(input: {
  houseRect: HouseRect;
  closeRect?: HouseRect;
  dragging: boolean;
  tipsCard?: HouseRect;
}): HouseHitRect[] {
  const rects: HouseHitRect[] = [];
  if (!input.dragging) rects.push(houseBodyRect(input.houseRect));
  if (input.closeRect) rects.push(closeTargetRect(input.closeRect));
  if (!input.dragging && input.tipsCard) {
    rects.push({ ...input.tipsCard, target: 'tips-card' });
  }
  return rects;
}

export function hitTargetAt(rects: readonly HouseHitRect[], pointer: PointerInput): HouseHitTarget | undefined {
  if (!pointer.inside) return undefined;
  return rects.find((rect) => pointInRect(pointer.x, pointer.y, rect))?.target;
}

export function computePassthrough(pointer: PointerInput, rects: readonly HouseHitRect[]): boolean {
  if (!pointer.inside) return true;
  return rects.every((rect) => !pointInRect(pointer.x, pointer.y, rect));
}

export function isOverHouseBody(pointer: PointerInput, houseAABB: HouseRect): boolean {
  return pointer.inside && pointInRect(pointer.x, pointer.y, houseAABB);
}

export function isPassthrough(input: {
  hitRects: readonly HouseHitRect[];
  pointer: PointerInput;
  dragging: boolean;
}): boolean {
  if (input.dragging) return false;
  return computePassthrough(input.pointer, input.hitRects);
}
