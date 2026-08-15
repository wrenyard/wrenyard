import type {
  RenderContainer,
  RenderGraphics,
  RenderSurface,
  RenderText,
  RenderTextStyle,
  ShapeCommand,
} from '../../../render';
import type { WorkerView } from '../../../shared/snapshot';
import { pointInRect, type HouseRect, type PointerInput } from './hit-regions';

export const STATUS_PADDING_X = 4;
export const STATUS_PADDING_Y = 1;
export const STATUS_LINE_HEIGHT = 12;
export const STATUS_FONT_SIZE = 10;
export const STATUS_RADIUS = 3;
export const STATUS_MARGIN = 2;
export const STATUS_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';

export interface StatusLabelNode {
  container: RenderContainer;
  background: RenderGraphics;
  text: RenderText;
}

export interface StatusLabelLayout {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createStatusLabel(container: RenderContainer, surface: RenderSurface): StatusLabelNode {
  const background = surface.createGraphics();
  const text = surface.createText('', statusTextStyle());
  container.add(background);
  container.add(text);
  container.setVisible(false);
  return { container, background, text };
}

export function resolveStatusText(
  workers: readonly Pick<WorkerView, 'phase'>[],
  queuedCount: number,
  dailyStats?: { dispatchCount: number; totalTokens: number },
): string {
  const activeCount = workers.filter((worker) => worker.phase === 'working' || worker.phase === 'sleeping').length;
  const safeQueued = Math.max(0, Math.floor(Number.isFinite(queuedCount) ? queuedCount : 0));
  const lines: string[] = [];
  // First line: dispatch summary if dailyStats is available
  if (dailyStats) {
    lines.push(`${dailyStats.dispatchCount} dispatch · ${formatCount(dailyStats.totalTokens)} tok`);
  }
  if (activeCount > 0) lines.push(`${activeCount} activated`);
  if (safeQueued > 0) lines.push(`${safeQueued} queued`);
  return lines.join('\n');
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const safe = Math.max(0, Math.floor(value));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}m`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k`;
  return String(safe);
}

export function updateStatusLabel(
  node: StatusLabelNode,
  input: {
    workers: readonly Pick<WorkerView, 'phase'>[];
    queuedCount: number;
    dailyStats?: { dispatchCount: number; totalTokens: number };
    pointer: PointerInput;
    houseRect: HouseRect;
    viewportWidth: number;
    viewportHeight: number;
  },
): StatusLabelLayout | undefined {
  const text = '';
  node.container.setVisible(false);
  node.background.setCommands([]);
  node.text.setText('');
  return undefined;
}

export function statusTextStyle(): RenderTextStyle {
  return {
    fontFamily: STATUS_FONT_FAMILY,
    fontSize: STATUS_FONT_SIZE,
    fill: '#F7F1DE',
    align: 'center',
    lineHeight: STATUS_LINE_HEIGHT,
    fontWeight: 'normal',
  };
}

function statusBackgroundCommands(x: number, y: number, width: number, height: number): ShapeCommand[] {
  return [
    {
      kind: 'roundedRect',
      x,
      y,
      width,
      height,
      radius: STATUS_RADIUS,
      fill: '#0A0E14',
      alpha: 0.82,
    },
  ];
}
