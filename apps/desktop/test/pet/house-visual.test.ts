import { describe, expect, it } from 'vitest';
import type { PixelProgram, RenderSurface } from '../../src/pet/render';
import {
  buildHousePixelProgram,
  HOUSE_PX_H,
  HOUSE_PX_W,
} from '../../src/pet/features/house/scene/house-sprite';
import {
  createHouseScene,
  houseLogicalPosition,
  physicalHouseRect,
} from '../../src/pet/features/house/scene';
import { broadcastAlpha, shouldRenderBroadcast } from '../../src/pet/features/house/scene/broadcast-expiry';
import { stateWithoutBroadcast } from '../../src/pet/features/house/presenter';
import type { HouseRendererState } from '../../src/pet/shared/entities';

function mockSurface() {
  const pixels: any[] = [];
  const baseNode = () => ({
    x: 0,
    y: 0,
    scale: [] as unknown[],
    visible: true,
    setPosition(x: number, y: number) { this.x = x; this.y = y; },
    setScale(x: number, y?: number) { this.scale.push([x, y]); },
    setAlpha() {},
    setVisible(visible: boolean) { this.visible = visible; },
    destroy() {},
  });
  const createContainer = () => ({
    ...baseNode(),
    children: [] as unknown[],
    add(...children: unknown[]) { this.children.push(...children); },
    remove(child: unknown) { this.children = this.children.filter((item) => item !== child); },
  });
  const root = createContainer();
  const surface: any = {
    root,
    ticker: { add: () => () => {}, start: () => {}, stop: () => {} },
    createContainer,
    createGraphics: () => ({ ...baseNode(), setCommands() {} }),
    createPixel(program?: PixelProgram) {
      const node = { ...baseNode(), program, setProgram(next: PixelProgram) { this.program = next; } };
      pixels.push(node);
      return node;
    },
    resize: () => {},
    render: () => {},
    destroy: () => {},
  };
  return { surface: surface as RenderSurface, root, pixels };
}

function state(overrides: Partial<HouseRendererState> = {}): HouseRendererState {
  return {
    scale: 5,
    houseSkin: 'classic',
    workers: [],
    queuedCount: 0,
    ...overrides,
  };
}

describe('house pixel art programs', () => {
  it('builds a 48x40 classic program with painted cells', () => {
    const program = buildHousePixelProgram('classic');
    expect(program.width).toBe(HOUSE_PX_W);
    expect(program.height).toBe(HOUSE_PX_H);
    expect(program.rects.length).toBeGreaterThan(100);
    for (const rect of program.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(HOUSE_PX_W);
      expect(rect.y + rect.height).toBeLessThanOrEqual(HOUSE_PX_H);
    }
  });

  it('builds a mushroom program within the same 48x40 footprint', () => {
    const mushroom = buildHousePixelProgram('mushroom');
    expect(mushroom.width).toBe(HOUSE_PX_W);
    expect(mushroom.height).toBe(HOUSE_PX_H);
    expect(mushroom.rects.length).toBeGreaterThan(0);
  });
});

describe('house scene (art-only)', () => {
  it('positions the sprite and returns the physical house rectangle', () => {
    const env = mockSurface();
    const scene = createHouseScene(env.surface, state(), { width: 72, height: 92, scale: 5 }, 0);
    const output = scene.update(state(), { width: 72, height: 92, scale: 5 }, 0);
    expect(output.houseRect).toEqual({ x: 60, y: 260, width: 240, height: 200 });
    scene.destroy();
  });

  it('alpha-tests the authored sprite program for pointer hit testing', () => {
    const env = mockSurface();
    const scene = createHouseScene(env.surface, state(), { width: 72, height: 92, scale: 5 }, 0);
    scene.update(state(), { width: 72, height: 92, scale: 5 }, 0);

    // Body center at scale 5 sits over painted plaster; the top-left corner is
    // transparent sky and must pass through.
    expect(scene.hitTestScreen(180, 360)).toBe(true);
    expect(scene.hitTestScreen(61, 261)).toBe(false);
    scene.destroy();
  });

  it('renders the active open-door sprite when a worker is running', () => {
    const env = mockSurface();
    const running = state({ workers: [{ phase: 'working' } as any] });
    const scene = createHouseScene(env.surface, running, { width: 72, height: 92, scale: 5 }, 0);
    scene.update(running, { width: 72, height: 92, scale: 5 }, 0);
    expect(env.pixels.length).toBeGreaterThan(0);
    scene.destroy();
  });
});

describe('house geometry helpers', () => {
  it('centers an unplaced house at the bottom and clamps placed origins', () => {
    expect(houseLogicalPosition({ width: 72, height: 92, scale: 5 })).toEqual({ x: 12, y: 52 });
    expect(houseLogicalPosition({ width: 72, height: 92, scale: 5 }, { x: 1000, y: 1000 }))
      .toEqual({ x: 24, y: 52 });
    expect(houseLogicalPosition({ width: 72, height: 92, scale: 5 }, { x: Number.NaN, y: 0 }))
      .toEqual({ x: 12, y: 52 });
  });

  it('scales the physical rect by the pixel scale', () => {
    expect(physicalHouseRect(12, 52, 5)).toEqual({ x: 60, y: 260, width: 240, height: 200 });
  });
});

describe('broadcast expiry', () => {
  it('fades transient broadcasts over the final 800ms', () => {
    const transient = { text: 'hi', intensity: 'transient' as const, untilMs: 10400 };
    expect(broadcastAlpha(transient, 9000)).toBe(1);
    expect(broadcastAlpha(transient, 10000)).toBeCloseTo(0.5, 5);
    expect(broadcastAlpha(transient, 10400)).toBe(0);
    expect(broadcastAlpha(transient, 11000)).toBe(0);
  });

  it('keeps sticky and critical broadcasts fully opaque', () => {
    expect(broadcastAlpha({ text: 's', intensity: 'sticky' }, 1)).toBe(1);
    expect(broadcastAlpha({ text: 'c', intensity: 'critical' }, 1)).toBe(1);
    expect(broadcastAlpha(undefined, 1)).toBe(0);
  });

  it('renders only while alpha is positive', () => {
    expect(shouldRenderBroadcast({ text: 's', intensity: 'sticky' }, 1)).toBe(true);
    expect(shouldRenderBroadcast({ text: 't', intensity: 'transient', untilMs: 10 }, 20)).toBe(false);
  });
});

describe('stateWithoutBroadcast', () => {
  it('drops the broadcast but preserves scale, stats and activity fields', () => {
    const dailyStats = {
      dayKey: '2026-07-10',
      startAt: '2026-07-10T00:00:00.000Z',
      endAt: '2026-07-10T23:59:59.999Z',
      dispatchCount: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'sqlite' as const,
    };
    const without = stateWithoutBroadcast(state({
      broadcast: { id: 'b1', text: 'hello', intensity: 'sticky' },
      dailyStats,
      activityStale: true,
      taskgraphCount: 2,
    }));
    expect(without.broadcast).toBeUndefined();
    expect(without.dailyStats).toBe(dailyStats);
    expect(without.activityStale).toBe(true);
    expect(without.taskgraphCount).toBe(2);
    expect(without.scale).toBe(5);
  });
});
