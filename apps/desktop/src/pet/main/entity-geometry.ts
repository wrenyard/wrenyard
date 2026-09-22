import { DisplayLike, DisplayRect, resolveDisplay } from './display-placement';
import {
  WORKER_SPRITE_W,
  WORKER_VISIBLE_H,
  WORKER_WINDOW_TOP_PADDING,
} from '../shared/worker-metrics';

export interface EntitySize {
  width: number;
  height: number;
}

export interface EntityPoint {
  x: number;
  y: number;
}

export interface SavedHousePosition {
  displayId?: number;
  x?: number;
  y?: number;
  /** V3 visible-house anchor. Legacy x/y remain the carrier origin. */
  entityX?: number;
  entityY?: number;
}

export interface ResolvedHousePlacement {
  display: DisplayLike;
  bounds: DisplayRect;
}

export interface ResolvedHouseCarrierPlacement extends ResolvedHousePlacement {
  /** Absolute bounds of the visible house sprite, used for drag clamping. */
  entityBounds: DisplayRect;
  /** Visible house origin inside the transparent carrier window. */
  entityOffset: EntityPoint;
}

const HOUSE_MARGIN = 24;
const WORKER_MARGIN = 8;
const SPAWN_ATTEMPTS = 32;
const HOUSE_NOTIFICATION_WIDTH = 360;
const HOUSE_NOTIFICATION_HEIGHT = 460;
const HOUSE_VISIBLE_WIDTH = 48;
const HOUSE_VISIBLE_HEIGHT = 40;

export function houseWindowSize(scale: number): EntitySize {
  return {
    width: Math.max(HOUSE_NOTIFICATION_WIDTH, Math.round(48 * scale)),
    height: Math.max(HOUSE_NOTIFICATION_HEIGHT, Math.round(40 * scale)),
  };
}

export function houseEntitySize(scale: number): EntitySize {
  return {
    width: Math.round(HOUSE_VISIBLE_WIDTH * scale),
    height: Math.round(HOUSE_VISIBLE_HEIGHT * scale),
  };
}

/**
 * Resolve the transparent carrier around the visible house. The carrier is
 * kept inside the work area, but only the visible house is clamped. Near an
 * edge the house slides inside the carrier so transparent notification space
 * never blocks the user from reaching that edge.
 */
export function resolveHouseCarrierPlacement(
  displays: readonly DisplayLike[],
  primaryDisplay: DisplayLike,
  saved: SavedHousePosition | undefined,
  scale: number,
  bottomOffset = 0,
): ResolvedHouseCarrierPlacement {
  const display = resolveDisplay(displays, primaryDisplay, saved?.displayId);
  const carrierSize = houseWindowSize(scale);
  const entitySize = houseEntitySize(scale);
  const hasEntityPoint = Number.isFinite(saved?.entityX) && Number.isFinite(saved?.entityY);

  if (hasEntityPoint) {
    return placeHouseCarrier(
      { x: saved!.entityX!, y: saved!.entityY! },
      display,
      scale,
    );
  }

  // Preserve V2 positions: x/y described the carrier origin, with the house
  // centered horizontally and pinned to its bottom edge.
  const legacy = resolveHousePlacement(displays, primaryDisplay, saved, carrierSize, bottomOffset);
  const defaultOffset = defaultHouseEntityOffset(carrierSize, entitySize);
  return placeHouseCarrier(
    {
      x: legacy.bounds.x + defaultOffset.x,
      y: legacy.bounds.y + defaultOffset.y,
    },
    legacy.display,
    scale,
  );
}

export function placeHouseCarrier(
  desiredEntityPoint: EntityPoint,
  display: DisplayLike,
  scale: number,
): ResolvedHouseCarrierPlacement {
  const carrierSize = houseWindowSize(scale);
  const entitySize = houseEntitySize(scale);
  const entityBounds = clampRectToRect(
    { ...desiredEntityPoint, ...entitySize },
    display.workArea,
  );
  const defaultOffset = defaultHouseEntityOffset(carrierSize, entitySize);
  const carrierBounds = clampRectToRect(
    {
      x: entityBounds.x - defaultOffset.x,
      y: resolveHouseCarrierY(entityBounds, carrierSize, display.workArea),
      ...carrierSize,
    },
    display.workArea,
  );

  return {
    display,
    bounds: carrierBounds,
    entityBounds,
    entityOffset: {
      x: entityBounds.x - carrierBounds.x,
      y: entityBounds.y - carrierBounds.y,
    },
  };
}

function resolveHouseCarrierY(
  entityBounds: DisplayRect,
  carrierSize: EntitySize,
  workArea: DisplayRect,
): number {
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - carrierSize.height;
  const aboveY = entityBounds.y - (carrierSize.height - entityBounds.height);
  if (aboveY >= minY && aboveY <= maxY) return aboveY;

  // Near the top edge, put the visible house at the carrier top so Tips can
  // flip below it instead of overlapping the house or extending off-screen.
  const belowY = entityBounds.y;
  if (belowY >= minY && belowY <= maxY) return belowY;
  return clamp(aboveY, minY, Math.max(minY, maxY));
}

function defaultHouseEntityOffset(carrierSize: EntitySize, entitySize: EntitySize): EntityPoint {
  return {
    x: Math.max(0, Math.round((carrierSize.width - entitySize.width) / 2)),
    y: Math.max(0, carrierSize.height - entitySize.height),
  };
}

export function workerWindowSize(scale: number): EntitySize {
  return {
    width: Math.max(320, Math.round(WORKER_SPRITE_W * scale + 40)),
    height: Math.max(176, Math.round(WORKER_VISIBLE_H * scale + WORKER_WINDOW_TOP_PADDING)),
  };
}

