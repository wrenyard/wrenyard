import { describe, expect, it } from 'vitest';
import { DisplayLike } from '../src/main/display-placement';
import { WORKER_VISIBLE_H, WORKER_WINDOW_TOP_PADDING } from '../src/shared/worker-metrics';
import {
  houseWindowSize,
  placeHouseCarrier,
  pickWorkerSpawnPoint,
  rectsIntersect,
  resolveHouseCarrierPlacement,
  resolveHousePlacement,
  workerWindowSize,
} from '../src/main/entity-geometry';

function makeDisplay(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor = 1,
  workAreaHeight = height,
): DisplayLike & { scaleFactor: number } {
  const rect = { x, y, width, height };
  return { id, bounds: rect, workArea: { ...rect, height: workAreaHeight }, scaleFactor };
}

function rngSequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('entity geometry — spawn point picking', () => {
  it('picks worker points inside screen bounds and avoids the house rect', () => {
    const display = makeDisplay(1, 0, 0, 800, 600);
    const house = { x: 20, y: 420, width: 144, height: 120 };
    const worker = workerWindowSize(3);

    const point = pickWorkerSpawnPoint(display, house, worker, rngSequence([0.9, 0.1]));
    const workerRect = { ...point, ...worker };

    expect(workerRect.x).toBeGreaterThanOrEqual(display.bounds.x);
    expect(workerRect.y).toBeGreaterThanOrEqual(display.bounds.y);
    expect(workerRect.x + workerRect.width).toBeLessThanOrEqual(display.bounds.x + display.bounds.width);
    expect(workerRect.y + workerRect.height).toBeLessThanOrEqual(display.bounds.y + display.bounds.height);
    expect(rectsIntersect(workerRect, house)).toBe(false);
  });

  it('pins worker Y to the bottom edge of workArea', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);
    const house = { x: 600, y: 900, width: 200, height: 100 };
    const worker = workerWindowSize(3);
    const bottomY = display.bounds.y + display.bounds.height - worker.height;

    const point = pickWorkerSpawnPoint(display, house, worker, rngSequence([0.5, 0.1]));
    expect(point.y).toBe(bottomY);
  });

  it('pins worker Y to the screen bottom even when workArea excludes a taskbar', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080, 1, 1032);
    const house = { x: 600, y: 850, width: 200, height: 100 };
    const worker = workerWindowSize(3);
    const bottomY = display.bounds.y + display.bounds.height - worker.height;

    const point = pickWorkerSpawnPoint(display, house, worker, rngSequence([0.5, 0.1]));
    expect(point.y).toBe(bottomY);
    expect(point.y + worker.height).toBe(display.bounds.y + display.bounds.height);
  });

  it('spreads workers away from occupied bottom-pinned workers when possible', () => {
    const display = makeDisplay(1, 0, 0, 1200, 800);
    const house = { x: 20, y: 650, width: 144, height: 120 };
    const worker = workerWindowSize(3);
    const occupied = { x: 440, y: 800 - worker.height, ...worker };

    const point = pickWorkerSpawnPoint(display, house, worker, rngSequence([0.4, 0.9]), [occupied]);
    const workerRect = { ...point, ...worker };

    expect(workerRect.y).toBe(display.bounds.y + display.bounds.height - worker.height);
    expect(rectsIntersect(workerRect, occupied)).toBe(false);
  });

  it('falls back to a valid workArea point after repeated avoided candidates', () => {
    const display = makeDisplay(1, 0, 0, 700, 500);
    const house = { x: 0, y: 0, width: 360, height: 260 };
    const worker = workerWindowSize(3);

    const point = pickWorkerSpawnPoint(display, house, worker, () => 0);
    const workerRect = { ...point, ...worker };

    expect(workerRect.x).toBeGreaterThanOrEqual(display.bounds.x);
    expect(workerRect.y).toBeGreaterThanOrEqual(display.bounds.y);
    expect(workerRect.x + workerRect.width).toBeLessThanOrEqual(display.bounds.x + display.bounds.width);
    expect(workerRect.y + workerRect.height).toBeLessThanOrEqual(display.bounds.y + display.bounds.height);
  });
});

describe('entity geometry — DIP layout', () => {
  it('clamps the visible house to every edge while sliding it inside the carrier', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);

    const topLeft = placeHouseCarrier({ x: 0, y: 0 }, display, 3);
    expect(topLeft.bounds).toEqual({ x: 0, y: 0, width: 360, height: 460 });
    expect(topLeft.entityBounds).toEqual({ x: 0, y: 0, width: 144, height: 120 });
    expect(topLeft.entityOffset).toEqual({ x: 0, y: 0 });

    const bottomRight = placeHouseCarrier({ x: 1920 - 144, y: 1080 - 120 }, display, 3);
    expect(bottomRight.bounds).toEqual({ x: 1560, y: 620, width: 360, height: 460 });
    expect(bottomRight.entityBounds).toEqual({ x: 1776, y: 960, width: 144, height: 120 });
    expect(bottomRight.entityOffset).toEqual({ x: 216, y: 340 });
  });

  it('anchors the carrier below a house near the top so Tips have clear space', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);
    const placement = placeHouseCarrier({ x: 500, y: 200 }, display, 3);

    expect(placement.entityBounds.y).toBe(200);
    expect(placement.bounds.y).toBe(200);
    expect(placement.entityOffset.y).toBe(0);
  });

  it('restores the visible entity anchor after the V3 position has been saved', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);
    const placement = resolveHouseCarrierPlacement(
      [display],
      display,
      { displayId: 1, x: 100, y: 100, entityX: 1776, entityY: 960 },
      3,
    );

    expect(placement.entityBounds).toEqual({ x: 1776, y: 960, width: 144, height: 120 });
    expect(placement.entityOffset).toEqual({ x: 216, y: 340 });
  });

  it('sizes worker windows around the visible footline instead of transparent sprite bottom', () => {
    const scale = 3;

    expect(workerWindowSize(scale).height).toBe(WORKER_VISIBLE_H * scale + WORKER_WINDOW_TOP_PADDING);
  });

  it('keeps window geometry in DIP on a scaleFactor 2 display', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080, 2);
    const placement = resolveHousePlacement(
      [display],
      display,
      { displayId: 1, x: 1776, y: 960 },
      houseWindowSize(3),
    );

    expect(display.scaleFactor).toBe(2);
    expect(placement.bounds.width).toBe(360);
    expect(placement.bounds.height).toBe(460);
    expect(placement.bounds.x + placement.bounds.width).toBe(1920);
    expect(placement.bounds.y + placement.bounds.height).toBe(1080);
  });

  it('pins worker spawn to screen bottom edge on scaleFactor 2 display', () => {
    const display = makeDisplay(1, 0, 0, 3840, 2160, 2);
    const house = { x: 48, y: 1600, width: 288, height: 240 };
    const worker = workerWindowSize(3);
    const bottomY = display.bounds.y + display.bounds.height - worker.height;

    const point = pickWorkerSpawnPoint(display, house, worker, rngSequence([0.5, 0.1]));
    expect(display.scaleFactor).toBe(2);
    expect(point.y).toBe(bottomY);
  });
});
