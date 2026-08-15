import type {
  RenderContainer,
  RenderGraphics,
  RenderSurface,
  RenderText,
  RenderTextStyle,
  ShapeCommand,
} from '../../../render';
import type { QuotaTipLine } from '../../../shared/entities';
import { pointInRect, type HouseRect, type PointerInput } from './hit-regions';

export const STATS_MAX_WIDTH = 240;
export const STATS_PADDING_X = 6;
export const STATS_PADDING_Y = 3;
export const STATS_LINE_HEIGHT = 12.5;
export const STATS_FONT_SIZE = 10;
export const STATS_RADIUS = 4;
export const STATS_MARGIN = 2;
export const STATS_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';
export const STATS_MAX_VISIBLE_ROWS = 6;

/** Bar graphical constants */
export const BAR_TRACK_HEIGHT = 6;
export const BAR_TRACK_RADIUS = 2;
export const BAR_MARKER_RADIUS = 2;
export const PROVIDER_LABEL_WIDTH = 78;
export const WINDOW_LABEL_WIDTH = 30;
export const BAR_PCT_WIDTH = 28;
/** Compact step for same-provider window rows */
export const SAME_PROVIDER_ROW_STEP = 12;
/** Extra gap before a different provider group */
export const INTER_PROVIDER_EXTRA_GAP = 5;

export interface StatsCardNode {
  container: RenderContainer;
  background: RenderGraphics;
  text: RenderText;
  /** Separate graphics node for quota bars (rendered above background) */
  barsGfx: RenderGraphics;
  surface: RenderSurface;
  /** Lazily-created per-row text nodes for bar card layout */
  providerNodes: RenderText[];
  windowNodes: RenderText[];
  pctNodes: RenderText[];
}

