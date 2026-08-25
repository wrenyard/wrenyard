import { nativeImage, type NativeImage } from 'electron';
import { floorQuotaPercentage } from '../shared/quota-percentage';
import type { QuotaMenuRow } from './panel-view-model';

export const QUOTA_MENU_SCALE = 2;
export const QUOTA_MENU_ROW_WIDTH = 328;
export const QUOTA_MENU_ROW_HEIGHT = 22;

/** Vertical pitch between content lines inside one provider group. */
export const QUOTA_MENU_LINE_STEP = 10;
export const QUOTA_MENU_GLYPH_H = 7;
/** Provider glyphs are thickened in place (each set row 2px tall), keeping 5x7 proportions. */
export const QUOTA_MENU_PROVIDER_GLYPH_H = 8;
export const QUOTA_MENU_GROUP_PAD_TOP = 4;
export const QUOTA_MENU_GROUP_PAD_BOTTOM = 4;

export const QUOTA_MENU_BAR_X = 140;
export const QUOTA_MENU_BAR_Y = QUOTA_MENU_GROUP_PAD_TOP;
export const QUOTA_MENU_BAR_W = 100;
export const QUOTA_MENU_BAR_H = 6;

export const QUOTA_MENU_FILL_ALPHA = 255;
export const QUOTA_MENU_TRACK_ALPHA = 88;
export const QUOTA_MENU_PROVIDER_ALPHA = 255;
export const QUOTA_MENU_CHILD_ALPHA = 150;
export const QUOTA_MENU_AMOUNT_ALPHA = 255;
export const QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA = 32;
export const QUOTA_MENU_PACE_MARKER_ON_TRACK_ALPHA = 255;

const PROVIDER_X = 8;
const WINDOW_X = 104;
/** Indented child column: parent + 6px. */
export const QUOTA_MENU_CHILD_X = WINDOW_X + 6;
/** Balance label keeps the full label column, leaving a glyph-space before amount. */
export const QUOTA_MENU_BALANCE_X = WINDOW_X;
const PCT_X = 248;
const PROVIDER_MAX = QUOTA_MENU_BAR_X - PROVIDER_X - 8;
const CHILD_MAX = QUOTA_MENU_BAR_X - QUOTA_MENU_CHILD_X - 4;
const BALANCE_MAX = QUOTA_MENU_BAR_X - QUOTA_MENU_BALANCE_X - 4;
const PCT_MAX = QUOTA_MENU_ROW_WIDTH - PCT_X - 8;
const AMOUNT_MAX = QUOTA_MENU_ROW_WIDTH - QUOTA_MENU_BAR_X - 8;
const ERROR_MAX = QUOTA_MENU_ROW_WIDTH - QUOTA_MENU_CHILD_X - 8;

const TRACK = [0, 0, 0, QUOTA_MENU_TRACK_ALPHA] as const;
const FILL = [0, 0, 0, QUOTA_MENU_FILL_ALPHA] as const;
const PROVIDER_COLOR = [0, 0, 0, QUOTA_MENU_PROVIDER_ALPHA] as const;
const CHILD_COLOR = [0, 0, 0, QUOTA_MENU_CHILD_ALPHA] as const;
const AMOUNT_COLOR = [0, 0, 0, QUOTA_MENU_AMOUNT_ALPHA] as const;
const MARKER_ON_FILL = [0, 0, 0, QUOTA_MENU_PACE_MARKER_ON_FILL_ALPHA] as const;
const MARKER_ON_TRACK = [0, 0, 0, QUOTA_MENU_PACE_MARKER_ON_TRACK_ALPHA] as const;

