import { useState, type RefObject } from 'react';
import { ChevronRight } from 'lucide-react';
import { Separator } from '@/renderer/components/ui/separator';
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

interface SourceSectionProps {
  label: string;
  /** The featured section renders its title and bar larger. */
  featured?: boolean;
  cluster: MetricCluster | undefined;
  /** The source's requests grouped by model; a non-empty list makes the section expandable. */
  groups: readonly TaskModelGroup[];
  /** Always list the model rows, with no toggle. */
  alwaysExpanded?: boolean;
  currency: DisplayCurrency;
}

/**
 * One source of the usage panel: a title line with the source's request count,
 * tokens and estimated cost, and a bar splitting cached input, fresh input and
 * output. The title expands the section into one row per model, unless the
 * section always lists them.
 */
function SourceSection({ label, featured, cluster, groups, alwaysExpanded, currency }: SourceSectionProps) {
  const [toggled, setExpanded] = useState(false);
  const expanded = alwaysExpanded === true || toggled;
  const input = cluster?.input ?? 0;
  const output = cluster?.output ?? 0;
  const emphasis = featured === true ? 'text-sm font-medium' : 'font-medium';
  const title = sourceTitle(label, cluster);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        {groups.length === 0 || alwaysExpanded === true ? <span className={emphasis}>{title}</span> : (
          <button
            type="button"
            className={`inline-flex items-center gap-0.5 rounded-sm hover:text-muted-foreground ${emphasis}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {title}
            <ChevronRight className={`size-3 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        )}
        <span className="flex-1" />
        <span className={emphasis}>{formatTokenCount(input + output)}</span>
        <span className="w-16 text-right text-muted-foreground">{costLabel(cluster?.cost ?? NO_COST, currency)}</span>
      </div>
      <TokenBar segments={tokenSegments(input, output, cluster?.cached ?? 0)} className={featured === true ? 'h-2' : undefined} />
      {expanded ? groups.map((group) => (
        <div key={group.model} className="flex items-baseline gap-2">
          <span className="min-w-0 truncate">{group.model === '' ? '未知模型' : group.model}</span>
          <span className="shrink-0 text-muted-foreground">×{group.count}</span>
          <span className="flex-1" />
          <span className="shrink-0">{formatTokenCount(group.input + group.output)}</span>
          <span className="w-16 shrink-0 text-right text-muted-foreground">{costLabel(group.cost, currency)}</span>
        </div>
      )) : null}
    </div>
  );
}

export interface SessionUsagePanelProps {
  clusters: readonly MetricCluster[];
  /** Each source's requests grouped by model. */
  groups: { reason: readonly TaskModelGroup[]; aux: readonly TaskModelGroup[]; task: readonly TaskModelGroup[] };
  note: string | undefined;
  /** The panel root, focused when the popover opens so no toggle shows a focus ring. */
  rootRef: RefObject<HTMLDivElement | null>;
  currency: DisplayCurrency;
}

/**
 * Session metrics breakdown (context speed/cache/consumption details) for the
 * side-panel 用量 tab and other reuse sites.
 */
export function SessionUsagePanel({ clusters, groups, note, rootRef, currency }: SessionUsagePanelProps) {
  const totals = totalsOf(clusters);
  const find = (key: MetricCluster['key']): MetricCluster | undefined => clusters.find((cluster) => cluster.key === key);

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col gap-3 p-3 text-xs tabular-nums outline-none" data-slot="session-usage-panel">
      <SourceSection featured alwaysExpanded label="推理" cluster={find('reason')} groups={groups.reason} currency={currency} />
      <Separator />
      <SourceSection label="辅助" cluster={find('aux')} groups={groups.aux} currency={currency} />
      <SourceSection label="任务" cluster={find('task')} groups={groups.task} currency={currency} />
      <Separator />
      <div className="flex items-center gap-3 text-muted-foreground">
        {([['缓存', TOKEN_COLORS.cached, totals.cached], ['输入', TOKEN_COLORS.fresh, totals.fresh], ['输出', TOKEN_COLORS.output, totals.output]] as const).map(([label, color, value]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden="true" />
            {label}
            <span className="text-foreground">{formatTokenCount(value)}</span>
          </span>
        ))}
        <span className="flex-1" />
        <span className="text-foreground">{costLabel(totals.cost, currency)}</span>
      </div>
      {note === undefined ? null : <span className="text-muted-foreground">{note}</span>}
    </div>
  );
}