export interface StatsCardLayout {
  text: string;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createStatsCard(container: RenderContainer, surface: RenderSurface): StatsCardNode {
  const background = surface.createGraphics();
  const barsGfx = surface.createGraphics();
  const text = surface.createText('', statsTextStyle());
  container.add(background);
  container.add(barsGfx);
  container.add(text);
  container.setVisible(false);
  return { container, background, text, barsGfx, surface, providerNodes: [], windowNodes: [], pctNodes: [] };
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const safe = Math.max(0, Math.floor(value));
  if (safe >= 1_000_000) return `${Math.round(safe / 1_000_000)} mtok`;
  if (safe >= 1_000) return `${Math.round(safe / 1_000)} ktok`;
  if (safe > 0) return '<1 ktok';
  return '0 ktok';
}

/** Build two-line summary: Chinese activity line from the same snapshot plus
 *  the Lamplight token/state line. When activityStale the counts are kept and
 *  the second line is 信号暂失. Exported for focused tests. */
export function buildSummaryLines(input: {
  runningWorkerCount: number;
  queuedCount: number;
  taskgraphCount?: number;
  activityStale?: boolean;
  dailyStats?: { dispatchCount: number; totalTokens: number; inputTokens: number; outputTokens: number; source: string };
  dailyStatsUnavailable?: boolean;
}): string[] {
  const lines: string[] = [];
  // Line 1: Chinese activity from the one snapshot — running/queued/graphs,
  // direct + TaskGraph tasks share the same task list (no double counting).
  let line1 = `${input.runningWorkerCount} 个任务运行中`;
  if (input.queuedCount > 0) line1 += ` · ${input.queuedCount} 个排队`;
  if (input.taskgraphCount !== undefined && input.taskgraphCount > 0) line1 += ` · ${input.taskgraphCount} 张图纸`;
  lines.push(line1);
  // Line 2: stale keeps the counts and appends the signal-lost notice.
  if (input.activityStale) {
    lines.push('信号暂失');
  } else if (input.dailyStats?.source === 'sqlite') {
    const s = input.dailyStats;
    lines.push(`in ${formatCount(s.inputTokens)} · out ${formatCount(s.outputTokens)} · total ${formatCount(s.totalTokens)}`);
  } else if (input.dailyStatsUnavailable) {
    lines.push('stats unavailable');
  } else {
    lines.push(`total ${formatCount(input.dailyStats?.totalTokens ?? 0)}`);
  }
  return lines;
}

export function updateStatsCard(
  node: StatsCardNode,
  input: {
    dailyStats?: { dispatchCount: number; totalTokens: number; inputTokens: number; outputTokens: number; source: string };
    dailyStatsUnavailable?: boolean;
    runningWorkerCount?: number;
    queuedCount?: number;
    taskgraphCount?: number;
    activityStale?: boolean;
    quotaTips?: QuotaTipLine[];
    pointer: PointerInput;
    dragging: boolean;
    houseRect: HouseRect;
    viewportWidth: number;
    viewportHeight: number;
  },
): StatsCardLayout | undefined {
  const statsAvailable = input.dailyStats?.source === 'sqlite' && !input.quotaTips;
  const tipsAvailable = input.quotaTips && input.quotaTips.length > 0;
  const visible = !input.dragging &&
    input.pointer.inside &&
    pointInRect(input.pointer.x, input.pointer.y, input.houseRect) &&
    (statsAvailable || tipsAvailable);

  if (!visible) {
    node.container.setVisible(false);
    node.background.setCommands([]);
    node.barsGfx.setCommands([]);
    node.text.setText('');
    for (const tn of node.providerNodes) tn.setVisible(false);
    for (const tn of node.windowNodes) tn.setVisible(false);
    for (const tn of node.pctNodes) tn.setVisible(false);
    return undefined;
  }

  // Check if any tip has structured bar data
  const hasBarData = tipsAvailable && input.quotaTips!.some((tip) => (tip.bars && tip.bars.length > 0) || tip.errorRow);

  if (hasBarData) {
    return renderBarsCard(node, input);
  }

  // ── Plain text-only fallback (no structured bars) ──
  node.barsGfx.setCommands([]);
  for (const tn of node.providerNodes) tn.setVisible(false);
  for (const tn of node.windowNodes) tn.setVisible(false);
  for (const tn of node.pctNodes) tn.setVisible(false);

  // Build two-line Lamplight summary
  const summaryLineCount = 2;
  const summaryLines = buildSummaryLines({
    runningWorkerCount: input.runningWorkerCount ?? 0,
    queuedCount: input.queuedCount ?? 0,
    taskgraphCount: input.taskgraphCount,
    activityStale: input.activityStale,
    dailyStats: input.dailyStats,
    dailyStatsUnavailable: input.dailyStatsUnavailable,
  });

  const lines: string[] = [...summaryLines];

  if (tipsAvailable) {
    const tips = input.quotaTips!;
    let enabledCount = 0;
    for (const tip of tips) {
      if (enabledCount >= STATS_MAX_VISIBLE_ROWS) {
        lines[lines.length - 1] = lines[lines.length - 1] + '\u2026';
        break;
      }
      lines.push(tip.text);
      enabledCount++;
    }
  } else if (!(input.dailyStats?.source === 'sqlite')) {
    // Only summary lines, no quota tips and no daily stats — nothing more to render
  }

  if (lines.length === summaryLineCount && !(input.dailyStats?.source === 'sqlite') && !tipsAvailable) {
    node.container.setVisible(false);
    node.background.setCommands([]);
    node.text.setText('');
    return undefined;
  }

  return renderTextLines(node, lines, input);
}

const HARD_LINE_SEP = /[\t ]*[\r\n\u2028\u2029]+[\t ]*/g;

function fitLineToWidth(line: string, maxWidth: number, measureNode: RenderText): string {
  const normalized = line.replace(HARD_LINE_SEP, ' ');
  measureNode.setText(normalized);
  const { width: lineWidth } = measureNode.measure();
  if (lineWidth <= maxWidth) return normalized;
  let fitted = '';
  for (const ch of normalized) {
    const candidate = fitted + ch;
    measureNode.setText(candidate + '\u2026');
    const { width: candidateWidth } = measureNode.measure();
    if (candidateWidth <= maxWidth) {
      fitted += ch;
    } else {
      break;
    }
  }
  return fitted + '\u2026';
}

function renderTextLines(
  node: StatsCardNode,
  lines: string[],
  input: { houseRect: HouseRect; viewportWidth: number; viewportHeight: number },
): StatsCardLayout | undefined {
  node.text.setStyle(statsTextStyle());

  const contentMaxWidth = STATS_MAX_WIDTH - STATS_PADDING_X * 2;
  for (let i = 0; i < lines.length; i++) {
    lines[i] = fitLineToWidth(lines[i], contentMaxWidth, node.text);
  }

  const displayText = lines.join('\n');
  node.text.setText(displayText);
  const measured = node.text.measure();
  const lineCount = lines.length;
  const width = Math.min(STATS_MAX_WIDTH, Math.ceil(measured.width) + STATS_PADDING_X * 2);
  const height = Math.ceil(lineCount * STATS_LINE_HEIGHT + STATS_PADDING_Y * 2);
  const x = clamp(
    Math.round(input.houseRect.x + input.houseRect.width / 2 - width / 2),
    STATS_MARGIN,
    input.viewportWidth - width - STATS_MARGIN,
  );
  const y = resolveStatsCardY(input.houseRect, height, input.viewportHeight);

  node.background.setCommands(statsBackgroundCommands(x, y, width, height));
  node.text.setPosition(Math.round(x + (width - measured.width) / 2), y + STATS_PADDING_Y);
  node.text.setAlpha(0.90);
  node.container.setAlpha(1);
  node.container.setVisible(true);
  return { text: displayText, lines, x, y, width, height };
}

function renderBarsCard(
  node: StatsCardNode,
  input: {
    dailyStats?: { dispatchCount: number; totalTokens: number; inputTokens: number; outputTokens: number; source: string };
    dailyStatsUnavailable?: boolean;
    runningWorkerCount?: number;
    queuedCount?: number;
    taskgraphCount?: number;
    activityStale?: boolean;
    quotaTips?: QuotaTipLine[];
    houseRect: HouseRect;
    viewportWidth: number;
    viewportHeight: number;
  },
): StatsCardLayout | undefined {
  node.text.setStyle({ ...statsTextStyle(), align: 'left' });
  const tips = input.quotaTips!;
  const lines: string[] = [];

  // Two-line Lamplight summary instead of old one-line header
  const summaryLines = buildSummaryLines({
    runningWorkerCount: input.runningWorkerCount ?? 0,
    queuedCount: input.queuedCount ?? 0,
    taskgraphCount: input.taskgraphCount,
    activityStale: input.activityStale,
    dailyStats: input.dailyStats,
    dailyStatsUnavailable: input.dailyStatsUnavailable,
  });
  lines.push(...summaryLines);

  // Measure each summary line to determine natural card width
  const [summary0, summary1] = summaryLines;
  node.text.setText(summary0);
  const w0 = node.text.measure().width;
  node.text.setText(summary1);
  const w1 = node.text.measure().width;
  const naturalSummaryWidth = Math.max(w0, w1);
  const cardWidth = Math.min(
    Math.max(STATS_MAX_WIDTH, Math.ceil(naturalSummaryWidth) + STATS_PADDING_X * 2),
    input.viewportWidth - STATS_MARGIN * 2,
  );
  const contentMaxWidth = cardWidth - STATS_PADDING_X * 2;
  const trackWidth = Math.max(30, contentMaxWidth - PROVIDER_LABEL_WIDTH - WINDOW_LABEL_WIDTH - BAR_PCT_WIDTH);

  // Fit summary lines only when the card was genuinely narrowed by the viewport cap
  const fittedSummaryLines = summaryLines.map((line) => {
    node.text.setText(line);
    if (node.text.measure().width > contentMaxWidth) {
      return fitLineToWidth(line, contentMaxWidth, node.text);
    }
    return line;
  });
  // Update diagnostics lines to use fitted summaries
  lines.splice(0, 2, ...fittedSummaryLines);

  const barCommands: ShapeCommand[] = [];

  interface VisualRow {
    type: 'text' | 'bar-window' | 'error-row';
    providerLabel: string;
    windowName: string;
    groupStart: boolean;
    errorMessage?: string;
    barDef?: {
      remainingPct: number;
      expectedRemainingPct: number | null;
    };
  }

  const visualRows: VisualRow[] = [];
  let providerGroupCount = 0;

  for (const tip of tips) {
    if (providerGroupCount >= STATS_MAX_VISIBLE_ROWS) break;

    // Structured error row via errorRow on tip
    if (tip.errorRow) {
      providerGroupCount++;
      const fittedLabel = fitLineToWidth(tip.errorRow.label, PROVIDER_LABEL_WIDTH, node.text);
      const fittedMessage = fitLineToWidth(tip.errorRow.message, WINDOW_LABEL_WIDTH + trackWidth + BAR_PCT_WIDTH, node.text);
      visualRows.push({
        type: 'error-row',
        providerLabel: fittedLabel,
        windowName: '',
        errorMessage: fittedMessage,
        groupStart: true,
      });
      continue;
    }

    // Non-ok bars without errorRow: derive compatibility row from first non-ok bar
    const nonOkBars = tip.bars?.filter((b) => b.status !== 'ok') ?? [];
    if (nonOkBars.length > 0 && !tip.bars?.some((b) => b.status === 'ok')) {
      providerGroupCount++;
      const first = nonOkBars[0];
      const fittedLabel = fitLineToWidth(first.label, PROVIDER_LABEL_WIDTH, node.text);
      const compatMessage = first.status === 'error'
        ? (first.error ? `error — ${first.error}` : 'error')
        : 'unavailable';
      const fittedCompatMessage = fitLineToWidth(compatMessage, WINDOW_LABEL_WIDTH + trackWidth + BAR_PCT_WIDTH, node.text);
      visualRows.push({
        type: 'error-row',
        providerLabel: fittedLabel,
        windowName: '',
        errorMessage: fittedCompatMessage,
        groupStart: true,
      });
      continue;
    }

    // Has valid ok bars — count as a provider group
    const hasOkBar = tip.bars?.some((b) => b.status === 'ok');
    if (hasOkBar) {
      providerGroupCount++;

      const bars = tip.bars ?? [];
      let isGroupStart = true;
      for (const barEntry of bars) {
        if (barEntry.status !== 'ok') continue;
        const fittedLabel = fitLineToWidth(barEntry.label, PROVIDER_LABEL_WIDTH, node.text);
        for (const win of barEntry.provider.windows) {
          const fittedWindowName = fitLineToWidth(win.name, WINDOW_LABEL_WIDTH, node.text);
          visualRows.push({
            type: 'bar-window',
            providerLabel: fittedLabel,
            windowName: fittedWindowName,
            groupStart: isGroupStart,
            barDef: {
              remainingPct: win.remainingPct,
              expectedRemainingPct: win.expectedRemainingPct,
            },
          });
          isGroupStart = false;
        }
      }
      continue;
    }

    // Legacy text-only fallback (no bars at all)
    if (providerGroupCount < STATS_MAX_VISIBLE_ROWS) {
      visualRows.push({ type: 'text', providerLabel: tip.text, windowName: '', groupStart: true });
      providerGroupCount++;
    }
  }

  if (visualRows.length === 0) {
    if (lines.length === 0) {
      node.container.setVisible(false);
      node.background.setCommands([]);
      node.barsGfx.setCommands([]);
      node.text.setText('');
      for (const tn of node.providerNodes) tn.setVisible(false);
      for (const tn of node.windowNodes) tn.setVisible(false);
      for (const tn of node.pctNodes) tn.setVisible(false);
      return undefined;
    }
  }

  // Truncate text-only error rows to fit within card width
  for (const r of visualRows) {
    if (r.type === 'text') {
      r.providerLabel = fitLineToWidth(r.providerLabel, contentMaxWidth, node.text);
    }
  }

  // Build lines for diagnostics (provider label on every bar-window and error-row)
  for (const r of visualRows) {
    if (r.type === 'text') {
      lines.push(r.providerLabel);
    } else if (r.type === 'error-row') {
      lines.push(`${r.providerLabel} ${r.errorMessage}`);
    } else {
      lines.push(`${r.providerLabel} ${r.windowName}`);
    }
  }

  const displayText = lines.join('\n');

  // Lazy-create text nodes if needed
  while (node.providerNodes.length < visualRows.length) {
    const pn = node.surface.createText('', { ...statsTextStyle(), align: 'left' });
    const wn = node.surface.createText('', { ...statsTextStyle(), align: 'left' });
    node.providerNodes.push(pn);
    node.windowNodes.push(wn);
    node.container.add(pn);
    node.container.add(wn);
  }
  while (node.pctNodes.length < visualRows.length) {
    const pctn = node.surface.createText('', { ...statsTextStyle(), align: 'left' });
    node.pctNodes.push(pctn);
    node.container.add(pctn);
  }

  // Hide all row nodes first, then selectively show used ones
  for (let i = 0; i < node.providerNodes.length; i++) {
    node.providerNodes[i].setVisible(false);
    node.windowNodes[i].setVisible(false);
  }
  for (let i = 0; i < node.pctNodes.length; i++) {
    node.pctNodes[i].setVisible(false);
  }

  // Estimate height — 2 summary lines for Lamplight, then provider rows
  let estimatedHeight = STATS_LINE_HEIGHT * 2;
  let hasPlacedGroup = false;
  for (const r of visualRows) {
    if (r.groupStart) {
      if (hasPlacedGroup) {
        estimatedHeight += INTER_PROVIDER_EXTRA_GAP;
      }
      hasPlacedGroup = true;
    }
    if (r.type === 'text') {
      estimatedHeight += STATS_LINE_HEIGHT;
    } else {
      estimatedHeight += SAME_PROVIDER_ROW_STEP;
    }
  }

  const width = cardWidth;
  const height = Math.ceil(estimatedHeight + STATS_PADDING_Y * 2);
  const x = clamp(
    Math.round(input.houseRect.x + input.houseRect.width / 2 - width / 2),
    STATS_MARGIN,
    input.viewportWidth - width - STATS_MARGIN,
  );
  const y = resolveStatsCardY(input.houseRect, height, input.viewportHeight);

  // Layout columns
  const providerLabelX = x + STATS_PADDING_X;
  const windowLabelX = x + STATS_PADDING_X + PROVIDER_LABEL_WIDTH;
  const trackX = windowLabelX + WINDOW_LABEL_WIDTH;
  const pctAreaX = trackX + trackWidth;

  // Build bar commands and position row text nodes using identical row sequence
  let rowTop: number = y + STATS_PADDING_Y;

  // Skip 2 Lamplight summary lines
  rowTop += STATS_LINE_HEIGHT * 2;

  hasPlacedGroup = false;
  let rowIdx = 0;

  for (const r of visualRows) {
    // Inter-provider gap: every groupStart after the first
    if (r.groupStart) {
      if (hasPlacedGroup) {
        rowTop += INTER_PROVIDER_EXTRA_GAP;
      }
      hasPlacedGroup = true;
    }

    if (r.type === 'text') {
      // Legacy full-width error text — no bars, render full tip.text in provider column
      const pn = node.providerNodes[rowIdx];
      pn.setText(r.providerLabel);
      pn.setPosition(providerLabelX, rowTop);
      pn.setVisible(true);
      pn.setAlpha(0.90);
      rowTop += STATS_LINE_HEIGHT;
      rowIdx++;
      continue;
    }

    if (r.type === 'error-row') {
      // Provider label at providerLabelX, no colon
      const pn = node.providerNodes[rowIdx];
      pn.setText(r.providerLabel);
      pn.setPosition(providerLabelX, rowTop);
      pn.setVisible(true);
      pn.setAlpha(0.90);

      // Window column left empty — reused text node renders message at windowLabelX
      const wn = node.windowNodes[rowIdx];

      // Error message at windowLabelX using full window-plus-track-plus-percentage width — already fitted
      const fittedMessage = r.errorMessage ?? '';
      wn.setText(fittedMessage);
      wn.setPosition(windowLabelX, rowTop);
      wn.setVisible(true);
      wn.setAlpha(0.90);

      // No pct node for error rows
      const pctn = node.pctNodes[rowIdx];
      pctn.setVisible(false);

      // No bar commands (track, fill, marker)
      rowTop += STATS_LINE_HEIGHT;
      rowIdx++;
      continue;
    }

    // bar-window row
    // Provider label text node (visible only on groupStart)
    const pn = node.providerNodes[rowIdx];
    if (r.groupStart) {
      pn.setText(r.providerLabel);
      pn.setPosition(providerLabelX, rowTop);
      pn.setVisible(true);
      pn.setAlpha(0.90);
    }

    // Window name text node
    const wn = node.windowNodes[rowIdx];
    wn.setText(r.windowName);
    wn.setPosition(windowLabelX, rowTop);
    wn.setVisible(true);
    wn.setAlpha(0.90);

    // Track background
    const trackY = Math.round(rowTop + (SAME_PROVIDER_ROW_STEP - BAR_TRACK_HEIGHT) / 2);
    barCommands.push({
      kind: 'roundedRect',
      x: trackX,
      y: trackY,
      width: trackWidth,
      height: BAR_TRACK_HEIGHT,
      radius: BAR_TRACK_RADIUS,
      fill: '#2E2018',
      alpha: 0.12,
    });

    // Fill — remaining portion from left
    const fillWidth = Math.max(0, Math.round((r.barDef!.remainingPct / 100) * trackWidth));
    if (fillWidth > 0) {
      barCommands.push({
        kind: 'roundedRect',
        x: trackX,
        y: trackY,
        width: fillWidth,
        height: BAR_TRACK_HEIGHT,
        radius: BAR_TRACK_RADIUS,
        fill: '#7BA05B',
        alpha: 0.8,
      });
    }

    // Expected remaining marker (thin 1px ink tick)
    if (r.barDef!.expectedRemainingPct !== null && r.barDef!.expectedRemainingPct >= 0) {
      const markerCenterX = trackX + Math.round((r.barDef!.expectedRemainingPct / 100) * trackWidth);
      const markerX = Math.max(trackX, markerCenterX);
      barCommands.push({
        kind: 'rect',
        x: markerX,
        y: trackY,
        width: 1,
        height: BAR_TRACK_HEIGHT,
        fill: '#2E2018',
        alpha: 0.8,
      });
    }

    // Percentage text node — right-aligned within BAR_PCT_WIDTH
    const pctTxt = `${Math.round(r.barDef!.remainingPct)}%`;
    const pctn = node.pctNodes[rowIdx];
    pctn.setText(pctTxt);
    pctn.setVisible(true);
    pctn.setAlpha(0.90);
    const { width: pctMeas } = pctn.measure();
    pctn.setPosition(pctAreaX + (BAR_PCT_WIDTH - pctMeas), rowTop);

    rowTop += SAME_PROVIDER_ROW_STEP;
    rowIdx++;
  }

  // Show the two Lamplight summary lines in the single text node (fitted for narrow viewport)
  const summaryDisplay = fittedSummaryLines.join('\n');
  node.text.setText(summaryDisplay);
  node.barsGfx.setCommands(barCommands);
  node.background.setCommands(statsBackgroundCommands(x, y, width, height));
  node.text.setPosition(Math.round(x + STATS_PADDING_X), y + STATS_PADDING_Y);
  node.text.setAlpha(0.90);
  node.container.setAlpha(1);
  node.container.setVisible(true);

  return { text: displayText, lines, x, y, width, height };
}

export function statsTextStyle(): RenderTextStyle {
  return {
    fontFamily: STATS_FONT_FAMILY,
    fontSize: STATS_FONT_SIZE,
    fill: '#2E2018',
    align: 'center',
    lineHeight: STATS_LINE_HEIGHT,
    fontWeight: 'normal',
  };
}

function statsBackgroundCommands(x: number, y: number, width: number, height: number): ShapeCommand[] {
  return [
    {
      kind: 'roundedRect',
      x,
      y,
      width,
      height,
      radius: STATS_RADIUS,
      fill: '#F7EFD8',
      alpha: 0.95,
    },
    {
      kind: 'roundedRect',
      x,
      y,
      width,
      height,
      radius: STATS_RADIUS,
      fill: '#2E2018',
      alpha: 0.08,
    },
  ];
}

export function resolveStatsCardY(houseRect: HouseRect, height: number, viewportHeight: number): number {
  const maxY = viewportHeight - height - STATS_MARGIN;
  const aboveY = Math.round(houseRect.y - height - STATS_MARGIN);
  if (aboveY >= STATS_MARGIN) return Math.min(aboveY, maxY);

  const belowY = Math.round(houseRect.y + houseRect.height + STATS_MARGIN);
  if (belowY <= maxY) return Math.max(STATS_MARGIN, belowY);

  const spaceAbove = houseRect.y - STATS_MARGIN;
  const spaceBelow = viewportHeight - houseRect.y - houseRect.height - STATS_MARGIN;
  return spaceBelow > spaceAbove
    ? clamp(belowY, STATS_MARGIN, maxY)
    : clamp(aboveY, STATS_MARGIN, maxY);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
