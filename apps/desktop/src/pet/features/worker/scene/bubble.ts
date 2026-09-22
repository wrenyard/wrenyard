/**
 * Worker speech-bubble rendering (PixiJS via src/render).
 *
 * Bubble layout is in CSS/DIP pixels; the worker sprite scale is NOT applied to
 * text bubbles. CJK-aware wrap: per-character for CJK-dominant text,
 * word-boundary otherwise. Fade out over the final 800ms before untilMs; reveal
 * at 40 cps with a toggling caret.
 *
 * FU-002 / IU-002
 */

import type {
  RenderContainer,
  RenderGraphics,
  RenderSurface,
  RenderText,
  ShapeCommand,
} from '../../../render';

export const MAX_BUBBLE_WIDTH = 280;
export const WORKER_MAX_LINES = 2;
export const BUBBLE_FONT =
  '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
export const LINE_HEIGHT = 16;
export const PADDING_X = 8;
export const PADDING_Y = 5;
export const RADIUS = 6;
export const TAIL_H = 6;
export const TAIL_W = 8;

const MIN_BUBBLE_WIDTH = 20;
const BUBBLE_FADE_MS = 800;
const REVEAL_CPS = 40;
const CARET_WIDTH = 2;
const CARET_HEIGHT = LINE_HEIGHT - 4;
const CARET_TOP_OFFSET = 2;

const BODY_FILL = '#F7EFD8';
const BODY_FILL_ALPHA = 242 / 255;
const BODY_STROKE = '#2E2018';
const BODY_STROKE_ALPHA = 30 / 255;
const TEXT_FILL = '#2E2018';
const TEXT_FILL_ALPHA = 217 / 255;
const ELLIPSIS = '\u2026';

export interface WorkerBubbleState {
  text: string;
  /** Timestamp (ms) at which the bubble should disappear. */
  untilMs: number;
  /** Timestamp (ms) the bubble text began revealing. */
  revealStartMs: number;
}

export interface WorkerBubbleNode {
  container: RenderContainer;
  graphics: RenderGraphics;
  text: RenderText;
}

function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

export type BubbleTextMeasure = (text: string) => number;

export interface BubbleMetrics {
  width: number;
  height: number;
  lines: string[];
}

export interface BubbleLayout extends BubbleMetrics {
  x: number;
  y: number;
  tailX: number;
  tailY: number;
}

export function isCJKDominantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const hasSpaces = /\s/.test(trimmed);
  const cjkCount = [...trimmed].filter(isCJK).length;
  const latinCount = [...trimmed].length - cjkCount;
  return cjkCount > latinCount && !hasSpaces;
}

function textWidth(measure: BubbleTextMeasure, text: string): number {
  return measure(text);
}

function splitByWidth(text: string, measure: BubbleTextMeasure, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const ch of [...text]) {
    const testLine = line + ch;
    if (textWidth(measure, testLine) > maxWidth && line.length > 0) {
      lines.push(line);
      line = ch;
    } else {
      line = testLine;
    }
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

export function wrapText(
  text: string,
  measure: BubbleTextMeasure,
  maxWidth: number,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (isCJKDominantText(trimmed)) {
    return splitByWidth(trimmed, measure, maxWidth);
  }

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (textWidth(measure, test) <= maxWidth) {
      line = test;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (textWidth(measure, word) <= maxWidth) {
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

function ellipsize(
  line: string,
  measure: BubbleTextMeasure,
  maxWidth: number,
): string {
  if (textWidth(measure, ELLIPSIS) > maxWidth) return '';
  let truncated = line;
  while (textWidth(measure, `${truncated}${ELLIPSIS}`) > maxWidth && truncated.length > 0) {
    truncated = Array.from(truncated).slice(0, -1).join('');
  }
  return `${truncated}${ELLIPSIS}`;
}

export function wrapTextToLines(
  text: string,
  measure: BubbleTextMeasure,
  maxTextWidth: number,
  maxLines: number,
): string[] {
  let lines = wrapText(text, measure, maxTextWidth);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const lastLine = lines[maxLines - 1];
    if (lastLine) {
      lines[maxLines - 1] = ellipsize(lastLine, measure, maxTextWidth);
    }
  }
  return lines;
}

function sliceCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, Math.max(0, count)).join('');
}

/**
 * Bubble alpha: 0 if the remaining lifetime is gone, 1 if >= 800ms remain,
 * otherwise linearly ramps over the final 800ms.
 */
export function bubbleAlpha(untilMs: number, nowMs: number): number {
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return 0;
  if (remaining >= BUBBLE_FADE_MS) return 1;
  return remaining / BUBBLE_FADE_MS;
}

export function revealCharCount(text: string, startMs: number, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - startMs);
  const revealed = Math.floor((elapsedMs / 1000) * REVEAL_CPS);
  return Math.min(Array.from(text).length, revealed);
}

