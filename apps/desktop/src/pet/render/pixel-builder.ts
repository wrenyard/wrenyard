import {
  assertInteger,
  assertPositiveInteger,
  clampAlpha,
  freezePixelProgram,
  validateColor,
} from './validation';
import type { PixelProgram, PixelRect, RenderColor } from './types';

export class PixelBuilder {
  private readonly width: number;
  private readonly height: number;
  private readonly rects: PixelRect[] = [];

  constructor(width: number, height: number) {
    this.width = assertPositiveInteger(width, 'width');
    this.height = assertPositiveInteger(height, 'height');
  }

  rect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: RenderColor,
    alpha?: number,
  ): this {
    const rectX = assertInteger(x, 'rect x');
    const rectY = assertInteger(y, 'rect y');
    const rectWidth = assertInteger(width, 'rect width');
    const rectHeight = assertInteger(height, 'rect height');
    validateColor(color, 'rect color');
    const rectAlpha = clampAlpha(alpha, 'rect alpha');

    if (rectWidth <= 0 || rectHeight <= 0) return this;

    const x0 = Math.max(0, rectX);
    const y0 = Math.max(0, rectY);
    const x1 = Math.min(this.width, rectX + rectWidth);
    const y1 = Math.min(this.height, rectY + rectHeight);
    if (x1 <= x0 || y1 <= y0) return this;

    this.rects.push({
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      color,
      alpha: rectAlpha,
    });
    return this;
  }

  build(): PixelProgram {
    const rects = this.rects.map((rect) => ({ ...rect }));
    return freezePixelProgram({
      width: this.width,
      height: this.height,
      rects,
    });
  }
}
