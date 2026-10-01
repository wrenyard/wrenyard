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

/**
 * Whether a pixel program paints a non-transparent pixel at `(x, y)`.
 *
 * Pet hit testing uses this against the authored sprite program instead of
 * reading the WebGL canvas back, so transparent sprite pixels keep passing the
 * pointer through without a GPU readback.
 */
export function pixelProgramCoversPoint(
  program: PixelProgram,
  x: number,
  y: number,
): boolean {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= program.width || py >= program.height) return false;
  for (const rect of program.rects) {
    if (px < rect.x || px >= rect.x + rect.width) continue;
    if (py < rect.y || py >= rect.y + rect.height) continue;
    if ((rect.alpha ?? 1) > 0) return true;
  }
  return false;
}
