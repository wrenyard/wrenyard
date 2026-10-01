import type { StatusTone } from '@/renderer/components/status-badge';
import type { StatsDailySnapshot, StatsPeriod, TaskRunSnapshot } from '@/shell-contract';
import { formatCount, formatTokenCount } from '@/renderer/lib/format';

/* Central product copy and status mappings for the Workshop Ledger page. */

export const PAGE_TITLE = '工房台账';

export const STATS_UNAVAILABLE_TITLE = '台账暂不可用';
export const STATS_RETRY_LABEL = '重试';

/** Long period names used in card footnotes and summaries. */
export const PERIOD_LABEL: Record<StatsPeriod, string> = {
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '1mo': '最近 1 个月',
};

/** Short period labels for the header toggle. */
export const PERIOD_OPTIONS: ReadonlyArray<{ value: StatsPeriod; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '1mo', label: '1 个月' },
];

export const SOURCE_LABEL: Record<'builtin' | 'project' | 'unknown', string> = {
  builtin: '内置',
  project: '项目',
  unknown: '未知',
};

export const HEATMAP_TITLE = '近期火光';
export const HEATMAP_QUIET_LABEL = '安静';
export const HEATMAP_LOUD_LABEL = '400M+';
export const HEATMAP_EMPTY = '暂无每日活动记录';

export const PROFILE_TITLE = '模型统计';
export const PROFILE_PROVIDER_PREFIX = '提供方：';
export const PROFILE_EMPTY = '暂无模型统计';

export const TASK_INVESTMENT_TITLE = '任务投入';
export const TASK_INVESTMENT_TOGGLE_LABEL = '仅内置任务';
export const TASK_INVESTMENT_EMPTY = '暂无任务记录';
export const TASK_INVESTMENT_BUILTIN_EMPTY = '暂无内置任务记录';

export const TASK_RUNS_TITLE = '近期任务消耗';
export const TASK_RUNS_EMPTY = '暂无近期任务运行记录';

/** Tone and label a `StatusBadge` needs for one run status. */
const STATUS_VIEW: Record<string, { tone: StatusTone; label: string }> = {
  done: { tone: 'success', label: '已完成' },
  failed: { tone: 'danger', label: '失败' },
  cancelled: { tone: 'muted', label: '已取消' },
  interrupted: { tone: 'muted', label: '已中断' },
  running: { tone: 'running', label: '运行中' },
  queued: { tone: 'warning', label: '等待中' },
};

export function taskRunStatusView(status: TaskRunSnapshot['status']): { tone: StatusTone; label: string } {
  return (status ? STATUS_VIEW[status] : undefined) ?? { tone: 'muted', label: '任务' };
}

/** Multi-line heatmap tooltip copy: localized date, tokens, split and outcomes. */
export function heatmapTooltipLines(day: StatsDailySnapshot): string[] {
  const date = new Date(`${day.dayKey}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? day.dayKey
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      }).format(date);
  const lines = [
    dateLabel,
    `${formatTokenCount(day.totalTokens)} Token · ${formatCount(day.dispatchCount)} 次调度`,
    `输入 ${formatTokenCount(day.inputTokens)} · 输出 ${formatTokenCount(day.outputTokens)}`,
  ];
  if (day.outcomes) {
    lines.push(`完成 ${formatCount(day.outcomes.done)} · 失败 ${formatCount(day.outcomes.failed)} · 取消 ${formatCount(day.outcomes.cancelled)}`);
  }
  return lines;
}
