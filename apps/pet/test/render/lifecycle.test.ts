import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

class FakeHTMLCanvasElement {
  width = 300;
  height = 150;
  removed = false;
  parentNode: unknown = {};

  remove(): void {
    this.removed = true;
  }
}

function makeCanvas(): HTMLCanvasElement {
  return new FakeHTMLCanvasElement() as unknown as HTMLCanvasElement;
}

const clock = { now: 0 };

function setNow(nowMs: number): void {
  clock.now = nowMs;
}

const h = vi.hoisted(() => {
  class MockContainer {
    static nextId = 1;
    id = MockContainer.nextId++;
    parent: MockContainer | null = null;
    children: MockContainer[] = [];
    destroyed = false;
    position = { set: () => {} };
    scale = { set: () => {} };
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
      return { width: 1, height: 1 };
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  class MockGraphics extends MockContainer {
    clear(): MockGraphics {
      return this;
    }
    rect(): MockGraphics {
      return this;
    }
    roundRect(): MockGraphics {
      return this;
    }
    poly(): MockGraphics {
      return this;
    }
    fill(): MockGraphics {
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
      return { width: this.text.length, height: 10 };
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
    elapsedMS = 16;
    started = false;
    destroyed = false;
    readonly callbacks = new Set<(ticker: MockTicker) => void>();

    add(callback: (ticker: MockTicker) => void): void {
      this.callbacks.add(callback);
    }

    remove(callback: (ticker: MockTicker) => void): void {
      this.callbacks.delete(callback);
    }

    start(): void {
      this.started = true;
    }

    stop(): void {
      this.started = false;
    }

    destroy(): void {
      if (this.destroyed) {
        throw new Error('ticker destroyed twice');
      }
      this.destroyed = true;
      this.callbacks.clear();
    }

    emit(): void {
      for (const callback of [...this.callbacks]) callback(this);
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
    canvas: unknown = null;
    destroyed = false;
    renderCount = 0;
    destroyArgs: unknown[] | null = null;

    constructor() {
      applications.push(this);
    }

    async init(options: Record<string, unknown>): Promise<void> {
      this.canvas = options.canvas ?? null;
      (globalThis as unknown as { __initOptions?: Record<string, unknown> }).__initOptions = options;
    }

    render(): void {
      this.renderCount++;
    }

    destroy(removeView: boolean, options?: unknown): void {
      if (this.destroyed) {
        throw new Error('app destroyed twice');
      }
      this.destroyed = true;
      this.destroyArgs = [removeView, options];
      this.ticker.destroy();
      if (removeView && this.canvas && typeof (this.canvas as { remove?: () => void }).remove === 'function') {
        (this.canvas as { remove: () => void }).remove();
      }
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

import { createRenderSurface, type RenderTextStyle } from '../../src/render';

beforeAll(() => {
  vi.stubGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);
  vi.stubGlobal('performance', { now: () => clock.now });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function lastApplication(): InstanceType<typeof h.MockApplication> {
  return h.applications[h.applications.length - 1];
}

function style(): RenderTextStyle {
  return {
    fontFamily: 'monospace',
    fontSize: 12,
    fill: '#ffffff',
    align: 'left',
    lineHeight: 14,
    fontWeight: 'bold',
  };
}

describe('RenderTicker lifecycle', () => {
  it('add returns unsubscribe and frames use performance.now with first delta zero after every start', async () => {
    setNow(100);
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const frames: Array<{ now: number; delta: number }> = [];
    const unsubscribe = surface.ticker.add((now, delta) => frames.push({ now, delta }));

    expect(typeof unsubscribe).toBe('function');
    surface.ticker.start();
    setNow(110);
    lastApplication().ticker.emit();
    setNow(125.5);
    lastApplication().ticker.elapsedMS = 9999;
    lastApplication().ticker.emit();
    surface.ticker.stop();
    setNow(200);
    lastApplication().ticker.emit();
    surface.ticker.start();
    setNow(500);
    lastApplication().ticker.emit();

    expect(frames).toEqual([
      { now: 110, delta: 0 },
      { now: 125.5, delta: 15.5 },
      { now: 500, delta: 0 },
    ]);
    surface.destroy();
  });

  it('start and stop are idempotent and maintain one underlying listener per running ticker', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const ticker = lastApplication().ticker;

    expect(ticker.callbacks.size).toBe(0);
    surface.ticker.start();
    surface.ticker.start();
    expect(ticker.started).toBe(true);
    expect(ticker.callbacks.size).toBe(1);
    surface.ticker.stop();
    surface.ticker.stop();
    expect(ticker.started).toBe(false);
    expect(ticker.callbacks.size).toBe(0);
    surface.destroy();
  });

  it('unsubscribe is idempotent and stop prevents callback delivery', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    let count = 0;
    const unsubscribe = surface.ticker.add(() => {
      count++;
    });

    surface.ticker.start();
    lastApplication().ticker.emit();
    unsubscribe();
    unsubscribe();
    lastApplication().ticker.emit();
    surface.ticker.stop();
    lastApplication().ticker.emit();

    expect(count).toBe(1);
    surface.destroy();
  });

  it('after surface destroy, ticker add/start throw while stop and existing unsubscribe are no-ops', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const unsubscribe = surface.ticker.add(() => {});
    surface.ticker.start();
    surface.destroy();

    expect(() => surface.ticker.add(() => {})).toThrow(Error);
    expect(() => surface.ticker.start()).toThrow(Error);
    expect(() => surface.ticker.stop()).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('RenderSurface lifecycle', () => {
  it('uses the exact Pixi init options and starts stopped', async () => {
    const canvas = makeCanvas();
    const surface = await createRenderSurface(canvas, { resolution: 2 });
    expect((globalThis as unknown as { __initOptions: Record<string, unknown> }).__initOptions).toEqual({
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

  it('render works while stopped and resize validates finite positive numbers', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    surface.render();
    expect(lastApplication().renderCount).toBe(1);
    surface.resize(40, 30, 2);
    expect(lastApplication().renderer.resolution).toBe(2);
    expect(lastApplication().renderer.resized).toEqual([40, 30]);
    expect(() => surface.resize(0, 30, 1)).toThrow(RangeError);
    expect(() => surface.resize(40, NaN, 1)).toThrow(RangeError);
    expect(() => surface.resize(40, 30, Infinity)).toThrow(RangeError);
    surface.destroy();
  });

  it('resize is atomic: an invalid dimension leaves resolution and size unchanged', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const app = lastApplication();
    surface.resize(40, 30, 2);
    const prevResolution = app.renderer.resolution;
    const prevSize = app.renderer.resized;

    expect(() => surface.resize(NaN, 30, 3)).toThrow(RangeError);
    expect(app.renderer.resolution).toBe(prevResolution);
    expect(app.renderer.resized).toEqual(prevSize);

    expect(() => surface.resize(40, -5, 4)).toThrow(RangeError);
    expect(app.renderer.resolution).toBe(prevResolution);
    expect(app.renderer.resized).toEqual(prevSize);
    surface.destroy();
  });

  it('destroy is idempotent, preserves caller canvas, and lets the app destroy its own ticker once', async () => {
    const canvas = makeCanvas();
    const fakeCanvas = canvas as unknown as FakeHTMLCanvasElement;
    const surface = await createRenderSurface(canvas, { resolution: 1 });
    const app = lastApplication();

    surface.destroy();
    expect(fakeCanvas.removed).toBe(false);
    expect(fakeCanvas.parentNode).toBeTruthy();
    expect(app.destroyArgs).toEqual([
      false,
      { children: true, texture: true, textureSource: true, context: true },
    ]);
    expect(app.ticker.destroyed).toBe(true);
    expect(() => surface.destroy()).not.toThrow();
    expect(() => app.ticker.destroy()).toThrow(Error);
  });

  it('keeps the same destroyed root reference and throws on public methods after destroy', async () => {
    const surface = await createRenderSurface(makeCanvas(), { resolution: 1 });
    const root = surface.root;
    surface.destroy();

    expect(surface.root).toBe(root);
    expect(() => root.add()).toThrow(Error);
    expect(() => root.setScale(1)).toThrow(Error);
    expect(() => surface.createContainer()).toThrow(Error);
    expect(() => surface.createGraphics()).toThrow(Error);
    expect(() => surface.createText('x', style())).toThrow(Error);
    expect(() => surface.createPixel({ width: 1, height: 1, rects: [] })).toThrow(Error);
    expect(() => surface.resize(1, 1, 1)).toThrow(Error);
    expect(() => surface.render()).toThrow(Error);
  });
});
