import type {
  RenderContainer,
  RenderGraphics,
  RenderSurface,
  RenderText,
  RenderTextStyle,
  ShapeCommand,
} from '../../../render';
import type { BroadcastSnapshot } from '../../../shared/snapshot';
import { broadcastAlpha } from './broadcast-expiry';
import type { HouseRect } from './hit-regions';

export const BROADCAST_PREFIX = '» ';
export const BROADCAST_MAX_WIDTH = 320;
export const BROADCAST_MIN_WIDTH = 240;
export const BROADCAST_PADDING_X = 10;
export const BROADCAST_PADDING_Y = 7;
export const BROADCAST_CLOSE_SIZE = 24;
export const BROADCAST_CLOSE_GAP = 4;
export const BROADCAST_ROOF_GAP = 8;
export const BROADCAST_STACK_GAP = 8;
export const BROADCAST_RADIUS = 6;
export const BROADCAST_LINE_HEIGHT = 16;
export const BROADCAST_FONT_SIZE = 12;
export const BROADCAST_MAX_LINES = 4;
export const BROADCAST_MARGIN = 4;
export const BROADCAST_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

const MIN_WIDTH_FALLBACK = 20;
const ELLIPSIS = '\u2026';

export interface BroadcastCardNode {
  container: RenderContainer;
  background: RenderGraphics;
  text: RenderText;
  close: RenderGraphics;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BroadcastLayout {
  text: string;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  closeRect: Rect;
  alpha: number;
}

type MeasureText = (text: string) => number;

export function createBroadcastCard(container: RenderContainer, surface: RenderSurface): BroadcastCardNode {
  const background = surface.createGraphics();
  const text = surface.createText('', broadcastTextStyle());
  const close = surface.createGraphics();
  container.add(background);
  container.add(text);
  container.add(close);
  container.setVisible(false);
  return { container, background, text, close };
}

export function updateBroadcastCard(
  node: BroadcastCardNode,
  input: {
    broadcast?: BroadcastSnapshot;
    houseRect: HouseRect;
    viewportWidth: number;
    viewportHeight: number;
    nowMs: number;
    stackIndex?: number;
  },
): BroadcastLayout | undefined {
  const broadcast = input.broadcast;
  if (!broadcast?.text) {
    hideBroadcast(node);
    return undefined;
  }

  const alpha = broadcastAlpha(broadcast, input.nowMs);
  if (alpha <= 0) {
    hideBroadcast(node);
    return undefined;
  }

  node.text.setStyle(broadcastTextStyle());
  const measure = (text: string): number => {
    node.text.setText(text);
    return node.text.measure().width;
  };
  const anchorX = Math.round(input.houseRect.x + input.houseRect.width / 2);
  const anchorY = Math.round(input.houseRect.y);
  const layout = layoutBroadcastCard(broadcast.text, measure, anchorX, anchorY, {
    width: input.viewportWidth,
    height: input.viewportHeight,
    stackIndex: input.stackIndex ?? 0,
  });

  node.background.setCommands(backgroundCommands(layout));
  node.close.setCommands(closeIconCommands(layout.closeRect));
  node.text.setText(layout.lines.join('\n'));
  node.text.setPosition(Math.round(layout.x + BROADCAST_PADDING_X), Math.round(layout.y + BROADCAST_PADDING_Y));
  node.text.setAlpha(0.85);
  node.container.setAlpha(alpha);
  node.container.setVisible(true);

  return { ...layout, alpha };
}

export function layoutBroadcastCard(
  text: string,
  measure: MeasureText,
  anchorX: number,
  anchorY: number,
  viewport: { width: number; height: number; stackIndex?: number },
): Omit<BroadcastLayout, 'alpha'> {
  const metrics = measureBroadcastCard(text, measure, viewport.width);
  const x = clamp(
    anchorX - metrics.width / 2,
    BROADCAST_MARGIN,
    viewport.width - BROADCAST_MARGIN - metrics.width,
  );
  const stackIndex = Math.max(0, Math.floor(viewport.stackIndex ?? 0));
  const stackedOffset = stackIndex * (metrics.height + BROADCAST_STACK_GAP);
  const y = clamp(
    anchorY - metrics.height - BROADCAST_ROOF_GAP - stackedOffset,
    BROADCAST_MARGIN,
    viewport.height - BROADCAST_MARGIN - metrics.height,
  );
  const closeRect = {
    x: x + metrics.width - BROADCAST_PADDING_X - BROADCAST_CLOSE_SIZE,
    y: y + BROADCAST_PADDING_Y - 2,
    width: BROADCAST_CLOSE_SIZE,
    height: BROADCAST_CLOSE_SIZE,
  };

  return {
    text: `${BROADCAST_PREFIX}${text}`,
    lines: metrics.lines,
    x,
    y,
    width: metrics.width,
    height: metrics.height,
    closeRect,
  };
}

export function measureBroadcastCard(
  text: string,
  measure: MeasureText,
  viewportWidth: number,
): { width: number; height: number; lines: string[] } {
  const widthLimit = Math.max(
    MIN_WIDTH_FALLBACK,
    Math.min(BROADCAST_MAX_WIDTH, viewportWidth - BROADCAST_MARGIN * 2),
  );
  const closeReserve = BROADCAST_CLOSE_SIZE + BROADCAST_CLOSE_GAP;
  const maxTextWidth = Math.max(1, widthLimit - BROADCAST_PADDING_X * 2 - closeReserve);
  const lines = wrapTextToLines(`${BROADCAST_PREFIX}${text}`, measure, maxTextWidth, BROADCAST_MAX_LINES);

  let maxLineW = 0;
  for (const line of lines) {
    maxLineW = Math.max(maxLineW, measure(line));
  }

  const minWidth = Math.min(BROADCAST_MIN_WIDTH, widthLimit);
  const width = Math.min(
    widthLimit,
    Math.max(maxLineW + BROADCAST_PADDING_X * 2 + closeReserve, minWidth),
  );
  const height = BROADCAST_MAX_LINES * BROADCAST_LINE_HEIGHT + BROADCAST_PADDING_Y * 2;
  return { width, height, lines };
}

export function broadcastTextStyle(): RenderTextStyle {
  return {
    fontFamily: BROADCAST_FONT_FAMILY,
    fontSize: BROADCAST_FONT_SIZE,
    fill: '#2E2018',
    align: 'left',
    lineHeight: BROADCAST_LINE_HEIGHT,
    fontWeight: 'normal',
  };
}

function hideBroadcast(node: BroadcastCardNode): void {
  node.container.setVisible(false);
  node.background.setCommands([]);
  node.close.setCommands([]);
  node.text.setText('');
}

function wrapTextToLines(text: string, measure: MeasureText, maxTextWidth: number, maxLines: number): string[] {
  let lines = wrapText(text, measure, maxTextWidth);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    if (last) lines[maxLines - 1] = ellipsize(last, measure, maxTextWidth);
  }
  return lines;
}