/** 5×7 glyphs, bit4 = leftmost pixel. */
const GLYPHS: Record<string, readonly number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b01110, 0, 0, 0],
  '%': [0b10001, 0b10010, 0b00100, 0b01000, 0b10010, 0b10001, 0],
  '.': [0, 0, 0, 0, 0, 0b00100, 0b00100],
  '$': [0b00100, 0b01110, 0b10100, 0b01110, 0b00101, 0b01110, 0b00100],
  '¥': [0b10001, 0b10001, 0b01010, 0b11111, 0b00100, 0b00100, 0b00100],
  '€': [0b01110, 0b10000, 0b11110, 0b10000, 0b11110, 0b10000, 0b01110],
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

/** A flattened, consecutive group of rows sharing one provider id. */
export interface QuotaMenuGroup {
  provider: string;
  lines: QuotaMenuRow[];
}

/**
 * Group the flattened (provider-first / blank-continuation) rows so each
 * provider renders as a single compact icon item in the status quota submenu.
 */
export function groupQuotaMenuRows(rows: QuotaMenuRow[]): QuotaMenuGroup[] {
  const groups: QuotaMenuGroup[] = [];
  let current: QuotaMenuGroup | undefined;
  for (const row of rows) {
    if (row.provider) {
      current = { provider: row.provider, lines: [] };
      groups.push(current);
    } else if (!current) {
      current = { provider: '', lines: [] };
      groups.push(current);
    }
    current.lines.push(row);
  }
  return groups;
}

export function renderQuotaMenuGroupBitmap(group: QuotaMenuGroup): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  const lineCount = Math.max(1, group.lines.length);
  // Provider glyphs are thickened in place (8px extent), so a single line keeps
  // the minimum row height while multi-line groups stay compact.
  const contentTop = QUOTA_MENU_GROUP_PAD_TOP;
  const providerBottom = contentTop + QUOTA_MENU_PROVIDER_GLYPH_H;
  const lastLineBottom = contentTop + (lineCount - 1) * QUOTA_MENU_LINE_STEP + QUOTA_MENU_GLYPH_H;
  const contentBottom = Math.max(providerBottom, lastLineBottom);
  const logicalHeight = Math.max(QUOTA_MENU_ROW_HEIGHT, contentBottom + QUOTA_MENU_GROUP_PAD_BOTTOM);

  const pixelWidth = QUOTA_MENU_ROW_WIDTH * QUOTA_MENU_SCALE;
  const pixelHeight = logicalHeight * QUOTA_MENU_SCALE;
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);

  group.lines.forEach((row, index) => {
    const lineTop = QUOTA_MENU_GROUP_PAD_TOP + index * QUOTA_MENU_LINE_STEP;
    renderMenuLine(buffer, pixelWidth, lineTop, row, index === 0);
  });

  return { pixelWidth, pixelHeight, scale: QUOTA_MENU_SCALE, buffer };
}

