import { useState, type RefObject } from 'react';
import { LegendRow } from '@/renderer/components/usage/UsageCard';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { formatCost, formatTokenCount } from '@/renderer/lib/format';
import type { DisplayCurrency } from '@/shell-contract';
import {
  type MetricCluster,
  type SessionCostEstimate,
  type TaskModelGroup,
} from '../../model/usage.js';

/** `2 个任务进行中 · 1 个任务缺数据`, or undefined when neither applies. */
export function taskNoteOf(runningTasks: number, missingTasks: number): string | undefined {
  const parts: string[] = [];
  if (runningTasks > 0) parts.push(`${runningTasks} 个任务进行中`);
  if (missingTasks > 0) parts.push(`${missingTasks} 个任务缺数据`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Colours of the three token kinds, shared by every bar and the legend. */
const TOKEN_COLORS = { cached: 'var(--chart-2)', fresh: 'var(--chart-1)', output: 'var(--chart-4)' } as const;

/** Cached input, fresh input and output as coloured bar segments. */
function tokenSegments(input: number, output: number, cached: number): TokenBarSegment[] {
  return [
    { id: 'cached', label: '缓存', tokens: cached, color: TOKEN_COLORS.cached },
    { id: 'fresh', label: '输入', tokens: Math.max(0, input - cached), color: TOKEN_COLORS.fresh },
    { id: 'output', label: '输出', tokens: output, color: TOKEN_COLORS.output },
  ];
}

interface SessionTotals {
  total: number;
  cached: number;
  fresh: number;
  output: number;
  cost: SessionCostEstimate;
}

/** Session totals as the sum of the clusters, so the panel's rows add up to them. */
function totalsOf(clusters: readonly MetricCluster[]): SessionTotals {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const cluster of clusters) {
    input += cluster.input;
    output += cluster.output;
    cached += cluster.cached;
  }
  const priced = clusters.filter((cluster) => cluster.cost.value !== undefined);
  return {
    total: input + output,
    cached,
    fresh: Math.max(0, input - cached),
    output,
    cost: {
      value: priced.length === 0 ? undefined : priced.reduce((sum, cluster) => sum + (cluster.cost.value ?? 0), 0),
      partial: clusters.some((cluster) => cluster.cost.partial || (cluster.cost.value === undefined && cluster.input + cluster.output > 0)),
    },
  };
}

/** `推理（7）`: the source with its number of requests, or of tasks for the task source. */
function sourceTitle(label: string, cluster: MetricCluster | undefined): string {
  return cluster === undefined || cluster.count === 0 ? label : `${label}（${cluster.count}）`;
}

/** `$0.0123`, prefixed with `≥` when part of the row has no known price; an em dash when nothing is priced. */
function costLabel(cost: SessionCostEstimate, currency: DisplayCurrency): string {
  if (cost.value === undefined) return '—';
  return `${cost.partial ? '≥' : ''}${formatCost(cost.value, currency)}`;
}

const NO_COST: SessionCostEstimate = { value: undefined, partial: false };

function sharePercent(value: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

interface SourceLegendRowProps {
  label: string;
  cluster: MetricCluster | undefined;
  groups: readonly TaskModelGroup[];
  currency: DisplayCurrency;
}

function SourceLegendRow({ label, cluster, groups, currency }: SourceLegendRowProps) {
  const [expanded, setExpanded] = useState(false);
  const input = cluster?.input ?? 0;
  const output = cluster?.output ?? 0;
  const title = sourceTitle(label, cluster);
  const expandable = groups.length > 0;

  return (
    <LegendRow
      label={title}
      value={formatTokenCount(input + output)}
      percent={costLabel(cluster?.cost ?? NO_COST, currency)}
      expandable={expandable}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {groups.map((group) => {
        const modelLabel = `${group.model === '' ? '未知模型' : group.model} ×${group.count}`;
        return (
          <LegendRow
            key={group.model}
            muted
            label={modelLabel}
            title={modelLabel}
            value={formatTokenCount(group.input + group.output)}
            percent={costLabel(group.cost, currency)}
          />
        );
      })}
    </LegendRow>
  );
}

export interface SessionUsagePanelProps {
  clusters: readonly MetricCluster[];
  /** Each source's requests grouped by model. */
  groups: { reason: readonly TaskModelGroup[]; aux: readonly TaskModelGroup[]; task: readonly TaskModelGroup[] };
  /** The panel root, focused when the popover opens so no toggle shows a focus ring. */
  rootRef: RefObject<HTMLDivElement | null>;
  currency: DisplayCurrency;
}

/**
 * Session metrics breakdown (context speed/cache/consumption details) for the
 * side-panel 用量 tab and other reuse sites.
 */
export function SessionUsagePanel({ clusters, groups, rootRef, currency }: SessionUsagePanelProps) {
  const totals = totalsOf(clusters);
  const find = (key: MetricCluster['key']): MetricCluster | undefined => clusters.find((cluster) => cluster.key === key);
  const segments = tokenSegments(totals.total - totals.output, totals.output, totals.cached);

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col gap-1.5 text-sm tabular-nums outline-none" data-slot="session-usage-panel">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">共 {formatTokenCount(totals.total)} tokens</span>
        <span className="flex-1" />
        <span className="font-medium">{costLabel(totals.cost, currency)}</span>
      </div>
      <TokenBar segments={segments} />
      {segments.map((segment) => (
        <LegendRow
          key={segment.id}
          label={segment.label}
          swatch={segment.color}
          value={formatTokenCount(segment.tokens)}
          percent={sharePercent(segment.tokens, totals.total)}
        />
      ))}
      <SourceLegendRow label="推理" cluster={find('reason')} groups={groups.reason} currency={currency} />
      <SourceLegendRow label="辅助" cluster={find('aux')} groups={groups.aux} currency={currency} />
      <SourceLegendRow label="任务" cluster={find('task')} groups={groups.task} currency={currency} />
    </div>
  );
}
