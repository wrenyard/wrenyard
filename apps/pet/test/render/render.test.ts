import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

class FakeHTMLCanvasElement {
  width = 300;
  height = 150;
}

function makeCanvas(): HTMLCanvasElement {
  return new FakeHTMLCanvasElement() as unknown as HTMLCanvasElement;
}

const h = vi.hoisted(() => {
  class MockContainer {
    static nextId = 1;
    id = MockContainer.nextId++;
    parent: MockContainer | null = null;
    children: MockContainer[] = [];
    destroyed = false;
    position = { x: 0, y: 0, set: (x: number, y: number) => {
      this.position.x = x;
      this.position.y = y;
    } };
    scale = { x: 1, y: 1, set: (x: number, y: number) => {
      this.scale.x = x;
      this.scale.y = y;
    } };
    alpha = 1;
    visible = true;

    constructor(public label = 'container') {}

    addChild(child: MockContainer): MockContainer {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    removeChild(child: MockContainer): void {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parent = null;
    }

    removeChildren(): void {
      for (const child of this.children) child.parent = null;
      this.children = [];
    }

    getLocalBounds(): { width: number; height: number } {
      return { width: 0, height: 0 };
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  class MockGraphics extends MockContainer {
    _ops: Array<Record<string, unknown>> = [];

    clear(): MockGraphics {
      this._ops = [];
      return this;
    }

    rect(x: number, y: number, width: number, height: number): MockGraphics {
      this._ops.push({ kind: 'rect', x, y, width, height });
      return this;
    }

    roundRect(x: number, y: number, width: number, height: number, radius: number): MockGraphics {
      this._ops.push({ kind: 'roundedRect', x, y, width, height, radius });
      return this;
    }

    poly(points: number[]): MockGraphics {
      this._ops.push({ kind: 'polygon', points });
      return this;
    }

    fill(fill: { color: number; alpha: number }): MockGraphics {
      this._ops[this._ops.length - 1].fill = fill;
      return this;
    }
  }

  class MockText extends MockContainer {
    text = '';
    style: unknown = {};

    constructor(options?: { text?: string; style?: unknown }) {
      super('text');
      this.text = options?.text ?? '';
      this.style = options?.style ?? {};
    }

    getLocalBounds(): { width: number; height: number } {
      return { width: this.text.length * 3.5, height: 12.25 };
    }
  }

  class MockSprite extends MockContainer {
    texture: unknown;

    constructor(texture: unknown) {
      super('sprite');
      this.texture = texture;
    }
  }

  class MockTicker {
    started = false;
    private readonly callbacks = new Set<() => void>();

    add(callback: () => void): void {
      this.callbacks.add(callback);
    }

    remove(callback: () => void): void {
      this.callbacks.delete(callback);
    }

    start(): void {
      this.started = true;
    }

    stop(): void {
      this.started = false;
    }

    destroy(): void {
      this.callbacks.clear();
    }
  }

  const applications: MockApplication[] = [];

  class MockApplication {
    stage = new MockContainer('stage');
    renderer = {
      resolution: 1,
      resized: null as null | [number, number],
      resize: (width: number, height: number) => {
        this.renderer.resized = [width, height];
      },
    };
    ticker = new MockTicker();
    renderCount = 0;

    constructor() {
      applications.push(this);
    }

    async init(options: Record<string, unknown>): Promise<void> {
      (globalThis as unknown as { __mockInitOptions?: Record<string, unknown> }).__mockInitOptions = options;
    }

    render(): void {
      this.renderCount++;
    }

    destroy(): void {
      this.ticker.destroy();
    }
  }

  class MockTextStyle {
    constructor(public opts: Record<string, unknown>) {}
  }

  class MockTexture {
    constructor(public opts?: unknown) {}
    destroy(): void {}
  }

  class MockBufferImageSource {
    constructor(public opts: Record<string, unknown>) {}
  }

  return {
    MockApplication,
    MockBufferImageSource,
    MockContainer,
    MockGraphics,
    MockSprite,
    MockText,
    MockTextStyle,
    MockTexture,
    TextureEmpty: { empty: true },
    applications,
  };
});

vi.mock('pixi.js', () => ({
  Application: h.MockApplication,
  BufferImageSource: h.MockBufferImageSource,
  Container: h.MockContainer,
  Graphics: h.MockGraphics,
  Sprite: h.MockSprite,
  Text: h.MockText,
  TextStyle: h.MockTextStyle,
  Texture: Object.assign(h.MockTexture, { EMPTY: h.TextureEmpty }),
}));

import {
  PixelBuilder,
  createRenderSurface,
  type PixelProgram,
  type RenderColor,
  type RenderTextStyle,
  type ShapeCommand,
} from '../../src/render';

beforeAll(() => {
  vi.stubGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function lastApplication(): InstanceType<typeof h.MockApplication> {
  return h.applications[h.applications.length - 1];
}

function initOptions(): Record<string, unknown> {
  return (globalThis as unknown as { __mockInitOptions: Record<string, unknown> }).__mockInitOptions;
}

function graphicsOps(node: unknown): Array<Record<string, unknown>> {
  return (node as { container: { _ops: Array<Record<string, unknown>> } }).container._ops;
}

describe('render public barrel', () => {
  it('exports only runtime factories from the public entry', async () => {
    const mod = await import('../../src/render');
    expect(Object.keys(mod).sort()).toEqual(['PixelBuilder', 'createRenderSurface']);
  });
});

describe('createRenderSurface', () => {
  it('validates positional canvas and exact options', async () => {
    await expect(createRenderSurface({} as HTMLCanvasElement, { resolution: 1 })).rejects.toThrow(TypeError);
    await expect(createRenderSurface(makeCanvas(), null as never)).rejects.toThrow(TypeError);
    await expect(createRenderSurface(makeCanvas(), {} as never)).rejects.toThrow(RangeError);
    await expect(createRenderSurface(makeCanvas(), { resolution: NaN })).rejects.toThrow(RangeError);
    await expect(createRenderSurface(makeCanvas(), { resolution: 0 })).rejects.toThrow(RangeError);
    await expect(
      createRenderSurface(makeCanvas(), { resolution: 1, antialias: true } as never),
    ).rejects.toThrow(TypeError);
  });

  it('initializes Pixi with the fixed spec options and a stopped ticker', async () => {
    const canvas = makeCanvas();
    const surface = await createRenderSurface(canvas, { resolution: 2 });
    expect(initOptions()).toEqual({
      canvas,
      preference: 'webgl',
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: 2,
    });
    expect(lastApplication().ticker.started).toBe(false);
    surface.destroy();
  });
});

describe('RenderColor and ShapeCommand validation', () => {
  it('accepts only 24-bit integer colors and #rgb/#rrggbb strings', () => {
    expect(() => new PixelBuilder(1, 1).rect(0, 0, 1, 1, 0xffffff)).not.toThrow();
    expect(() => new PixelBuilder(1, 1).rect(0, 0, 1, 1, '#f80')).not.toThrow();
    expect(() => new PixelBuilder(1, 1).rect(0, 0, 1, 1, '#ff8800')).not.toThrow();

    const invalid = [-1, 0x1000000, 1.5, 'red', '#ff8800ff', {}] as RenderColor[];
    for (const color of invalid) {
      expect(() => new PixelBuilder(1, 1).rect(0, 0, 1, 1, color)).toThrow(TypeError);
    }
  });

  it('rejects NaN/Infinity numeric colors with RangeError but finite out-of-range with TypeError', () => {
    const nonFinite = [NaN, Infinity, -Infinity] as RenderColor[];
    for (const color of nonFinite) {
      expect(() => new PixelBuilder(1, 1).rect(0, 0, 1, 1, color)).toThrow(RangeError);
    }
    expect(() =>
      new PixelBuilder(1, 1).rect(0, 0, 1, 1, NaN as RenderColor),
    ).toThrow(RangeError);
    expect(() =>
      new PixelBuilder(1, 1).rect(0, 0, 1, 1, Infinity as RenderColor),
    ).toThrow(RangeError);
    expect(() =>
      new PixelBuilder(1, 1).rect(0, 0, 1, 1, -Infinity as RenderColor),
    ).toThrow(RangeError);

    expect(() =>
      new PixelBuilder(1, 1).rect(0, 0, 1, 1, 1.5),
    ).toThrow(TypeError);
    expect(() =>
      new PixelBuilder(1, 1).rect(0, 0, 1, 1, 0x1000000),
    ).toThrow(TypeError);
  });

  it('rejects NaN/Infinity fill in graphics commands with RangeError but finite out-of-range with TypeError', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const graphics = surface.createGraphics();

    const nonFinite = [NaN, Infinity, -Infinity] as RenderColor[];
    for (const color of nonFinite) {
      expect(() =>
        graphics.setCommands([
          { kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: color },
        ]),
      ).toThrow(RangeError);
    }

    expect(() =>
      graphics.setCommands([
        { kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 1.5 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      graphics.setCommands([
        { kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 0x1000000 },
      ]),
    ).toThrow(TypeError);
    surface.destroy();
  });

  it('draws rect, roundedRect, and polygon commands in order with alpha default/clamp', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const graphics = surface.createGraphics([
      { kind: 'rect', x: 0, y: 0, width: 2, height: 2, fill: '#f80' },
      { kind: 'roundedRect', x: 1, y: 1, width: 4, height: 6, radius: 99, fill: 0x010203, alpha: 2 },
      { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], fill: 0, alpha: -1 },
    ]);

    expect(graphicsOps(graphics)).toEqual([
      { kind: 'rect', x: 0, y: 0, width: 2, height: 2, fill: { color: 0xff8800, alpha: 1 } },
      { kind: 'roundedRect', x: 1, y: 1, width: 4, height: 6, radius: 2, fill: { color: 0x010203, alpha: 1 } },
      { kind: 'polygon', points: [0, 0, 1, 0, 0, 1], fill: { color: 0, alpha: 0 } },
    ]);
    surface.destroy();
  });

  it('ignores non-positive shapes and invalid sparse polygons, but rejects invalid inputs', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const graphics = surface.createGraphics();
    graphics.setCommands([
      { kind: 'rect', x: 0, y: 0, width: 0, height: 1, fill: 0 },
      { kind: 'roundedRect', x: 0, y: 0, width: 1, height: -1, radius: 1, fill: 0 },
      { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], fill: 0 },
    ]);
    expect(graphicsOps(graphics)).toEqual([]);

    expect(() =>
      graphics.setCommands([{ kind: 'rect', x: NaN, y: 0, width: 1, height: 1, fill: 0 }]),
    ).toThrow(RangeError);
    expect(() =>
      graphics.setCommands([{ kind: 'polygon', points: [{ x: Infinity, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], fill: 0 }]),
    ).toThrow(RangeError);
    expect(() =>
      graphics.setCommands([{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 0, stroke: 1 } as never]),
    ).toThrow(TypeError);
    surface.destroy();
  });
});

describe('PixelBuilder', () => {
  it('requires finite positive integer dimensions and finite integer rect geometry', () => {
    expect(() => new PixelBuilder(0, 1)).toThrow(RangeError);
    expect(() => new PixelBuilder(1.5, 1)).toThrow(RangeError);
    const builder = new PixelBuilder(2, 2);
    expect(() => builder.rect(0.5, 0, 1, 1, 0)).toThrow(RangeError);
    expect(() => builder.rect(0, 0, Infinity, 1, 0)).toThrow(RangeError);
  });

  it('returns clipped input rects in insertion order and preserves alpha zero', () => {
    const program = new PixelBuilder(4, 3)
      .rect(-1, 0, 3, 2, '#f80')
      .rect(2, 2, 10, 10, 0x010203, 0)
      .rect(8, 8, 1, 1, 0xffffff)
      .rect(0, 0, 0, 1, 0x000000)
      .build();

    expect(program).toEqual({
      width: 4,
      height: 3,
      rects: [
        { x: 0, y: 0, width: 2, height: 2, color: '#f80', alpha: 1 },
        { x: 2, y: 2, width: 2, height: 1, color: 0x010203, alpha: 0 },
      ],
    });
  });

  it('builds a deeply frozen defensive copy', () => {
    const program = new PixelBuilder(1, 1).rect(0, 0, 1, 1, 0).build();
    expect(Object.isFrozen(program)).toBe(true);
    expect(Object.isFrozen(program.rects)).toBe(true);
    expect(Object.isFrozen(program.rects[0])).toBe(true);
  });
});

describe('text and pixel node factories', () => {
  const style: RenderTextStyle = {
    fontFamily: 'monospace',
    fontSize: 12,
    fill: 0xffffff,
    align: 'center',
    lineHeight: 14,
    fontWeight: 700,
  };

  it('requires the exact six-field RenderTextStyle and returns local text measurements', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const text = surface.createText('hey', style);
    expect(text.measure()).toEqual({ width: 10.5, height: 12.25 });
    expect(() => text.setStyle({ ...style, letterSpacing: 0 } as never)).toThrow(TypeError);
    expect(() => text.setStyle({ ...style, fontSize: 0 })).toThrow(RangeError);
    expect(() => text.setStyle({ ...style, fontWeight: '400' } as never)).toThrow(TypeError);
    surface.destroy();
  });

  it('creates nearest RGBA pixel textures from a defensive PixelProgram copy', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const program: PixelProgram = {
      width: 2,
      height: 1,
      rects: [
        { x: 0, y: 0, width: 2, height: 1, color: '#000', alpha: 1 },
        { x: 1, y: 0, width: 1, height: 1, color: 0xff0000, alpha: 0 },
      ],
    };
    const pixel = surface.createPixel(program);
    program.rects[1].width = 99;

    const texture = (pixel as {
      container: { texture: { opts: { source: { opts: Record<string, unknown> } } } };
    }).container.texture;
    const sourceOptions = texture.opts.source.opts;
    expect(sourceOptions.width).toBe(2);
    expect(sourceOptions.height).toBe(1);
    expect(sourceOptions.format).toBe('rgba8unorm');
    expect(sourceOptions.scaleMode).toBe('nearest');
    expect((sourceOptions.resource as Uint8ClampedArray)[7]).toBe(0);
    surface.destroy();
  });
});

describe('surface methods', () => {
  it('resizes with finite positive css dimensions and resolution, and renders while stopped', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    surface.resize(100, 50, 2);
    expect(lastApplication().renderer.resolution).toBe(2);
    expect(lastApplication().renderer.resized).toEqual([100, 50]);
    expect(() => surface.resize(0, 1, 1)).toThrow(RangeError);
    expect(() => surface.resize(1, Infinity, 1)).toThrow(RangeError);
    surface.render();
    expect(lastApplication().renderCount).toBe(1);
    surface.destroy();
  });
});
