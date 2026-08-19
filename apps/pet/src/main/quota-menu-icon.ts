import { nativeImage, type NativeImage } from 'electron';
import type { QuotaMenuRow } from './panel-view-model';

export const QUOTA_MENU_SCALE = 2;
export const QUOTA_MENU_ROW_WIDTH = 328;
export const QUOTA_MENU_ROW_HEIGHT = 22;

const TEXT = [0, 0, 0, 255] as const;
const TRACK = [0, 0, 0, 48] as const;
const FILL = [0, 0, 0, 230] as const;
const MARKER = [0, 0, 0, 255] as const;
export const QUOTA_MENU_FILL_ALPHA = 230;

const PROVIDER_X = 8;
const WINDOW_X = 104;
export const QUOTA_MENU_BAR_X = 140;
export const QUOTA_MENU_BAR_Y = 8;
export const QUOTA_MENU_BAR_W = 100;
export const QUOTA_MENU_BAR_H = 6;
const PCT_X = 248;
const TEXT_Y = 8;

/** 5×7 glyphs, bit4 = leftmost pixel. */
const GLYPHS: Record<string, readonly number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b01110, 0, 0, 0],
  '%': [0b10001, 0b10010, 0b00100, 0b01000, 0b10010, 0b10001, 0],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  a: [0, 0, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
  b: [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  c: [0, 0, 0b01110, 0b10000, 0b10000, 0b10000, 0b01110],
  d: [0b00001, 0b00001, 0b01111, 0b10001, 0b10001, 0b10001, 0b01111],
  e: [0, 0, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
  f: [0b00110, 0b01000, 0b11100, 0b01000, 0b01000, 0b01000, 0b01000],
  g: [0, 0, 0b01111, 0b10001, 0b01111, 0b00001, 0b01110],
  h: [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b10001],
  i: [0b00100, 0, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
  j: [0b00010, 0, 0b00110, 0b00010, 0b00010, 0b10010, 0b01100],
  k: [0b10000, 0b10000, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010],
  l: [0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  m: [0, 0, 0b11010, 0b10101, 0b10101, 0b10101, 0b10101],
  n: [0, 0, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
  o: [0, 0, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
  p: [0, 0, 0b11110, 0b10001, 0b11110, 0b10000, 0b10000],
  q: [0, 0, 0b01111, 0b10001, 0b01111, 0b00001, 0b00001],
  r: [0, 0, 0b10110, 0b11000, 0b10000, 0b10000, 0b10000],
  s: [0, 0, 0b01111, 0b10000, 0b01110, 0b00001, 0b11110],
  t: [0b01000, 0b01000, 0b11100, 0b01000, 0b01000, 0b01000, 0b00110],
  u: [0, 0, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
  v: [0, 0, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  w: [0, 0, 0b10001, 0b10001, 0b10101, 0b10101, 0b01010],
  x: [0, 0, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  y: [0, 0, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  z: [0, 0, 0b11111, 0b00010, 0b00100, 0b01000, 0b11111],
};

export function renderQuotaMenuRowBitmap(row: QuotaMenuRow): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  const pixelWidth = QUOTA_MENU_ROW_WIDTH * QUOTA_MENU_SCALE;
  const pixelHeight = QUOTA_MENU_ROW_HEIGHT * QUOTA_MENU_SCALE;
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);

  if (row.error) {
    drawString(buffer, pixelWidth, PROVIDER_X, TEXT_Y, row.provider, 88);
    drawString(buffer, pixelWidth, WINDOW_X, TEXT_Y, row.error, QUOTA_MENU_ROW_WIDTH - WINDOW_X - 8);
    return { pixelWidth, pixelHeight, scale: QUOTA_MENU_SCALE, buffer };
  }

  if (row.provider) drawString(buffer, pixelWidth, PROVIDER_X, TEXT_Y, row.provider, 88);
  if (row.window) drawString(buffer, pixelWidth, WINDOW_X, TEXT_Y, row.window, 28);

  if (row.remainingPct !== null) {
    fillRect(buffer, pixelWidth, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y, QUOTA_MENU_BAR_W, QUOTA_MENU_BAR_H, TRACK);
    const fillWidth = Math.max(0, Math.round((row.remainingPct / 100) * QUOTA_MENU_BAR_W));
    if (fillWidth > 0) fillRect(buffer, pixelWidth, QUOTA_MENU_BAR_X, QUOTA_MENU_BAR_Y, fillWidth, QUOTA_MENU_BAR_H, FILL);
    if (row.expectedRemainingPct !== null) {
      const markerX = QUOTA_MENU_BAR_X + Math.round((row.expectedRemainingPct / 100) * QUOTA_MENU_BAR_W);
      fillRect(
        buffer,
        pixelWidth,
        Math.min(QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, Math.max(QUOTA_MENU_BAR_X, markerX)),
        QUOTA_MENU_BAR_Y,
        1,
        QUOTA_MENU_BAR_H,
        MARKER,
      );
    }
    const remain = Math.round(Math.min(100, Math.max(0, row.remainingPct)));
    drawString(buffer, pixelWidth, PCT_X, TEXT_Y, `${remain}% remain`, 72);
  }

  return { pixelWidth, pixelHeight, scale: QUOTA_MENU_SCALE, buffer };
}

export function createQuotaMenuRowIcon(row: QuotaMenuRow): NativeImage {
  const rendered = renderQuotaMenuRowBitmap(row);
  const image = nativeImage.createFromBuffer(rendered.buffer, {
    width: rendered.pixelWidth,
    height: rendered.pixelHeight,
    scaleFactor: rendered.scale,
  });
  // CodexBar's menu-bar meters are 18×18 template images: the bitmap is a
  // luminance/alpha mask and AppKit tints it with the current menu/status
  // foreground. Baking light-gray pixels (previous revision) is unreadable
  // on Aqua menus; baking green is similarly appearance-locked.
  image.setTemplateImage(true);
  return image;
}

function fillRect(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly number[],
): void {
  const x0 = Math.max(0, Math.floor(x * QUOTA_MENU_SCALE));
  const y0 = Math.max(0, Math.floor(y * QUOTA_MENU_SCALE));
  const x1 = Math.min(strideWidth, Math.ceil((x + w) * QUOTA_MENU_SCALE));
  const y1 = Math.min(buffer.length / (strideWidth * 4), Math.ceil((y + h) * QUOTA_MENU_SCALE));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * strideWidth + px) * 4;
      buffer[i] = color[0];
      buffer[i + 1] = color[1];
      buffer[i + 2] = color[2];
      buffer[i + 3] = color[3];
    }
  }
}

function drawString(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  text: string,
  maxWidth: number,
): void {
  let cursor = x;
  const maxX = x + maxWidth;
  for (const raw of text.toLowerCase()) {
    const ch = raw === '—' || raw === '–' ? '-' : raw;
    if (cursor + 6 > maxX) break;
    const glyph = GLYPHS[ch] ?? GLYPHS['-'];
    drawGlyph(buffer, strideWidth, cursor, y, glyph);
    cursor += 6;
  }
}

function drawGlyph(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  glyph: readonly number[],
): void {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row] ?? 0;
    for (let col = 0; col < 5; col++) {
      if (((bits >> (4 - col)) & 1) === 1) {
        fillRect(buffer, strideWidth, x + col, y + row, 1, 1, TEXT);
      }
    }
  }
}
