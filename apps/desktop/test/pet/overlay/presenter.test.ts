import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShapeCommand } from '../../../src/pet/render';
import type { HouseRendererState, WorkerRendererState } from '../../../src/pet/shared/entities';
import type { Appearance } from '../../../src/pet/shared/snapshot';
import { HousePresenter, stateWithoutBroadcast } from '../../../src/pet/features/house/presenter';
import { WorkerPresenter } from '../../../src/pet/features/worker/presenter';

type Frame = (nowMs: number, deltaMs: number) => void;

function mockSurface() {
  const pixels: any[] = [];
  const graphics: any[] = [];
  const resizeCalls: unknown[][] = [];
  let renderCount = 0;
  let startCount = 0;
  let stopCount = 0;
  const callbacks: Frame[] = [];

  const baseNode = () => ({
    x: 0,
    y: 0,
    scale: [] as unknown[],
    alpha: 1,
    visible: true,
    destroyed: false,
    setPosition(x: number, y: number) { this.x = x; this.y = y; },
    setScale(x: number, y?: number) { this.scale.push([x, y]); },
    setAlpha(alpha: number) { this.alpha = alpha; },
    setVisible(visible: boolean) { this.visible = visible; },
    destroy() { this.destroyed = true; },
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
    ticker: {
      add(callback: Frame) {
        callbacks.push(callback);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          const index = callbacks.indexOf(callback);
          if (index >= 0) callbacks.splice(index, 1);
        };
      },
      start() { startCount += 1; },
      stop() { stopCount += 1; },
    },
    createContainer,
    createGraphics() {
      const node = { ...baseNode(), commands: [] as readonly ShapeCommand[], setCommands(commands: readonly ShapeCommand[]) { this.commands = commands; } };
      graphics.push(node);
      return node;
    },
    createPixel(program?: unknown) {
      const node = { ...baseNode(), program, setProgram(next: unknown) { this.program = next; } };
      pixels.push(node);
      return node;
    },
    resize(...args: unknown[]) { resizeCalls.push(args); },
    render() { renderCount += 1; },
    destroy() {},
  };

  return {
    surface,
    root,
    pixels,
    graphics,
    callbacks,
    resizeCalls,
    get renderCount() { return renderCount; },
    get startCount() { return startCount; },
    get stopCount() { return stopCount; },
  };
}

function appearance(id: Appearance['skin']['id'] = 'classic-codebuddy'): Appearance {
  const kind =
    id === 'classic-codebuddy' || id === 'classic-codex' || id === 'classic-claude'
      ? 'official'
      : id === 'classic-voxel-miner'
        ? 'classic'
        : 'original';
  return {
    profile: 'classic',
    profileLabel: 'Preview',
    skin: {
      kind,
      id,
      name: id,
      colors: { primary: '#2F7DE1', accent: '#8FE3FF', tool: '#0d4a9e' },
    },
  };
}

function workerState(scale = 5): WorkerRendererState {
  return {
    scale,
    worker: {
      workerIdentityKey: 'worker-1',
      profile: 'preview',
      client: 'codex',
      phase: 'working',
      appearance: appearance(),
      sinceMs: 0,
      toolCount: 0,
      startedAt: 0,
    },
    infoCard: {
      workerIdentityKey: 'worker-1',
      profile: 'preview',
      status: 'working',
      toolCount: 0,
      durationMs: 0,
      isWorktree: false,
    },
  };
}

function houseState(scale = 5): HouseRendererState {
  return {
    scale,
    houseSkin: 'classic',
    workers: [{ phase: 'working' } as any],
    queuedCount: 3,
    broadcast: { id: 'broadcast-1', text: 'Ready', intensity: 'sticky' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('overlay worker presenter', () => {
  it('attaches the worker sprite root once, resizes with CSS DPR, and exposes a footline hit region', () => {
    const env = mockSurface();
    const presenter = new WorkerPresenter(env.surface);
    presenter.resize(640, 360, 2);
    const first = presenter.setState(workerState());
    const second = presenter.renderFrame(10000);
    presenter.resize(640, 360, 3);

    expect(env.resizeCalls).toEqual([[640, 360, 2], [640, 360, 3]]);
    expect(env.root.children).toHaveLength(1);
    expect(first?.root).toBe(second?.root);
    expect(second?.hitRegion).toEqual({ x: 220, y: 200, width: 200, height: 160 });
    expect(env.renderCount).toBeGreaterThan(0);
  });

  it('hit-tests the footline region at CSS coordinates', () => {
    const env = mockSurface();
    const presenter = new WorkerPresenter(env.surface);
    presenter.resize(640, 360, 5);
    presenter.setState(workerState(5));

    // Hit region is { x: 220, y: 200, width: 200, height: 160 }.
    expect(presenter.hitTest(300, 250)).toBe(true);
    expect(presenter.hitTest(219, 250)).toBe(false);
    expect(presenter.hitTest(300, 199)).toBe(false);
  });

  it('exposes the worker identity key and supports stop/destroy', () => {
    const env = mockSurface();
    const presenter = new WorkerPresenter(env.surface);
    presenter.resize(640, 360, 1);
    presenter.setState(workerState(5));
    expect(presenter.getWorkerId()).toBe('worker-1');

    presenter.start();
    expect(env.startCount).toBe(1);
    presenter.stop();
    expect(env.callbacks).toHaveLength(0);
    expect(env.stopCount).toBe(1);
    presenter.destroy();
    presenter.destroy();
    expect(env.root.children).toHaveLength(0);
  });
});

describe('overlay house presenter', () => {
  it('attaches the house sprite root once and exposes the physical house rect', () => {
    const env = mockSurface();
    const presenter = new HousePresenter(env.surface);
    presenter.resize(360, 460, 2);
    const output = presenter.setState(houseState());
    presenter.renderFrame(10000);

    expect(env.resizeCalls).toEqual([[360, 460, 2]]);
    expect(env.root.children).toHaveLength(1);
    expect(output?.houseRect).toEqual({ x: 60, y: 260, width: 240, height: 200 });
    expect(env.renderCount).toBeGreaterThan(0);
  });

  it('alpha-tests the house sprite program at CSS coordinates', () => {
    const env = mockSurface();
    const presenter = new HousePresenter(env.surface);
    presenter.resize(360, 460, 5);
    presenter.setState(houseState(5));

    // House origin is (60,260) at scale 5; the body is painted, the corner is not.
    expect(presenter.hitTest(180, 360)).toBe(true);
    expect(presenter.hitTest(61, 261)).toBe(false);
  });

  it('replays state with deterministic renderFrame timestamps and removes broadcast locally', () => {
    const env = mockSurface();
    const presenter = new HousePresenter(env.surface);
    presenter.resize(360, 460, 1);
    presenter.setState({
      ...houseState(),
      broadcast: { id: 'b1', text: 'fade', intensity: 'transient', untilMs: 10400 },
    });

    const output = presenter.renderFrame(10000);
    expect(output?.houseRect).toBeDefined();

    const without = stateWithoutBroadcast({
      ...houseState(),
      dailyStats: {
        dayKey: '2026-07-10',
        startAt: '2026-07-10T00:00:00.000Z',
        endAt: '2026-07-10T23:59:59.999Z',
        dispatchCount: 1,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        source: 'sqlite',
      },
    });
    expect(without.broadcast).toBeUndefined();
    expect(without.dailyStats?.source).toBe('sqlite');
  });
});