function wrapText(text: string, measure: MeasureText, maxWidth: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (measure(test) <= maxWidth) {
      line = test;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (measure(word) <= maxWidth) {
      line = word;
      continue;
    }
    const chunks = splitByWidth(word, measure, maxWidth);
    lines.push(...chunks.slice(0, -1));
    line = chunks[chunks.length - 1] ?? '';
  }
  if (line) lines.push(line);
  return lines;
}

function splitByWidth(text: string, measure: MeasureText, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of [...text]) {
    const test = line + ch;
    if (measure(test) > maxWidth && line.length > 0) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function ellipsize(line: string, measure: MeasureText, maxWidth: number): string {
  if (measure(ELLIPSIS) > maxWidth) return '';
  let truncated = line;
  while (measure(`${truncated}${ELLIPSIS}`) > maxWidth && truncated.length > 0) {
    truncated = Array.from(truncated).slice(0, -1).join('');
  }
  return `${truncated}${ELLIPSIS}`;
}

function backgroundCommands(layout: Omit<BroadcastLayout, 'alpha'>): ShapeCommand[] {
  const x = Math.round(layout.x);
  const y = Math.round(layout.y);
  const width = Math.round(layout.width);
  const height = Math.round(layout.height);
  const leftAccentWidth = 3;
  return [
    {
      kind: 'roundedRect',
      x,
      y,
      width,
      height,
      radius: BROADCAST_RADIUS,
      fill: '#2E2018',
      alpha: 0.10,
    },
    {
      kind: 'roundedRect',
      x: x + 1,
      y: y + 1,
      width: Math.max(1, width - 2),
      height: Math.max(1, height - 2),
      radius: BROADCAST_RADIUS - 1,
      fill: '#F7EFD8',
      alpha: 0.95,
    },
    {
      kind: 'rect',
      x: x + 1,
      y: y + 1,
      width: leftAccentWidth,
      height: Math.max(1, height - 2),
      fill: '#E8A33D',
      alpha: 0.70,
    },
  ];
}

function closeIconCommands(rect: Rect): ShapeCommand[] {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const left = x + 6;
  const top = y + 6;
  const right = x + w - 6;
  const bottom = y + h - 6;
  return [
    { kind: 'rect', x: x + 3, y: y + 3, width: w - 6, height: h - 6, fill: '#F7EFD8', alpha: 0.85 },
    { kind: 'rect', x: x + 3, y: y + 3, width: w - 6, height: 1, fill: '#2E2018', alpha: 0.12 },
    { kind: 'rect', x: x + 3, y: y + h - 4, width: w - 6, height: 1, fill: '#2E2018', alpha: 0.12 },
    { kind: 'rect', x: x + 3, y: y + 3, width: 1, height: h - 6, fill: '#2E2018', alpha: 0.12 },
    { kind: 'rect', x: x + w - 4, y: y + 3, width: 1, height: h - 6, fill: '#2E2018', alpha: 0.12 },
    {
      kind: 'polygon',
      points: [
        { x: left, y: top + 1 },
        { x: left + 1, y: top },
        { x: right, y: bottom - 1 },
        { x: right - 1, y: bottom },
      ],
      fill: '#2E2018',
      alpha: 0.75,
    },
    {
      kind: 'polygon',
      points: [
        { x: right - 1, y: top },
        { x: right, y: top + 1 },
        { x: left + 1, y: bottom },
        { x: left, y: bottom - 1 },
      ],
      fill: '#2E2018',
      alpha: 0.75,
    },
  ];
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