export function defaultHouseBounds(display: DisplayLike, size: EntitySize): DisplayRect {
  return clampRectToRect(
    {
      x: display.workArea.x + HOUSE_MARGIN,
      y: display.workArea.y + display.workArea.height - size.height - HOUSE_MARGIN,
      width: size.width,
      height: size.height,
    },
    display.workArea,
  );
}

export function resolveHousePlacement(
  displays: readonly DisplayLike[],
  primaryDisplay: DisplayLike,
  saved: SavedHousePosition | undefined,
  size: EntitySize,
  bottomOffset = 0,
): ResolvedHousePlacement {
  const display = resolveDisplay(displays, primaryDisplay, saved?.displayId);
  const hasSavedPoint = Number.isFinite(saved?.x) && Number.isFinite(saved?.y);
  const bounds = hasSavedPoint
    ? clampRectToRect(
        {
          x: saved!.x!,
          y: saved!.y!,
          width: size.width,
          height: size.height,
        },
        display.workArea,
      )
    : defaultHouseBoundsWithOffset(display, size, bottomOffset);

  return { display, bounds };
}

function defaultHouseBoundsWithOffset(display: DisplayLike, size: EntitySize, bottomOffset: number): DisplayRect {
  return clampRectToRect(
    {
      x: display.workArea.x + HOUSE_MARGIN,
      y: display.workArea.y + display.workArea.height - size.height - HOUSE_MARGIN - bottomOffset,
      width: size.width,
      height: size.height,
    },
    display.workArea,
  );
}

export function moveRectToDisplay(
  rect: DisplayRect,
  fromDisplay: DisplayLike,
  toDisplay: DisplayLike,
): DisplayRect {
  const fromArea = fromDisplay.workArea;
  const toArea = toDisplay.workArea;
  const xRange = Math.max(1, fromArea.width - rect.width);
  const yRange = Math.max(1, fromArea.height - rect.height);
  const relX = (rect.x - fromArea.x) / xRange;
  const relY = (rect.y - fromArea.y) / yRange;

  return clampRectToRect(
    {
      x: toArea.x + relX * Math.max(0, toArea.width - rect.width),
      y: toArea.y + relY * Math.max(0, toArea.height - rect.height),
      width: rect.width,
      height: rect.height,
    },
    toArea,
  );
}

export function pickWorkerSpawnPoint(
  display: DisplayLike,
  houseBounds: DisplayRect,
  workerSize: EntitySize,
  rng: () => number = Math.random,
  occupiedRects: readonly DisplayRect[] = [],
): EntityPoint {
  const area = insetRect(display.bounds, WORKER_MARGIN);
  const maxX = Math.max(area.x, area.x + area.width - workerSize.width);
  const y = display.bounds.y + display.bounds.height - Math.min(workerSize.height, display.bounds.height);
  const avoidRects = [
    inflateRect(houseBounds, WORKER_MARGIN),
    ...occupiedRects.map(rect => inflateRect(rect, WORKER_MARGIN)),
  ];

  for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
    const x = randomBetween(area.x, maxX, rng);
    const candidate = { x, y, width: workerSize.width, height: workerSize.height };
    if (!avoidRects.some(rect => rectsIntersect(candidate, rect))) {
      return { x: Math.round(x), y: Math.round(y) };
    }
  }

  return farthestBottomCandidate(area, y, avoidRects, workerSize);
}

export function clampRectToRect(rect: DisplayRect, container: DisplayRect): DisplayRect {
  const width = Math.min(rect.width, container.width);
  const height = Math.min(rect.height, container.height);
  const maxX = container.x + container.width - width;
  const maxY = container.y + container.height - height;

  return {
    x: Math.round(clamp(rect.x, container.x, maxX)),
    y: Math.round(clamp(rect.y, container.y, maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function rectsIntersect(a: DisplayRect, b: DisplayRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function farthestBottomCandidate(
  area: DisplayRect,
  y: number,
  avoidRects: readonly DisplayRect[],
  workerSize: EntitySize,
): EntityPoint {
  const maxX = Math.max(area.x, area.x + area.width - workerSize.width);
  const candidates = [
    { x: area.x, y },
    { x: maxX, y },
    { x: area.x + (maxX - area.x) / 2, y },
    { x: area.x + (maxX - area.x) * 0.25, y },
    { x: area.x + (maxX - area.x) * 0.75, y },
  ];

  candidates.sort((a, b) => minDistanceToAvoidRects(b, workerSize, avoidRects) - minDistanceToAvoidRects(a, workerSize, avoidRects));
  return {
    x: Math.round(candidates[0].x),
    y: Math.round(candidates[0].y),
  };
}

function minDistanceToAvoidRects(point: EntityPoint, size: EntitySize, avoidRects: readonly DisplayRect[]): number {
  if (avoidRects.length === 0) return Number.POSITIVE_INFINITY;
  const center = {
    x: point.x + size.width / 2,
    y: point.y + size.height / 2,
  };
  return Math.min(...avoidRects.map(rect => distanceSq(center, rectCenter(rect))));
}

function rectCenter(rect: DisplayRect): EntityPoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function distanceSq(a: EntityPoint, b: EntityPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function insetRect(rect: DisplayRect, inset: number): DisplayRect {
  const width = Math.max(1, rect.width - inset * 2);
  const height = Math.max(1, rect.height - inset * 2);
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width,
    height,
  };
}

function inflateRect(rect: DisplayRect, amount: number): DisplayRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function randomBetween(min: number, max: number, rng: () => number): number {
  return min + clamp(rng(), 0, 1) * Math.max(0, max - min);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
