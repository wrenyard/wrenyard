import { formatCount, formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { classifyFamily, familyBrand, providerBrand } from '@/renderer/lib/model-brand';
import type { StatsPeriod, StatsSnapshot, StatsWindowSnapshot, TaskRunSnapshot } from '@/shell-contract';
import { PERIOD_LABEL } from './describe.js';
import { taskDisplayLabel, taskInvestmentLabel, type TaskNameTables } from './task-names.js';

const MAX_PROFILE_ROWS = 12;
const MAX_TASK_ROWS = 12;
const MAX_TASK_RUN_ROWS = 50;

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export interface MetricCard {
  label: string;
  value: string;
  note: string;
}

export interface ProfileRow {
  key: string;
  displayName: string;
  brand: string;
  providers: string[];
  runCount: number;
  totalTokens: number;
  averageTps?: number;
}

export interface TaskRow {
  key: string;
  label: string;
  source: StatsWindowSnapshot['byTask'][number]['source'];
  runCount: number;
  averageDurationMs: number;
  shareLabel: string;
}

export interface TaskRunRow {
  taskRunId: string;
  status: TaskRunSnapshot['status'];
  label: string;
  providerName?: string;
  providerBrand?: string;
  modelName?: string;
  modelBrand?: string;
  inputTokens?: number;
  outputTokens?: number;
  tps?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/** The window matching the selected period, falling back to the first window. */
export function selectWindow(snapshot: StatsSnapshot, period: StatsPeriod): StatsWindowSnapshot | undefined {
  const windows = snapshot.windows ?? [];
  return windows.find((item) => item.period === period) ?? windows[0];
}

/** Four metric cards: label, formatted value and footnote. */
export function metricCards(
  snapshot: StatsSnapshot | undefined,
  window: StatsWindowSnapshot | undefined,
): MetricCard[] {
  const today = snapshot?.today ?? null;
  const periodName = window ? PERIOD_LABEL[window.period] : '';
  const dispatch = window?.dispatchCount ?? today?.dispatchCount;
  const tokens = window?.totalTokens ?? today?.totalTokens;
  const outcomes = today?.outcomes;
  const completed = outcomes ? outcomes.done + outcomes.failed : 0;
  const completionRate = outcomes && completed > 0
    ? `${Math.round((outcomes.done / completed) * 100)}%`
    : '—';
  return [
    {
      label: '调度次数',
      value: dispatch === undefined ? '—' : formatCount(dispatch),
      note: periodName || '—',
    },
    {
      label: 'Token 消耗',
      value: tokens === undefined ? '—' : formatTokenCount(tokens),
      note: periodName ? `${periodName}总量` : '—',
    },
    {
      label: '今日完成率',
      value: completionRate,
      note: outcomes
        ? `完成 ${formatCount(outcomes.done)} · 失败 ${formatCount(outcomes.failed)}`
        : '暂无结果数据',
    },
    {
      label: '任务总耗时',
      value: window ? formatElapsedMs(window.totalDurationMs) : '—',
      note: periodName || '—',
    },
  ];
}

/** Up to twelve model rows, newest authoritative display names only. */
export function profileRows(window: StatsWindowSnapshot | undefined): ProfileRow[] {
  if (!window) return [];
  return window.byProfile.slice(0, MAX_PROFILE_ROWS).map((row) => {
    const displayName = row.modelDisplayName && row.modelDisplayName.length > 0 ? row.modelDisplayName : '-';
    const providers = Array.isArray(row.providerDisplayNames)
      ? [...new Set(row.providerDisplayNames.filter((name): name is string => typeof name === 'string' && name.length > 0))]
      : [];
    const modelId = row.model ?? row.name;
    const result: ProfileRow = {
      key: modelId,
      displayName,
      brand: displayName === '-' ? '' : familyBrand(classifyFamily(modelId)),
      providers,
      runCount: row.runCount,
      totalTokens: row.totalTokens,
    };
    if (typeof row.averageTps === 'number') result.averageTps = row.averageTps;
    return result;
  });
}

/** Up to twelve task rows with their share of the window duration. */
export function taskRows(
  window: StatsWindowSnapshot | undefined,
  builtinOnly: boolean,
  names: TaskNameTables,
): TaskRow[] {
  if (!window) return [];
  const rows = builtinOnly ? window.byBuiltinTask : window.byTask;
  const denominator = builtinOnly ? window.builtinTotalDurationMs : window.totalDurationMs;
  return rows.slice(0, MAX_TASK_ROWS).map((row, index) => {
    const share = denominator > 0 ? (row.durationMs / denominator) * 100 : 0;
    return {
      key: `${row.source}:${row.name}:${index}`,
      label: taskInvestmentLabel(row.source, row.name, names),
      source: row.source,
      runCount: row.runCount,
      averageDurationMs: row.averageDurationMs,
      shareLabel: share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`,
    };
  });
}

/** Up to fifty recent runs with terminal-only numeric fields. */
export function taskRunRows(runs: TaskRunSnapshot[], names: TaskNameTables): TaskRunRow[] {
  return runs.slice(0, MAX_TASK_RUN_ROWS).map((run) => {
    const status = run.status;
    const active = status === 'queued' || status === 'running';
    const terminal = status !== undefined && TERMINAL_STATUSES.has(status);
    const providerName = nonEmpty(run.resolvedProviderDisplayName);
    const modelName = nonEmpty(run.resolvedModelDisplayName);
    const row: TaskRunRow = {
      taskRunId: run.taskRunId,
      status,
      label: taskDisplayLabel(run, names),
    };
    if (providerName !== undefined && modelName !== undefined) {
      row.providerName = providerName;
      row.modelName = modelName;
      row.providerBrand = providerBrand(run.resolvedProvider ?? providerName);
      row.modelBrand = familyBrand(classifyFamily(modelName));
    }
    if (!active && run.usage.inputTokens !== undefined) row.inputTokens = run.usage.inputTokens;
    if (!active && run.usage.outputTokens !== undefined) row.outputTokens = run.usage.outputTokens;
    if (!active && run.usage.outputTps !== undefined) row.tps = run.usage.outputTps;
    if (run.startedAt !== undefined) row.startedAt = run.startedAt;
    if (terminal && run.finishedAt !== undefined) row.finishedAt = run.finishedAt;
    if (terminal) {
      const started = parseTimestamp(run.startedAt);
      const finished = parseTimestamp(run.finishedAt);
      if (started !== null && finished !== null) {
        const duration = finished - started;
        if (Number.isFinite(duration) && duration >= 0) row.durationMs = duration;
      }
    }
    return row;
  });
}
