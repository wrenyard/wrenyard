import { createRequire } from 'node:module';
import type { NativeImage } from 'electron';
import type { QuotaProviderSnapshot } from './shell-contract.js';

const require = createRequire(import.meta.url);

export const QUOTA_MENU_SCALE = 2;
/** Original compact AppKit template-bitmap width, including the 8px safety inset. */
export const QUOTA_MENU_ROW_WIDTH = 280;
export const QUOTA_MENU_ROW_HEIGHT = 22;
export const QUOTA_MENU_LINE_STEP = 16;
export const QUOTA_MENU_GLYPH_H = 7;
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
const WINDOW_X = 102;
export const QUOTA_MENU_CHILD_X = WINDOW_X + 6;
export const QUOTA_MENU_BALANCE_X = QUOTA_MENU_CHILD_X;
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

/** Original 5×7 menu glyphs, bit4 = leftmost pixel. */
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

interface QuotaMenuLine {
  provider: string;
  window: string;
  remainingPct: number | null;
  expectedRemainingPct: number | null;
  error?: string;
  amount?: string;
}

export interface QuotaMenuProviderGroup {
  provider: string;
  lines: QuotaMenuLine[];
}

export function buildQuotaMenuProviderGroup(provider: QuotaProviderSnapshot): QuotaMenuProviderGroup {
  const lines: QuotaMenuLine[] = provider.windows.map((window, index) => ({
    provider: index === 0 ? provider.label : '',
    window: window.name,
    remainingPct: window.remainingPct,
    expectedRemainingPct: window.expectedRemainingPct,
  }));
  provider.balances.forEach((balance, index) => lines.push({
    provider: lines.length === 0 && index === 0 ? provider.label : '',
    window: '',
    remainingPct: null,
    expectedRemainingPct: null,
    amount: balance.display || balance.amount,
  }));
  if (lines.length === 0) {
    lines.push({
      provider: provider.label,
      window: '',
      remainingPct: null,
      expectedRemainingPct: null,
      error: provider.message ?? provider.displayLine ?? statusLabel(provider.status),
    });
  }
  return { provider: provider.label, lines };
}

export function formatQuotaMenuPercentageText(remainingPct: number): string {
  return `${Math.floor(clamp(remainingPct))}%`;
}

export function renderQuotaMenuProviderBitmap(provider: QuotaProviderSnapshot): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  return renderQuotaMenuGroupBitmap(buildQuotaMenuProviderGroup(provider));
}

export function renderQuotaMenuGroupBitmap(group: QuotaMenuProviderGroup): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  const lineCount = Math.max(1, group.lines.length);
  const contentTop = QUOTA_MENU_GROUP_PAD_TOP;
  const lastLineBottom = contentTop + (lineCount - 1) * QUOTA_MENU_LINE_STEP + QUOTA_MENU_GLYPH_H;
  const logicalHeight = Math.max(QUOTA_MENU_ROW_HEIGHT, lastLineBottom + QUOTA_MENU_GROUP_PAD_BOTTOM);
  const pixelWidth = QUOTA_MENU_ROW_WIDTH * QUOTA_MENU_SCALE;
  const pixelHeight = logicalHeight * QUOTA_MENU_SCALE;
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);

  group.lines.forEach((line, index) => {
    renderMenuLine(buffer, pixelWidth, QUOTA_MENU_GROUP_PAD_TOP + index * QUOTA_MENU_LINE_STEP, line, index === 0);
  });
  return { pixelWidth, pixelHeight, scale: QUOTA_MENU_SCALE, buffer };
}

export function createQuotaMenuProviderIcon(provider: QuotaProviderSnapshot): NativeImage {
  const { nativeImage } = require('electron') as typeof import('electron');
  const rendered = renderQuotaMenuProviderBitmap(provider);
  const image = nativeImage.createFromBuffer(rendered.buffer, {
    width: rendered.pixelWidth,
    height: rendered.pixelHeight,
    scaleFactor: rendered.scale,
  });
  image.setTemplateImage(true);
  return image;
}

