import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderTextStyle, ShapeCommand } from '../../src/render';
import type { HouseRendererState, WorkerRendererState } from '../../src/shared/entities';
import type { Appearance } from '../../src/shared/snapshot';
import { HousePresenter, stateWithoutBroadcast } from '../../src/features/house/presenter';
import { WorkerPresenter } from '../../src/features/worker/presenter';

type Frame = (nowMs: number, deltaMs: number) => void;

function mockSurface() {
  const texts: any[] = [];
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
    createText(text = '', style?: RenderTextStyle) {
      const node = {
        ...baseNode(),
        value: text,
        style,
        setText(next: string) { this.value = next; },
        setStyle(next: RenderTextStyle) { this.style = next; },
        measure() {
          return {
            width: Math.max(1, Array.from(this.value).length * 6),
            height: this.style?.lineHeight ?? 12,
          };
        },
      };
      texts.push(node);
      return node;
    },
    resize(...args: unknown[]) { resizeCalls.push(args); },
    render() { renderCount += 1; },
    destroy() {},
  };

  return {
    surface,
    root,
    texts,
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
    workers: [{ phase: 'working' } as any],
    queuedCount: 3,
    broadcast: { id: 'broadcast-1', text: 'Ready', intensity: 'sticky' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('overlay worker presenter', () => {
  it('attaches the worker root once, resizes with CSS DPR, and exposes hit output', () => {
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
    expect(second?.passthrough).toBe(true);
    expect(env.renderCount).toBeGreaterThan(0);
  });

  it('uses Date.now epoch timestamps from ticker callbacks and supports stop/destroy', () => {
    const env = mockSurface();
    const presenter = new WorkerPresenter(env.surface);
    presenter.resize(640, 360, 1);
    presenter.setState(workerState(5));
    vi.spyOn(Date, 'now').mockReturnValue(34567);

    presenter.start();
    expect(env.startCount).toBe(1);
    env.callbacks[0](123, 16);
    expect(env.texts.some((text) => text.value === '34s')).toBe(true);

    presenter.stop();
    expect(env.callbacks).toHaveLength(0);
    expect(env.stopCount).toBe(1);
    presenter.destroy();
    presenter.destroy();
    expect(env.root.children).toHaveLength(0);
  });

  it('honors explicit epoch timestamps for deterministic static updates', () => {
    const env = mockSurface();
    const presenter = new WorkerPresenter(env.surface);
    vi.spyOn(Date, 'now').mockReturnValue(999999);

    presenter.resize(640, 360, 1, 10000);
    presenter.setState(workerState(5), 10000);
    presenter.setPointer({ x: 300, y: 250, inside: true }, 10000);
    const output = presenter.setDragging(false, 10000);

    expect(output?.hovering).toBe(true);
    expect(env.texts.some((text) => text.value === '10s')).toBe(true);
    expect(env.texts.some((text) => text.value === '99m')).toBe(false);
  });
});

describe('overlay house presenter', () => {
  it('attaches the house root once and exposes body, close and passthrough output', () => {
    const env = mockSurface();
    const presenter = new HousePresenter(env.surface);
    presenter.resize(360, 460, 2);
    const output = presenter.setState(houseState());
    presenter.renderFrame(10000);

    expect(env.resizeCalls).toEqual([[360, 460, 2]]);
    expect(env.root.children).toHaveLength(1);
    expect(output?.houseRect).toEqual({ x: 60, y: 260, width: 240, height: 200 });
    expect(output?.closeRect).toBeDefined();
    expect(output?.hitRects.map((rect) => rect.target)).toEqual(['house', 'broadcast-close']);
    expect(output?.passthrough).toBe(true);
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
    expect(output?.broadcast?.alpha).toBeCloseTo(0.5, 5);

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

  it('honors explicit epoch timestamps for static resize and state replay', () => {
    const env = mockSurface();
    const presenter = new HousePresenter(env.surface);
    vi.spyOn(Date, 'now').mockReturnValue(999999);

    presenter.resize(360, 460, 1, 10000);
    const output = presenter.setState({
      ...houseState(),
      broadcast: { id: 'b1', text: 'fade', intensity: 'transient', untilMs: 10400 },
    }, 10000);

    expect(output?.broadcast?.alpha).toBeCloseTo(0.5, 5);
  });
});