function renderMenuLine(
  buffer: Buffer,
  strideWidth: number,
  lineTop: number,
  row: QuotaMenuRow,
  isFirstLine: boolean,
): void {
  if (row.error) {
    if (isFirstLine) {
      drawString(buffer, strideWidth, PROVIDER_X, lineTop, row.provider, PROVIDER_MAX, PROVIDER_COLOR, true);
    }
    drawString(buffer, strideWidth, QUOTA_MENU_CHILD_X, lineTop, row.error, ERROR_MAX, CHILD_COLOR);
    return;
  }

  // Monetary balance rows: provider | bal. | right-aligned amount starting at
  // the bar column. No track/fill/pace marker/percentage semantics.
  if (row.balances && row.balances.length > 0) {
    if (isFirstLine) {
      drawString(buffer, strideWidth, PROVIDER_X, lineTop, row.provider, PROVIDER_MAX, PROVIDER_COLOR, true);
    }
    drawString(buffer, strideWidth, QUOTA_MENU_BALANCE_X, lineTop, 'bal.', BALANCE_MAX, CHILD_COLOR);
    const amount = row.balances[0].display || row.balances[0].amount;
    drawString(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, amount, AMOUNT_MAX, AMOUNT_COLOR);
    return;
  }

  if (isFirstLine) {
    drawString(buffer, strideWidth, PROVIDER_X, lineTop, row.provider, PROVIDER_MAX, PROVIDER_COLOR, true);
  }
  if (row.window) drawString(buffer, strideWidth, QUOTA_MENU_CHILD_X, lineTop, row.window, CHILD_MAX, CHILD_COLOR);

  if (row.remainingPct !== null) {
    fillRect(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, QUOTA_MENU_BAR_W, QUOTA_MENU_BAR_H, TRACK);
    const fillWidth = Math.max(0, Math.round((row.remainingPct / 100) * QUOTA_MENU_BAR_W));
    if (fillWidth > 0) fillRect(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, fillWidth, QUOTA_MENU_BAR_H, FILL);
    if (row.expectedRemainingPct !== null) {
      const markerX = QUOTA_MENU_BAR_X + Math.round((row.expectedRemainingPct / 100) * QUOTA_MENU_BAR_W);
      const clampedMarkerX = Math.min(
        QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1,
        Math.max(QUOTA_MENU_BAR_X, markerX),
      );
      const markerOverFill = clampedMarkerX - QUOTA_MENU_BAR_X < fillWidth;
      fillRect(
        buffer,
        strideWidth,
        clampedMarkerX,
        lineTop,
        1,
        QUOTA_MENU_BAR_H,
        markerOverFill ? MARKER_ON_FILL : MARKER_ON_TRACK,
      );
    }
    const remain = floorQuotaPercentage(row.remainingPct);
    drawString(buffer, strideWidth, PCT_X, lineTop, `${remain}% remain`, PCT_MAX, AMOUNT_COLOR);
  }
}

/** Single-row render kept for compatibility; delegates to a one-row group. */
export function renderQuotaMenuRowBitmap(row: QuotaMenuRow): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  return renderQuotaMenuGroupBitmap({ provider: row.provider, lines: [row] });
}

export function createQuotaMenuGroupIcon(group: QuotaMenuGroup): NativeImage {
  const rendered = renderQuotaMenuGroupBitmap(group);
  const image = nativeImage.createFromBuffer(rendered.buffer, {
    width: rendered.pixelWidth,
    height: rendered.pixelHeight,
    scaleFactor: rendered.scale,
  });
  // CodexBar's menu-bar meters are template images: the bitmap is a
  // luminance/alpha mask and AppKit tints it with the current menu/status
  // foreground. Baking light-gray or colored pixels is unreadable on Aqua
  // menus or appearance-locked.
  image.setTemplateImage(true);
  return image;
}

export function createQuotaMenuRowIcon(row: QuotaMenuRow): NativeImage {
  return createQuotaMenuGroupIcon({ provider: row.provider, lines: [row] });
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
  color: readonly number[],
  thick = false,
): void {
  let cursor = x;
  const maxX = x + maxWidth;
  for (const raw of text.toLowerCase()) {
    const ch = raw === '—' || raw === '–' ? '-' : raw;
    if (cursor + 6 > maxX) break;
    const glyph = GLYPHS[ch] ?? GLYPHS['-'];
    if (thick) drawGlyphThick(buffer, strideWidth, cursor, y, glyph, color);
    else drawGlyph(buffer, strideWidth, cursor, y, glyph, color);
    cursor += 6;
  }
}

function drawGlyph(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  glyph: readonly number[],
  color: readonly number[],
): void {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row] ?? 0;
    for (let col = 0; col < 5; col++) {
      if (((bits >> (4 - col)) & 1) === 1) {
        fillRect(buffer, strideWidth, x + col, y + row, 1, 1, color);
      }
    }
  }
}

/** Vertically thickened glyph (each set row 2px tall); column width unchanged. */
function drawGlyphThick(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  glyph: readonly number[],
  color: readonly number[],
): void {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row] ?? 0;
    for (let col = 0; col < 5; col++) {
      if (((bits >> (4 - col)) & 1) === 1) {
        fillRect(buffer, strideWidth, x + col, y + row, 1, 2, color);
      }
    }
  }
}