export function measureWorkerBubble(
  text: string,
  measure: BubbleTextMeasure,
  maxBubbleWidth = MAX_BUBBLE_WIDTH,
): BubbleMetrics {
  const widthLimit = Math.max(MIN_BUBBLE_WIDTH, Math.min(maxBubbleWidth, MAX_BUBBLE_WIDTH));
  const maxTextWidth = Math.max(1, widthLimit - PADDING_X * 2);
  const lines = wrapTextToLines(text, measure, maxTextWidth, WORKER_MAX_LINES);

  let maxLineW = 0;
  for (const line of lines) {
    maxLineW = Math.max(maxLineW, textWidth(measure, line));
  }

  const width = Math.min(widthLimit, Math.max(maxLineW + PADDING_X * 2, MIN_BUBBLE_WIDTH));
  const height = lines.length * LINE_HEIGHT + PADDING_Y * 2;
  return { width, height, lines };
}

export function layoutWorkerBubble(
  text: string,
  measure: BubbleTextMeasure,
  anchorX: number,
  anchorY: number,
  maxBubbleWidth = MAX_BUBBLE_WIDTH,
): BubbleLayout {
  const metrics = measureWorkerBubble(text, measure, maxBubbleWidth);
  const x = Math.round(anchorX - metrics.width / 2);
  const y = Math.round(anchorY - metrics.height - TAIL_H);
  const tailX = clamp(anchorX, x + TAIL_W / 2, x + metrics.width - TAIL_W / 2);
  const tailY = y + metrics.height + TAIL_H;
  return { ...metrics, x, y, tailX, tailY };
}

export function wrapRevealed(
  text: string,
  revealed: number,
  measure: BubbleTextMeasure,
  stableBubbleWidth = MAX_BUBBLE_WIDTH,
): string[] {
  const visible = sliceCodePoints(text, revealed);
  if (!visible) return [''];
  const maxTextWidth = Math.max(1, stableBubbleWidth - PADDING_X * 2);
  const lines = wrapTextToLines(visible, measure, maxTextWidth, WORKER_MAX_LINES);
  return lines.length > 0 ? lines : [''];
}

/** Build the bubble node tree (graphics + text) inside a container. */
export function createWorkerBubble(
  container: RenderContainer,
  surface: RenderSurface,
): WorkerBubbleNode {
  const g = surface.createGraphics();
  const t = surface.createText('', {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 12,
    fill: '#000000',
    align: 'left',
    lineHeight: LINE_HEIGHT,
    fontWeight: 'normal',
  });
  container.add(g);
  container.add(t);
  return { container, graphics: g, text: t };
}

/**
 * Update the bubble node from state. `anchorX`/`anchorY` are the worker
 * anchor in CSS pixels (round((workerX+20)*scale), round(workerY*scale-2)).
 * When `state` is undefined, the bubble is hidden.
 */
