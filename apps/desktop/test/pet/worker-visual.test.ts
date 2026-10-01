import { describe, expect, it } from 'vitest';
import type { PixelProgram, RenderSurface } from '../../src/pet/render';
import type { Appearance } from '../../src/pet/shared/snapshot';
import {
  createWorkerScene,
  type WorkerNodeState,
} from '../../src/pet/features/worker/scene';
import { activityPulseOffset, contentGestureShift, toolFlashAlpha } from '../../src/pet/features/worker/scene/timing';
import { formatWorkerAge, resolveWorkerLabelText } from '../../src/pet/features/worker/presenter';
import { bubbleAlpha, revealCharCount } from '../../src/pet/overlay/use-typewriter';

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

function appearance(id: Appearance['skin']['id'] = 'classic-codebuddy'): Appearance {
  const kind =
    id === 'classic-codebuddy' || id === 'classic-codex' || id === 'classic-claude'
      ? 'official'
      : id === 'classic-voxel-miner'
        ? 'classic'
        : 'original';
  return {
    profile: 'preview',
    profileLabel: 'Preview',
    skin: { kind, id, name: id, colors: { primary: '#2F7DE1', accent: '#8FE3FF', tool: '#0d4a9e' } },
  };
}

function workerState(overrides: Partial<WorkerNodeState> = {}): WorkerNodeState {
  return {
    appearance: appearance(),
    phase: 'working',
    client: 'codex',
    sinceMs: 0,
    toolCount: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('worker sprite scene (art-only)', () => {
  it('paints one mascot sprite and exposes the footline hit region', () => {
    const env = mockSurface();
    const scene = createWorkerScene(env.surface, workerState(), { width: 128, height: 100, scale: 5 });
    const output = scene.update(workerState(), { width: 128, height: 100, scale: 5 }, 1000);

    expect(env.root.children).toHaveLength(1);
    // x = floor((128 - 40) / 2) = 44, y = 100 - 32 = 68; scaled by 5.
    expect(output.hitRegion).toEqual({ x: 220, y: 340, width: 200, height: 160 });
    expect(env.pixels.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('animates the sprite frame as sinceMs advances', () => {
    const env = mockSurface();
    const scene = createWorkerScene(env.surface, workerState(), { width: 128, height: 100, scale: 1 });
    scene.update(workerState({ sinceMs: 0 }), { width: 128, height: 100, scale: 1 }, 0);
    const first = env.pixels[0].program;
    scene.update(workerState({ sinceMs: 0 }), { width: 128, height: 100, scale: 1 }, 640);
    const second = env.pixels[0].program;
    expect(first).not.toEqual(second);
    scene.destroy();
  });
});

describe('worker age/task label projection', () => {
  it('formats seconds then clamps minutes at 99m', () => {
    expect(formatWorkerAge(0, 0)).toBe('0s');
    expect(formatWorkerAge(0, 59_000)).toBe('59s');
    expect(formatWorkerAge(0, 60_000)).toBe('1m');
    expect(formatWorkerAge(0, 60 * 60 * 1000)).toBe('99m');
  });

  it('shows the task label only while hovering with a task name', () => {
    const base = { hovering: false, taskName: 'Build', taskId: 't1', startedAt: 0, nowMs: 5000 };
    expect(resolveWorkerLabelText(base)).toEqual({ kind: 'age', text: '5s' });
    expect(resolveWorkerLabelText({ ...base, hovering: true })).toEqual({ kind: 'task', text: 'Build' });
    expect(resolveWorkerLabelText({ ...base, hovering: true, taskName: undefined, taskLabel: 'L' }))
      .toEqual({ kind: 'task', text: 'L' });
    expect(resolveWorkerLabelText({ ...base, hovering: true, taskName: undefined, taskLabel: undefined }))
      .toEqual({ kind: 'age', text: '5s' });
  });
});

describe('worker animation timing', () => {
  it('returns a bounded activity bob only inside the pulse window', () => {
    expect(activityPulseOffset(1000, undefined)).toBe(0);
    expect(activityPulseOffset(1000, 900)).toBeLessThanOrEqual(0);
    expect(activityPulseOffset(1000, 900)).toBeGreaterThanOrEqual(-3);
    expect(activityPulseOffset(2000, 0)).toBe(0);
  });

  it('returns a 1px content gesture only inside its window', () => {
    expect(contentGestureShift(100, 0)).toBe(1);
    expect(contentGestureShift(400, 0)).toBe(0);
    expect(contentGestureShift(0, undefined)).toBe(0);
  });

  it('fades the tool flash over ~2200ms', () => {
    expect(toolFlashAlpha(0, undefined)).toBe(0);
    expect(toolFlashAlpha(0, 0)).toBe(1);
    expect(toolFlashAlpha(100, 0)).toBe(1);
    expect(toolFlashAlpha(2100, 0)).toBeLessThan(0.2);
    expect(toolFlashAlpha(2300, 0)).toBe(0);
  });
});

describe('worker bubble typewriter', () => {
  it('fades only over the final 800ms', () => {
    expect(bubbleAlpha(10_000, 9_000)).toBe(1);
    expect(bubbleAlpha(10_000, 9_600)).toBeCloseTo(0.5, 5);
    expect(bubbleAlpha(10_000, 10_000)).toBe(0);
    expect(bubbleAlpha(10_000, 11_000)).toBe(0);
  });

  it('reveals at 40 code points per second and never exceeds the text length', () => {
    expect(revealCharCount('hello world', 0, 0)).toBe(0);
    expect(revealCharCount('hello world', 0, 100)).toBe(4);
    expect(revealCharCount('hello world', 0, 1000)).toBe(11);
    expect(revealCharCount('你好世界', 0, 100)).toBe(4);
  });
});
