/**
 * Worker label layout/rendering (PixiJS via src/render).
 *
 * Age label ("Ns"/"Nm") sits to the right of the worker footline; task label is
 * centered. Both are clamped to window edges. Text is rendered with RenderText
 * primitives.
 *
 * FU-002 / IU-002
 */

import type { RenderContainer, RenderGraphics, RenderSurface, RenderText, RenderTextStyle, ShapeCommand } from '../../../render';

export const EDGE_MARGIN = 2;
export const VERTICAL_GAP = 2;
export const AGE_LABEL_GAP = 4;
export const AGE_LABEL_VISIBLE_RIGHT = 25;
export const LABEL_MAX_WIDTH = 88;
export const LABEL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';
export const LABEL_FONT_SIZE = 9;
export const LABEL_FONT_WEIGHT = 800;
export const AGE_LINE_HEIGHT = 12;
export const TASK_LINE_HEIGHT = 13;
export const TASK_PADDING_X = 4;
export const TASK_BORDER_PX = 1;
export const TASK_RADIUS = 2;

const AGE_FILL = '#1F2937';
const AGE_FILL_ALPHA = 0.62;
const AGE_SHADOW_FILL = '#FFFFFF';
const AGE_SHADOW_ALPHA = 0.55;
const TASK_FILL = '#F7F1DE';
const TASK_FILL_ALPHA = 0.82;
const TASK_BORDER_FILL = '#F7F1DE';
const TASK_BORDER_ALPHA = 0.25;
const TASK_BG_FILL = '#0A0E14';
const TASK_BG_ALPHA = 0.70;
const ELLIPSIS = '\u2026';

export type WorkerLabelKind = 'age' | 'task';

export interface WorkerLabelState {
  kind: WorkerLabelKind;
  /** Window width in CSS px. */
  windowWidth: number;
  /** Logical worker x (top-left). */
  workerX: number;
  /** Logical worker y (top-left). */
  workerY: number;
  /** Integer pixel scale. */
  scale: number;
  /** Rendered label width in CSS px. */
  labelWidth: number;
  /** Rendered label height in CSS px. */
  labelHeight: number;
  /** Label text content. */
  text: string;
}

