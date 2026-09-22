import { BufferImageSource, Sprite, Texture } from 'pixi.js';
import type { PixelProgram, RenderPixel } from '../types';
import { clonePixelProgram, normalizeColor } from '../validation';
import { PixiRenderNode } from './node';

export class PixiRenderPixel extends PixiRenderNode implements RenderPixel {
  private readonly sprite: Sprite;
  private texture: Texture | null = null;
  private program: PixelProgram | null = null;

  constructor(sprite: Sprite) {
    super(sprite);
    this.sprite = sprite;
  }

  setProgram(program: PixelProgram): void {
    this.assertAlive();
    this.program = clonePixelProgram(program);
    this.rebuildTexture();
  }

  destroy(): void {
    if (this._destroyed) return;
    this.releaseTexture();
    super.destroy();
  }

  private rebuildTexture(): void {
    if (!this.program) return;
    const { width, height } = this.program;
    const pixels = new Uint8ClampedArray(width * height * 4);

    for (const rect of this.program.rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;

      const x0 = Math.max(0, rect.x);
      const y0 = Math.max(0, rect.y);
      const x1 = Math.min(width, rect.x + rect.width);
      const y1 = Math.min(height, rect.y + rect.height);
      if (x1 <= x0 || y1 <= y0) continue;

      const color = normalizeColor(rect.color);
      const alpha = Math.round((rect.alpha ?? 1) * 255);
      for (let y = y0; y < y1; y++) {
        let offset = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++) {
          pixels[offset] = (color >> 16) & 0xff;
          pixels[offset + 1] = (color >> 8) & 0xff;
          pixels[offset + 2] = color & 0xff;
          pixels[offset + 3] = alpha;
          offset += 4;
        }
      }
    }

    this.releaseTexture();
    const source = new BufferImageSource({
      resource: pixels,
      width,
      height,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      antialias: false,
    });
    this.texture = new Texture({ source });
    this.sprite.texture = this.texture;
  }

  private releaseTexture(): void {
    if (!this.texture) return;
    this.sprite.texture = Texture.EMPTY;
    this.texture.destroy(true);
    this.texture = null;
  }
}
