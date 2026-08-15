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

export type HouseHitTarget = 'house' | 'broadcast-close' | 'settings-btn' | 'stats-btn' | 'tips-card';

export interface HouseHitRect extends HouseRect {
  target: HouseHitTarget;
}

export const BUTTON_SIZE = 20;
export const BUTTON_GAP = 2;

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

export function settingsButtonRect(houseRect: HouseRect, _viewportWidth: number): HouseRect {
  return {
    x: houseRect.x + houseRect.width + 2,
    y: houseRect.y + houseRect.height - BUTTON_SIZE * 2 - BUTTON_GAP,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  };
}

export function statsButtonRect(houseRect: HouseRect, _viewportWidth: number): HouseRect {
  return {
    x: houseRect.x + houseRect.width + 2,
    y: houseRect.y + houseRect.height - BUTTON_SIZE,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  };
}

export function tipsCardRect(houseRect: HouseRect, tipsLayout?: { x: number; y: number; width: number; height: number }): HouseRect | undefined {
  return tipsLayout ? { x: tipsLayout.x, y: tipsLayout.y, width: tipsLayout.width, height: tipsLayout.height } : undefined;
}

export function rightEdgeButtonRects(houseRect: HouseRect, viewportWidth: number): { settings: HouseRect; stats: HouseRect } {
  const gap = 2;
  const size = BUTTON_SIZE;
  // Check if buttons would go off-screen on the right; if so, place them to the left of the house
  const rightEdge = houseRect.x + houseRect.width + gap + size;
  if (rightEdge > viewportWidth - 2) {
    // Flip: place buttons on the left of house
    return {
      settings: {
        x: houseRect.x - gap - size,
        y: houseRect.y + houseRect.height - size * 2 - gap,
        width: size,
        height: size,
      },
      stats: {
        x: houseRect.x - gap - size,
        y: houseRect.y + houseRect.height - size,
        width: size,
        height: size,
      },
    };
  }
  return {
    settings: {
      x: houseRect.x + houseRect.width + gap,
      y: houseRect.y + houseRect.height - size * 2 - gap,
      width: size,
      height: size,
    },
    stats: {
      x: houseRect.x + houseRect.width + gap,
      y: houseRect.y + houseRect.height - size,
      width: size,
      height: size,
    },
  };
}

export function collectHitRects(input: {
  houseRect: HouseRect;
  closeRect?: HouseRect;
  dragging: boolean;
  buttonsVisible?: boolean;
  settingsBtn?: HouseRect;
  statsBtn?: HouseRect;
  tipsCard?: HouseRect;
}): HouseHitRect[] {
  const rects: HouseHitRect[] = [];
  if (!input.dragging) rects.push(houseBodyRect(input.houseRect));
  if (input.closeRect) rects.push(closeTargetRect(input.closeRect));
  if (!input.dragging && input.buttonsVisible) {
    if (input.settingsBtn) rects.push({ ...input.settingsBtn, target: 'settings-btn' });
    if (input.statsBtn) rects.push({ ...input.statsBtn, target: 'stats-btn' });
  }
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