export interface WorkerLabelNode {
  container: RenderContainer;
  background: RenderGraphics;
  shadowText: RenderText;
  text: RenderText;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute the CSS-pixel text position for the worker label.
 */
export function layoutWorkerLabel(state: WorkerLabelState): { left: number; top: number } {
  const labelWidth = Math.max(0, state.labelWidth);
  const labelHeight = Math.max(0, state.labelHeight);
  const footY = Math.round(state.workerY * state.scale + 32 * state.scale);
  const top = Math.max(0, footY - labelHeight - VERTICAL_GAP);

  if (state.kind === 'age') {
    const workerRight = Math.round(
      (state.workerX + Math.min(AGE_LABEL_VISIBLE_RIGHT, 40)) * state.scale,
    );
    return {
      left: clamp(
        workerRight + AGE_LABEL_GAP,
        EDGE_MARGIN,
        state.windowWidth - labelWidth - EDGE_MARGIN,
      ),
      top,
    };
  }

  return {
    left: clamp(
      Math.round(state.windowWidth / 2 - labelWidth / 2),
      EDGE_MARGIN,
      state.windowWidth - labelWidth - EDGE_MARGIN,
    ),
    top,
  };
}

export function formatWorkerAge(startedAt: number, nowMs: number): string {
  const ageSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  return `${Math.min(99, Math.floor(ageSec / 60))}m`;
}

export function resolveWorkerLabelText(input: {
  hovering: boolean;
  taskName?: string;
  taskLabel?: string;
  taskId?: string;
  startedAt: number;
  nowMs: number;
}): { kind: WorkerLabelKind; text: string } {
  const hoverLabel = input.taskName || input.taskLabel || input.taskId || '';
  if (input.hovering && hoverLabel.length > 0) {
    return { kind: 'task', text: hoverLabel };
  }
  return { kind: 'age', text: formatWorkerAge(input.startedAt, input.nowMs) };
}

export type TextWidthMeasure = (text: string) => number;

export function truncateTextToWidth(
  text: string,
  maxWidth: number,
  measure: TextWidthMeasure,
): string {
  if (measure(text) <= maxWidth) return text;
  if (maxWidth <= 0 || measure(ELLIPSIS) > maxWidth) return '';

  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${ELLIPSIS}`;
    if (measure(candidate) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${chars.slice(0, low).join('')}${ELLIPSIS}`;
}

export function labelTextStyle(): RenderTextStyle {
  return {
    fontFamily: LABEL_FONT_FAMILY,
    fontSize: LABEL_FONT_SIZE,
    fontWeight: LABEL_FONT_WEIGHT,
    fill: AGE_FILL,
    align: 'center',
    lineHeight: AGE_LINE_HEIGHT,
  };
}

/** Build the label node inside a container. */
export function createWorkerLabel(
  container: RenderContainer,
  surface: RenderSurface,
): WorkerLabelNode {
  const background = surface.createGraphics();
  const shadowText = surface.createText('', {
    ...labelTextStyle(),
    fill: AGE_SHADOW_FILL,
  });
  const text = surface.createText('', {
    ...labelTextStyle(),
    fill: AGE_FILL,
  });
  container.add(background);
  container.add(shadowText);
  container.add(text);
  background.setVisible(false);
  shadowText.setVisible(false);
  text.setVisible(false);
  return { container, background, shadowText, text };
}

/** Update the label node from state; hides it when the text is empty. */
export function updateWorkerLabel(node: WorkerLabelNode, state: WorkerLabelState): void {
  if (!state.text) {
    node.container.setVisible(false);
    node.background.setVisible(false);
    node.shadowText.setVisible(false);
    node.text.setVisible(false);
    return;
  }

  const lineHeight = state.kind === 'task' ? TASK_LINE_HEIGHT : AGE_LINE_HEIGHT;
  const style: RenderTextStyle = {
    ...labelTextStyle(),
    fill: state.kind === 'task' ? TASK_FILL : AGE_FILL,
    lineHeight,
  };

  node.text.setStyle(style);
  node.shadowText.setStyle({ ...style, fill: AGE_SHADOW_FILL });

  const contentMaxWidth = state.kind === 'task'
    ? LABEL_MAX_WIDTH - TASK_PADDING_X * 2 - TASK_BORDER_PX * 2
    : LABEL_MAX_WIDTH;
  const measure = (text: string): number => {
    node.text.setText(text);
    return node.text.measure().width;
  };
  const displayText = truncateTextToWidth(state.text, contentMaxWidth, measure);
  node.text.setText(displayText);
  node.shadowText.setText(displayText);

  const metrics = node.text.measure();
  const labelWidth = state.kind === 'task'
    ? Math.min(LABEL_MAX_WIDTH, Math.ceil(metrics.width) + TASK_PADDING_X * 2 + TASK_BORDER_PX * 2)
    : Math.min(LABEL_MAX_WIDTH, Math.ceil(metrics.width));
  const labelHeight = lineHeight;
  const layout = layoutWorkerLabel({ ...state, labelWidth, labelHeight });
  const left = Math.round(layout.left);
  const top = Math.round(layout.top);

  if (state.kind === 'task') {
    const commands: ShapeCommand[] = [
      {
        kind: 'roundedRect',
        x: left,
        y: top,
        width: labelWidth,
        height: TASK_LINE_HEIGHT,
        radius: TASK_RADIUS,
        fill: TASK_BORDER_FILL,
        alpha: TASK_BORDER_ALPHA,
      },
      {
        kind: 'roundedRect',
        x: left + TASK_BORDER_PX,
        y: top + TASK_BORDER_PX,
        width: Math.max(1, labelWidth - TASK_BORDER_PX * 2),
        height: TASK_LINE_HEIGHT - TASK_BORDER_PX * 2,
        radius: Math.max(0, TASK_RADIUS - TASK_BORDER_PX),
        fill: TASK_BG_FILL,
        alpha: TASK_BG_ALPHA,
      },
    ];
    node.background.setCommands(commands);
    node.background.setVisible(true);
    node.shadowText.setVisible(false);
    node.text.setPosition(left + TASK_PADDING_X + TASK_BORDER_PX, top);
    node.text.setAlpha(TASK_FILL_ALPHA);
  } else {
    node.background.setCommands([]);
    node.background.setVisible(false);
    node.shadowText.setPosition(left, top + 1);
    node.shadowText.setAlpha(AGE_SHADOW_ALPHA);
    node.shadowText.setVisible(true);
    node.text.setPosition(left, top);
    node.text.setAlpha(AGE_FILL_ALPHA);
  }

  node.text.setVisible(true);
  node.container.setVisible(true);
}
