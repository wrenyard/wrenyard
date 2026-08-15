import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
      return { width: 5, height: 7 };
    }

    destroy(options?: boolean | { children?: boolean }): void {
      if (this.destroyed) return;
      this.destroyed = true;
      (globalThis as unknown as { __destroyOrder: number[] }).__destroyOrder.push(this.id);
    }
  }

  class MockGraphics extends MockContainer {
    _ops: Array<Record<string, unknown>> = [];
    context: { destroyed: boolean };
    destroyContextCalled = false;

    constructor(label = 'graphics') {
      super(label);
      this.context = { destroyed: false };
    }

    releaseContext(): void {
      this.destroyContextCalled = true;
      this.context.destroyed = true;
    }

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

    destroy(options?: boolean | { children?: boolean; context?: boolean }): void {
      if (this.destroyed) return;
      const releaseCtx =
        options === undefined ||
        options === false ||
        options === true ||
        (typeof options !== 'boolean' && options.context === true);
      if (releaseCtx) this.releaseContext();
      const destroyChildren = options === true || (typeof options !== 'boolean' && options.children === true);
      this.children.forEach((child) => {
        if (destroyChildren) {
          child.destroy(options);
        }
      });
      super.destroy(options);
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
      return { width: this.text.length, height: 12 };
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
    private readonly callbacks = new Set<() => void>();
    add(callback: () => void): void {
      this.callbacks.add(callback);
    }
    remove(callback: () => void): void {
      this.callbacks.delete(callback);
    }
    start(): void {}
    stop(): void {}
    destroy(): void {
      this.callbacks.clear();
    }
  }

  class MockApplication {
    stage = new MockContainer('stage');
    renderer = { resolution: 1, resize: () => {} };
    ticker = new MockTicker();
    async init(): Promise<void> {}
    render(): void {}
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
  createRenderSurface,
  type RenderContainer,
  type RenderTextStyle,
  type ShapeCommand,
} from '../../src/render';

beforeAll(() => {
  vi.stubGlobal('HTMLCanvasElement', FakeHTMLCanvasElement);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  (globalThis as unknown as { __destroyOrder: number[] }).__destroyOrder = [];
});

function children(node: unknown): unknown[] {
  return (node as { container: { children: unknown[] } }).container.children;
}

function pixiContainer(node: unknown): unknown {
  return (node as { container: unknown }).container;
}

function destroyed(node: unknown): boolean {
  return (node as { container: { destroyed: boolean } }).container.destroyed;
}

function destroyOrder(): number[] {
  return (globalThis as unknown as { __destroyOrder: number[] }).__destroyOrder;
}

function pixiId(node: unknown): number {
  return (node as { container: { id: number } }).container.id;
}

function baseStyle(): RenderTextStyle {
  return {
    fontFamily: 'monospace',
    fontSize: 12,
    fill: '#000000',
    align: 'left',
    lineHeight: 14,
    fontWeight: 'normal',
  };
}

async function surface() {
  return createRenderSurface(makeCanvas(), { resolution: 1 });
}

describe('container ownership', () => {
  it('factories return unattached nodes and add preserves argument order', async () => {
    const s = await surface();
    const a = s.createContainer();
    const b = s.createGraphics();
    const c = s.createText('x', baseStyle());

    expect(children(s.root)).toEqual([]);
    s.root.add(a, b, c);
    expect(children(s.root)).toEqual([pixiContainer(a), pixiContainer(b), pixiContainer(c)]);
    s.destroy();
  });

  it('duplicate same-parent add is a no-op, and reparent detaches then appends', async () => {
    const s = await surface();
    const parentA = s.createContainer();
    const parentB = s.createContainer();
    const child = s.createGraphics();
    const sibling = s.createContainer();
    s.root.add(parentA, parentB);
    parentA.add(child, sibling);

    parentA.add(child);
    expect(children(parentA)).toEqual([pixiContainer(child), pixiContainer(sibling)]);

    parentB.add(child);
    expect(children(parentA)).toEqual([pixiContainer(sibling)]);
    expect(children(parentB)).toEqual([pixiContainer(child)]);
    s.destroy();
  });

  it('rejects destroyed child, self add, and ancestor cycles without changing ownership', async () => {
    const s = await surface();
    const parent = s.createContainer() as RenderContainer;
    const child = s.createContainer();
    s.root.add(parent);
    parent.add(child);
    const before = [...children(parent)];

    expect(() => parent.add(parent)).toThrow(Error);
    expect(() => child.add(parent)).toThrow(Error);
    expect(children(parent)).toEqual(before);

    const destroyedChild = s.createContainer();
    destroyedChild.destroy();
    expect(() => parent.add(destroyedChild)).toThrow(Error);
    expect(children(parent)).toEqual(before);
    s.destroy();
  });

  it('remove detaches direct children without destroy and no-ops for absent, non-direct, and destroyed', async () => {
    const s = await surface();
    const parent = s.createContainer();
    const nested = s.createContainer();
    const direct = s.createContainer();
    const absent = s.createContainer();
    s.root.add(parent);
    parent.add(nested, direct);
    nested.add(absent);

    expect(() => parent.remove(absent)).not.toThrow();
    parent.remove(direct);
    expect(destroyed(direct)).toBe(false);
    expect(children(parent)).toEqual([pixiContainer(nested)]);

    nested.destroy();
    expect(() => parent.remove(nested)).not.toThrow();
    expect(children(parent)).toEqual([]);
    s.destroy();
  });

  it('child destroy detaches, and container destroy recurses in insertion order', async () => {
    const s = await surface();
    const parent = s.createContainer();
    const first = s.createContainer();
    const second = s.createGraphics();
    s.root.add(parent);
    parent.add(first, second);

    first.destroy();
    expect(children(parent)).toEqual([pixiContainer(second)]);

    const secondId = pixiId(second);
    const parentId = pixiId(parent);
    s.destroy();
    expect(destroyOrder().indexOf(secondId)).toBeLessThan(destroyOrder().indexOf(parentId));
  });
});

describe('node lifecycle methods', () => {
  it('validates finite transforms, clamps alpha, and allows negative scale', async () => {
    const s = await surface();
    const node = s.createContainer();
    node.setPosition(1, 2);
    node.setScale(-2, 3);
    node.setAlpha(2);
    node.setVisible(false);

    expect((node as { container: { position: { x: number; y: number } } }).container.position).toMatchObject({ x: 1, y: 2 });
    expect((node as { container: { scale: { x: number; y: number } } }).container.scale).toMatchObject({ x: -2, y: 3 });
    expect((node as { container: { alpha: number; visible: boolean } }).container.alpha).toBe(1);
    expect((node as { container: { alpha: number; visible: boolean } }).container.visible).toBe(false);
    expect(() => node.setPosition(NaN, 0)).toThrow(RangeError);
    expect(() => node.setScale(1, Infinity)).toThrow(RangeError);
    expect(() => node.setAlpha(NaN)).toThrow(RangeError);
    s.destroy();
  });

  it('throws after destroy for every public method except repeated destroy', async () => {
    const s = await surface();
    const container = s.createContainer();
    const graphics = s.createGraphics();
    const text = s.createText('x', baseStyle());
    const pixel = s.createPixel({ width: 1, height: 1, rects: [] });
    s.root.add(container, graphics, text, pixel);

    container.destroy();
    graphics.destroy();
    text.destroy();
    pixel.destroy();

    expect(() => container.add()).toThrow(Error);
    expect(() => container.remove(graphics)).toThrow(Error);
    expect(() => container.setPosition(0, 0)).toThrow(Error);
    expect(() => graphics.setCommands([])).toThrow(Error);
    expect(() => text.setText('y')).toThrow(Error);
    expect(() => text.setStyle(baseStyle())).toThrow(Error);
    expect(() => text.measure()).toThrow(Error);
    expect(() => pixel.setProgram({ width: 1, height: 1, rects: [] })).toThrow(Error);
    expect(() => container.destroy()).not.toThrow();
    expect(() => graphics.destroy()).not.toThrow();
    expect(() => text.destroy()).not.toThrow();
    expect(() => pixel.destroy()).not.toThrow();
    s.destroy();
  });

  it('destroying a graphics releases its context without destroying sibling or parent', async () => {
    const s = await surface();
    const parent = s.createContainer();
    const graphics = s.createGraphics();
    const sibling = s.createContainer();
    parent.add(graphics, sibling);

    const siblingId = pixiId(sibling);
    const parentId = pixiId(parent);
    graphics.destroy();
    expect(destroyed(graphics)).toBe(true);
    const gContainer = pixiContainer(graphics) as unknown as {
      context: { destroyed: boolean };
      destroyContextCalled: boolean;
    };
    expect(gContainer.destroyContextCalled).toBe(true);
    expect(gContainer.context.destroyed).toBe(true);
    expect(destroyed(sibling)).toBe(false);
    expect(destroyed(parent)).toBe(false);
    expect(destroyOrder().includes(siblingId)).toBe(false);
    expect(destroyOrder().includes(parentId)).toBe(false);
    expect(children(parent)).toEqual([pixiContainer(sibling)]);
    expect(pixiContainer(sibling).children).toBeDefined();
    sibling.setPosition(1, 1);
    expect(pixiContainer(sibling).position).toMatchObject({ x: 1, y: 1 });
    expect(siblingId).toBe(pixiId(sibling));
    parent.setAlpha(0.5);
    expect((pixiContainer(parent) as { alpha: number }).alpha).toBe(0.5);
    s.destroy();
  });
});

describe('defensive copies', () => {
  it('copies commands and polygon points before rendering', async () => {
    const s = await surface();
    const points = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }];
    const commands: ShapeCommand[] = [{ kind: 'polygon', points, fill: '#fff' }];
    const graphics = s.createGraphics(commands);
    points[0].x = 99;

    expect((graphics as { container: { _ops: Array<{ points: number[] }> } }).container._ops[0].points).toEqual([0, 0, 3, 0, 0, 3]);
    s.destroy();
  });

  it('copies text style and pixel programs before caller mutation', async () => {
    const s = await surface();
    const style = baseStyle();
    const text = s.createText('a', style);
    style.fontSize = 99;
    expect((text as { container: { style: { opts: { fontSize: number } } } }).container.style.opts.fontSize).toBe(12);

    const program = { width: 2, height: 1, rects: [{ x: 0, y: 0, width: 1, height: 1, color: 0x010203 }] };
    const pixel = s.createPixel(program);
    program.rects[0].width = 2;
    const texture = (pixel as {
      container: { texture: { opts: { source: { opts: { resource: Uint8ClampedArray } } } } };
    }).container.texture;
    expect(texture.opts.source.opts.resource[4]).toBe(0);
    s.destroy();
  });
});
