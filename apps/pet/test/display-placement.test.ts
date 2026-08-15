import { describe, expect, it } from 'vitest';
import { resolveDisplay, type DisplayLike } from '../src/main/display-placement';
import { houseWindowSize, moveRectToDisplay, resolveHousePlacement } from '../src/main/entity-geometry';

function makeDisplay(id: number, x: number, y: number, width: number, height: number): DisplayLike {
  const rect = { x, y, width, height };
  return { id, bounds: rect, workArea: rect };
}

describe('display placement — display selection fallback', () => {
  it('uses the preferred display when attached', () => {
    const primary = makeDisplay(1, 0, 0, 1920, 1080);
    const secondary = makeDisplay(2, 1920, 0, 2560, 1440);

    expect(resolveDisplay([primary, secondary], primary, 2).id).toBe(2);
  });

  it('falls back to the primary display when the preferred display is missing', () => {
    const primary = makeDisplay(1, 0, 0, 1920, 1080);
    const secondary = makeDisplay(2, 1920, 0, 2560, 1440);

    expect(resolveDisplay([primary, secondary], primary, 99).id).toBe(1);
  });

  it('falls back to an attached display if the supplied primary is stale', () => {
    const stalePrimary = makeDisplay(1, 0, 0, 1920, 1080);
    const remaining = makeDisplay(2, 1920, 0, 2560, 1440);

    expect(resolveDisplay([remaining], stalePrimary, 99).id).toBe(2);
  });
});

describe('display placement — V2 house placement', () => {
  it('restores a saved house position on the preferred display', () => {
    const display: DisplayLike = {
      id: 1,
      bounds: { x: 0, y: 0, width: 3840, height: 2160 },
      workArea: { x: 100, y: 50, width: 3000, height: 2000 },
    };

    const placement = resolveHousePlacement([display], display, { displayId: 1, x: 200, y: 300 }, houseWindowSize(3));

    expect(placement.display.id).toBe(1);
    expect(placement.bounds).toEqual({ x: 200, y: 300, width: 360, height: 460 });
  });

  it('falls back to the primary display and clamps stale coordinates', () => {
    const primary = makeDisplay(1, 0, 0, 1920, 1080);
    const missingDisplayPosition = { displayId: 99, x: 5000, y: 5000 };

    const placement = resolveHousePlacement([primary], primary, missingDisplayPosition, houseWindowSize(3));

    expect(placement.display.id).toBe(1);
    expect(placement.bounds.x + placement.bounds.width).toBeLessThanOrEqual(primary.workArea.x + primary.workArea.width);
    expect(placement.bounds.y + placement.bounds.height).toBeLessThanOrEqual(primary.workArea.y + primary.workArea.height);
  });

  it('moves house between displays preserving relative workArea position', () => {
    const primary = makeDisplay(1, 0, 0, 1920, 1080);
    const secondary = makeDisplay(2, 1920, 0, 1280, 720);
    const rect = { x: 960, y: 540, width: 360, height: 460 };

    const moved = moveRectToDisplay(rect, primary, secondary);

    expect(moved.x).toBeGreaterThanOrEqual(secondary.workArea.x);
    expect(moved.y).toBeGreaterThanOrEqual(secondary.workArea.y);
    expect(moved.x + moved.width).toBeLessThanOrEqual(secondary.workArea.x + secondary.workArea.width);
    expect(moved.y + moved.height).toBeLessThanOrEqual(secondary.workArea.y + secondary.workArea.height);
  });
});

describe('display placement — bottomOffset initial placement', () => {
  it('honors bottomOffset when no saved position exists', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);
    const size = houseWindowSize(3);
    const bottomOffset = 50;

    const placement = resolveHousePlacement([display], display, undefined, size, bottomOffset);

    expect(placement.bounds.y).toBe(display.workArea.y + display.workArea.height - size.height - 24 - bottomOffset);
  });

  it('ignores bottomOffset when saved position exists', () => {
    const display = makeDisplay(1, 0, 0, 1920, 1080);
    const size = houseWindowSize(3);

    const placement = resolveHousePlacement([display], display, { displayId: 1, x: 100, y: 200 }, size, 50);

    // Saved position retained regardless of bottomOffset
    expect(placement.bounds.y).toBe(200);
  });
});
