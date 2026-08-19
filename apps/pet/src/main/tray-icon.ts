import { nativeImage, type NativeImage } from 'electron';

/** Menu-bar sized product mark. 18pt @2x, not a quota meter. */
export const TRAY_ICON_SIZE = 18;
export const TRAY_ICON_SCALE = 2;
export const TRAY_ICON_FILL_ALPHA = 255;

/**
 * Classic house silhouette: ridge, left chimney, eave, two 1F windows, door.
 * Template bitmap so AppKit tints it with the menu-bar foreground.
 */
export const TRAY_HOUSE_GLYPH: readonly string[] = [
  '                  ',
  '         ##       ',
  '        ####      ',
  '   ##  ######     ',
  '   ## ########    ',
  '   ############   ',
  '  ##############  ',
  '  ##############  ',
  '  ##          ##  ',
  '  ##  ##  ##  ##  ',
  '  ##  ##  ##  ##  ',
  '  ##          ##  ',
  '  ##    ##    ##  ',
  '  ##    ##    ##  ',
  '  ##    ##    ##  ',
  '  ##############  ',
  '                  ',
  '                  ',
];

export function renderTrayIconBitmap(): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  const pixelWidth = TRAY_ICON_SIZE * TRAY_ICON_SCALE;
  const pixelHeight = TRAY_ICON_SIZE * TRAY_ICON_SCALE;
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);
  for (let y = 0; y < TRAY_ICON_SIZE; y++) {
    const row = TRAY_HOUSE_GLYPH[y] ?? '';
    for (let x = 0; x < TRAY_ICON_SIZE; x++) {
      if (row[x] !== '#') continue;
      fillLogicalPixel(buffer, pixelWidth, x, y);
    }
  }
  return { pixelWidth, pixelHeight, scale: TRAY_ICON_SCALE, buffer };
}

export function createTrayIcon(): NativeImage {
  const rendered = renderTrayIconBitmap();
  const image = nativeImage.createFromBuffer(rendered.buffer, {
    width: rendered.pixelWidth,
    height: rendered.pixelHeight,
    scaleFactor: rendered.scale,
  });
  image.setTemplateImage(true);
  return image;
}

function fillLogicalPixel(buffer: Buffer, strideWidth: number, x: number, y: number): void {
  const x0 = x * TRAY_ICON_SCALE;
  const y0 = y * TRAY_ICON_SCALE;
  for (let py = y0; py < y0 + TRAY_ICON_SCALE; py++) {
    for (let px = x0; px < x0 + TRAY_ICON_SCALE; px++) {
      const i = (py * strideWidth + px) * 4;
      buffer[i] = 0;
      buffer[i + 1] = 0;
      buffer[i + 2] = 0;
      buffer[i + 3] = TRAY_ICON_FILL_ALPHA;
    }
  }
}
