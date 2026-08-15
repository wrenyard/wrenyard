// ── Graph Slip icon & language helpers (pure, DOM-free) ──────────────
// Deterministic procedural glyphs (SVG path data in a 16x16 space) plus
// Chinese titles / aria labels / tooltip content. No DOM access, no
// emoji, no icon fonts, no gradients, no generated bitmap assets.

import type { GraphSlipNodeDto, TaskGraphNodeState, TaskRunStatus } from '../../shared/taskgraph';

export interface IconPart {
  d: string;
  fill?: boolean;
}

export interface TipRow {
  label: string;
  value: string;
}

export interface TipContent {
  firstLine?: string;
  rows: TipRow[];
  /** Done-only summary rendered as a separate full-width bordered region (no
   * 结果摘要 label), bounded to eight lines with ellipsis and no scrollbar by
   * the tip stylesheet. */
  summary?: string;
}

export const DEFAULT_TASK_TITLE = '任务';

// ── Compact paper-tag label geometry ──────────────────────────
// The renderer measures actual SVG glyph width so mixed CJK/Latin labels use
// the full region after the icon instead of a conservative character cap.
export const TAG_LABEL_START_X = 31;
export const TAG_LABEL_RIGHT_PADDING = 6;
export const TAG_LABEL_MAX_WIDTH = 148 - TAG_LABEL_START_X - TAG_LABEL_RIGHT_PADDING;

/** Fit a visible caption to measured pixel width. The caller owns the
 * measurement surface; binary search avoids splitting surrogate pairs. */
export function fitTagLabelToWidth(
  text: string,
  maxWidth: number,
  measure: (candidate: string) => number,
): string {
  if (measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = '…';
  if (measure(ellipsis) > maxWidth) return '';

  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, mid).join('') + ellipsis;
    if (measure(candidate) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('') + ellipsis;
}

const STATE_LABELS_ZH: Readonly<Record<TaskGraphNodeState, string>> = {
  planned: '计划',
  running: '运行中',
  waiting: '等待中',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
};

export function nodeStateLabelZh(state: TaskGraphNodeState): string {
  return STATE_LABELS_ZH[state] ?? '未知';
}

const TASK_STATUS_LABELS_ZH: Readonly<Record<TaskRunStatus, string>> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/**
 * User-visible task status label. The activity snapshot's task run status
 * takes display precedence over the graph node state: a node that already
 * entered 'running' while its task run is still 'queued' must render as
 * 排队中, never 运行中. Falls back to the node state label when the snapshot
 * carries no task run status for the node.
 */
export function taskStatusLabelZh(status: TaskRunStatus | undefined, fallbackState: TaskGraphNodeState): string {
  if (status === undefined) return nodeStateLabelZh(fallbackState);
  return TASK_STATUS_LABELS_ZH[status] ?? nodeStateLabelZh(fallbackState);
}

/**
 * Task heading for paper tag and tip: the Pet-only validated static
 * task_title (cached same-revision node.name) first, then the activity
 * display_label, and finally exactly Chinese '任务'. Never inferred from the
 * task id, node id, description, prompt, schema or raw output.
 */
export function nodeTitle(node: GraphSlipNodeDto): string {
  return node.task_title ?? node.display_label ?? DEFAULT_TASK_TITLE;
}

export function isTaskNode(node: GraphSlipNodeDto): boolean {
  return node.action_type === 'task';
}

/**
 * Unified procedural Agent glyph for every task node: a round head, an
 * antenna dot and a shoulder line. Drawn in a 16x16 space.
 */
export function taskIconPaths(): IconPart[] {
  return [
    { d: 'M5,5.2 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0', fill: true },
    { d: 'M8,2.2 V1' },
    { d: 'M7.1,0.9 a0.9,0.9 0 1,0 1.8,0 a0.9,0.9 0 1,0 -1.8,0', fill: true },
    { d: 'M5,11.5 H11' },
  ];
}

/**
 * Restrained procedural glyphs for the visible controls. No '?' text, no
 * English ids, no font icons. Unknown controls share one minimal glyph.
 */
export function controlIconPaths(actionType: string): IconPart[] {
  switch (actionType) {
    case 'start':
      // Filled play triangle.
      return [{ d: 'M5.5,3 L13,8 L5.5,13 Z', fill: true }];
    case 'end':
      // Filled square.
      return [{ d: 'M4.5,4.5 H11.5 V11.5 H4.5 Z', fill: true }];
    case 'condition':
      // Icon-only diamond without any '?' text.
      return [{ d: 'M8,2.5 L13.5,8 L8,13.5 L2.5,8 Z' }];
    case 'checkpoint':
      // Small flag on a pole.
      return [
        { d: 'M5,2.5 V13.5' },
        { d: 'M5,3 L12.5,5.5 L5,8 Z', fill: true },
      ];
    case 'convert':
      // Double horizontal arrow.
      return [
        { d: 'M3.5,6 H10.5 M3.5,6 L6,3.5 M3.5,6 L6,8.5' },
        { d: 'M12.5,10 H5.5 M12.5,10 L10,7.5 M12.5,10 L10,12.5' },
      ];
    default:
      // Other controls: a restrained port/chip glyph, never a '?'.
      return [
        { d: 'M5,8 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0' },
        { d: 'M7.4,8 a0.6,0.6 0 1,0 1.2,0 a0.6,0.6 0 1,0 -1.2,0', fill: true },
      ];
  }
}

export function controlAriaLabel(actionType: string): string {
  switch (actionType) {
    case 'start': return '开始';
    case 'end': return '结束';
    case 'condition': return '条件';
    case 'checkpoint': return '检查点';
    case 'convert': return '转换';
    default: return '控制节点';
  }
}

export function taskAriaLabel(node: GraphSlipNodeDto): string {
  return nodeTitle(node);
}

/** Chinese duration, minutes/seconds (hours when large). Null when invalid. */
export function formatDurationZh(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (seconds > 0) parts.push(`${seconds}秒`);
    return parts.join('');
  }
  if (minutes > 0) {
    parts.push(`${minutes}分`);
    if (seconds > 0) parts.push(`${seconds}秒`);
    return parts.join('');
  }
  return `${seconds}秒`;
}

function foldOneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Bounded paper-tip content. The task heading is exactly the structured
 * Chinese task_title (validated static node.name) with the display_label
 * then '任务' fallbacks — never the internal task description, node id,
 * task id, prompt, schema or raw output. Optional labeled rows appear only
 * when valid, in strict order: 状态, 任务 ID, 耗时, 运行配置, 工具调用, 输出速度
 * (exactly two decimals). A completed task reads its elapsed inline on the
 * status row (状态 已完成 · 5分12秒) and the separate 耗时 row is omitted then;
 * non-terminal task nodes and control nodes keep the separate elapsed row.
 * The 任务 ID row shows the Foreman task definition name (node.task_id) and
 * is omitted entirely when the activity snapshot carries no task_id — the
 * runtime instance id task_run_id is never exposed under that label. The
 * done-only summary is a separate summary region with no 结果摘要 label.
 * start/end have no tip at all; the remaining controls may show only real
 * valid state/runtime rows and never a duplicated English node name. Rows
 * are omitted (never placeholder) when absent or invalid.
 */
export function nodeTip(node: GraphSlipNodeDto, kind: 'task' | 'control'): TipContent | null {
  if (kind === 'control' && (node.action_type === 'start' || node.action_type === 'end')) {
    return null;
  }
  const statusLabel = taskStatusLabelZh(node.task_status, node.state);
  const duration = node.runtime_ms !== undefined ? formatDurationZh(node.runtime_ms) : null;
  // A completed task reads its elapsed inline on the same status row
  // (状态 已完成 · 5分12秒); the separate 耗时 row is then omitted so the
  // elapsed is never duplicated. Non-terminal task nodes and control nodes
  // keep the existing separate elapsed row.
  const inlineElapsed = kind === 'task' && statusLabel === '已完成' && duration !== null;
  const rows: TipRow[] = [];
  rows.push({
    label: '状态',
    value: inlineElapsed ? `已完成 · ${duration}` : statusLabel,
  });

  if (kind === 'task') {
    if (node.task_id !== undefined) rows.push({ label: '任务 ID', value: node.task_id });
    if (!inlineElapsed && duration !== null) rows.push({ label: '耗时', value: duration });
    if (node.profile !== undefined) rows.push({ label: '运行配置', value: node.profile });
    if (node.tool_call_count !== undefined) {
      rows.push({ label: '工具调用', value: String(node.tool_call_count) });
    }
    if (node.tps !== undefined) {
      // Effective output speed, rendered with exactly two decimals.
      rows.push({ label: '输出速度', value: node.tps.toFixed(2) });
    }
    const summary = node.state === 'done' && node.summary !== undefined ? foldOneLine(node.summary) : undefined;
    return {
      firstLine: nodeTitle(node),
      rows,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  if (duration !== null) rows.push({ label: '耗时', value: duration });
  return { rows };
}