function renderMenuLine(
  buffer: Buffer,
  strideWidth: number,
  lineTop: number,
  line: QuotaMenuLine,
  isFirstLine: boolean,
): void {
  if (line.error) {
    if (isFirstLine) drawString(buffer, strideWidth, PROVIDER_X, lineTop, line.provider, PROVIDER_MAX, PROVIDER_COLOR);
    drawString(buffer, strideWidth, QUOTA_MENU_CHILD_X, lineTop, line.error, ERROR_MAX, CHILD_COLOR);
    return;
  }
  if (line.amount) {
    if (isFirstLine) drawString(buffer, strideWidth, PROVIDER_X, lineTop, line.provider, PROVIDER_MAX, PROVIDER_COLOR);
    drawString(buffer, strideWidth, QUOTA_MENU_BALANCE_X, lineTop, 'bal', BALANCE_MAX, CHILD_COLOR);
    drawString(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, line.amount, AMOUNT_MAX, AMOUNT_COLOR);
    return;
  }
  if (isFirstLine) drawString(buffer, strideWidth, PROVIDER_X, lineTop, line.provider, PROVIDER_MAX, PROVIDER_COLOR);
  if (line.window) drawString(buffer, strideWidth, QUOTA_MENU_CHILD_X, lineTop, line.window, CHILD_MAX, CHILD_COLOR);

  if (line.remainingPct !== null) {
    fillRect(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, QUOTA_MENU_BAR_W, QUOTA_MENU_BAR_H, TRACK);
    const fillWidth = Math.max(0, Math.round((clamp(line.remainingPct) / 100) * QUOTA_MENU_BAR_W));
    if (fillWidth > 0) fillRect(buffer, strideWidth, QUOTA_MENU_BAR_X, lineTop, fillWidth, QUOTA_MENU_BAR_H, FILL);
    if (line.expectedRemainingPct !== null) {
      const markerX = QUOTA_MENU_BAR_X + Math.round((clamp(line.expectedRemainingPct) / 100) * QUOTA_MENU_BAR_W);
      const clampedMarkerX = Math.min(QUOTA_MENU_BAR_X + QUOTA_MENU_BAR_W - 1, Math.max(QUOTA_MENU_BAR_X, markerX));
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
    drawString(
      buffer,
      strideWidth,
      PCT_X,
      lineTop,
      formatQuotaMenuPercentageText(line.remainingPct),
      PCT_MAX,
      AMOUNT_COLOR,
    );
  }
}

function statusLabel(status: QuotaProviderSnapshot['status']): string {
  if (status === 'pending') return 'pending';
  if (status === 'error') return 'error';
  return 'unavailable';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function fillRect(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly number[],
): void {
  const x0 = Math.max(0, Math.floor(x * QUOTA_MENU_SCALE));
  const y0 = Math.max(0, Math.floor(y * QUOTA_MENU_SCALE));
  const x1 = Math.min(strideWidth, Math.ceil((x + width) * QUOTA_MENU_SCALE));
  const y1 = Math.min(buffer.length / (strideWidth * 4), Math.ceil((y + height) * QUOTA_MENU_SCALE));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const offset = (py * strideWidth + px) * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
}

function drawString(
  buffer: Buffer,
  strideWidth: number,
  x: number,
  y: number,
  value: string,
  maxWidth: number,
  color: readonly number[],
): void {
  let cursor = x;
  const maxX = x + maxWidth;
  for (const raw of value.toLowerCase()) {
    const character = raw === '—' || raw === '–' ? '-' : raw;
    if (cursor + 6 > maxX) break;
    drawGlyph(buffer, strideWidth, cursor, y, GLYPHS[character] ?? GLYPHS['-'], color);
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
  for (let row = 0; row < 7; row += 1) {
    const bits = glyph[row] ?? 0;
    for (let column = 0; column < 5; column += 1) {
      if (((bits >> (4 - column)) & 1) === 1) {
        fillRect(buffer, strideWidth, x + column, y + row, 1, 1, color);
      }
    }
  }
}