export function updateWorkerBubble(
  node: WorkerBubbleNode,
  state: WorkerBubbleState | undefined,
  anchorX: number,
  anchorY: number,
  nowMs: number,
): void {
  if (!state || !state.text) {
    node.container.setVisible(false);
    return;
  }

  const alpha = bubbleAlpha(state.untilMs, nowMs);
  if (alpha <= 0) {
    node.container.setVisible(false);
    return;
  }

  node.text.setStyle({
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 12,
    fill: '#000000',
    align: 'left',
    lineHeight: LINE_HEIGHT,
    fontWeight: 'normal',
  });

  const measure = (text: string): number => {
    node.text.setText(text);
    return node.text.measure().width;
  };
  const layout = layoutWorkerBubble(state.text, measure, anchorX, anchorY);
  const revealed = revealCharCount(state.text, state.revealStartMs, nowMs);
  const stillRevealing = revealed < Array.from(state.text).length;
  const lines = wrapRevealed(state.text, revealed, measure, layout.width);

  const commands = bubbleCommands(layout.x, layout.y, layout.width, layout.height, layout.tailX, layout.tailY);
  let finalCommands = commands;

  // Text.
  const textContent = lines.join('\n');

  // Caret while revealing.
  if (stillRevealing && Math.floor(nowMs / 500) % 2 === 0) {
    const lastLineIndex = Math.max(0, lines.length - 1);
    const lastLine = lines[lastLineIndex] ?? '';
    const caretX = Math.min(
      layout.x + layout.width - PADDING_X,
      layout.x + PADDING_X + textWidth(measure, lastLine),
    );
    const caretY = layout.y + PADDING_Y + lastLineIndex * LINE_HEIGHT + CARET_TOP_OFFSET;
    finalCommands = [
      ...commands,
      {
        kind: 'rect',
        x: Math.round(caretX),
        y: Math.round(caretY),
        width: CARET_WIDTH,
        height: CARET_HEIGHT,
        fill: TEXT_FILL,
        alpha: TEXT_FILL_ALPHA,
      },
    ];
  }

  node.graphics.setCommands(finalCommands);
  node.text.setText(textContent);
  node.text.setPosition(Math.round(layout.x + PADDING_X), Math.round(layout.y + PADDING_Y));
  node.text.setAlpha(TEXT_FILL_ALPHA);
  node.container.setAlpha(alpha);
  node.container.setVisible(true);
}

function bubbleCommands(
  x: number,
  y: number,
  w: number,
  h: number,
  tailX: number,
  tailY: number,
): ShapeCommand[] {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rw = Math.round(w);
  const rh = Math.round(h);
  const innerW = Math.max(1, rw - 2);
  const innerH = Math.max(1, rh - 2);
  const baseY = ry + rh;
  return [
    {
      kind: 'roundedRect',
      x: rx,
      y: ry,
      width: rw,
      height: rh,
      radius: RADIUS,
      fill: BODY_STROKE,
      alpha: BODY_STROKE_ALPHA,
    },
    {
      kind: 'roundedRect',
      x: rx + 1,
      y: ry + 1,
      width: innerW,
      height: innerH,
      radius: Math.max(0, RADIUS - 1),
      fill: BODY_FILL,
      alpha: BODY_FILL_ALPHA,
    },
    {
      kind: 'polygon',
      points: [
        { x: Math.round(tailX - TAIL_W / 2), y: baseY - 1 },
        { x: Math.round(tailX), y: Math.round(tailY) },
        { x: Math.round(tailX + TAIL_W / 2), y: baseY - 1 },
      ],
      fill: BODY_STROKE,
      alpha: BODY_STROKE_ALPHA,
    },
    {
      kind: 'polygon',
      points: [
        { x: Math.round(tailX - TAIL_W / 2 + 1), y: baseY - 1 },
        { x: Math.round(tailX), y: Math.round(tailY - 1) },
        { x: Math.round(tailX + TAIL_W / 2 - 1), y: baseY - 1 },
      ],
      fill: BODY_FILL,
      alpha: BODY_FILL_ALPHA,
    },
  ];
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
