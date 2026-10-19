import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronRight, Coins, DatabaseZap, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { StatusBarButton, levelTone } from '@/renderer/components/status-bar-button';
import { StatusBarGroup, type StatusBarSegment } from '@/renderer/components/status-bar-group';
import { Separator } from '@/renderer/components/ui/separator';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { UsageRing, usageRingLevel } from '@/renderer/components/usage/UsageRing';
import { AnimatedNumber } from '@/renderer/components/AnimatedNumber';
import { useStatusBarItem } from '@/renderer/lib/statusbar';
import { formatCost, formatElapsedMs, formatRatio, formatTokenCount } from '@/renderer/lib/format';
import { useDisplayCurrency, useQuotaQuery } from '@/renderer/lib/queries';
import type { DisplayCurrency } from '@/shell-contract';
import {
  mainSpeed,
  callModelGroups,
  metricClusters,
  roleContexts,
  taskModelGroups,
  type MetricCluster,
  type SessionCostEstimate,
  type TaskModelGroup,
  type ContextBudgetView,
  type RoleContextEntry,
  type UsageGroupView,
} from '../../model/usage.js';
import { useSessionUsage } from '../../state/session-usage.js';
import { useContextBudget } from '../../state/use-context-budget.js';
import { useSessionConsumption } from '../../state/use-session-consumption.js';
import { ContextBreakdown } from '../usage/ContextBreakdown.js';
import type { ModelEntry } from '../../model/types.js';
import type { SessionUsage } from '../../state/session-usage.js';
import type { SessionConsumption } from '../../state/use-session-consumption.js';

/**
 * Session status-bar items (window-chrome spec 4.5). The component renders
 * nothing: it is mounted once inside the session page's usage provider and
 * registers two items on the status-bar `end` side, left of the global quota
 * item. Because `render` runs inside the AppShell status bar (outside the
 * session provider), every value is derived here through ordinary hooks and
 * passed to the item components as plain props. Items hide lowest-priority
 * first: ctx > metrics.
 */

/**
 * Everything the session usage surfaces share: the {@link ContextBreakdown}
 * props (`roles`, `budget`, `groups`, the selected model list) plus the
 * {@link SessionUsagePanel} inputs (`clusters`, model `groups`, task counts,
 * currency) and the speed figure. Extracted so the app-level 用量 panel renders
 * the same components without duplicating the derivation. `usage` may carry a
 * session-scoped usage slice (turns, models, consumption) so a scoped session
 * is preferred when the data path supports it; omitting it uses the active
 * session's provider.
 */
export interface SessionUsagePanelData {
  models: readonly ModelEntry[];
  modelId: string;
  roles: RoleContextEntry[];
  budget: ContextBudgetView | undefined;
  groups: UsageGroupView[];
  clusters: readonly MetricCluster[];
  taskGroups: readonly TaskModelGroup[];
  callGroups: { reason: readonly TaskModelGroup[]; aux: readonly TaskModelGroup[] };
  missingTasks: number;
  runningTasks: number;
  currency: DisplayCurrency;
  speed: number | undefined;
}

export function useSessionUsagePanelData(usage?: Pick<SessionUsage, 'turns'> & { consumption?: SessionConsumption }): SessionUsagePanelData {
  const { sessionKey, models, turns, modelId, inputTokens } = useSessionUsage();
  const { budget, groups, resolveModel, routesPreview } = useContextBudget(sessionKey, modelId, inputTokens);
  const providerConsumption = useSessionConsumption();
  const consumption = usage?.consumption ?? providerConsumption;
  const scopedTurns = usage?.turns ?? turns;

  const calls = useMemo(() => scopedTurns.flatMap((turn) => turn.calls), [scopedTurns]);
  const speed = useMemo(() => mainSpeed(calls), [calls]);
  const quota = useQuotaQuery();
  const currency = useDisplayCurrency();
  const dispatches = useMemo(
    () => scopedTurns.flatMap((turn) => turn.actions.filter((action) => action.kind === 'dispatch')),
    [scopedTurns],
  );
  const clusters = useMemo(
    () => metricClusters(calls, consumption.tasks, dispatches, quota.data),
    [calls, consumption.tasks, dispatches, quota.data],
  );
  const taskGroups = useMemo(
    () => taskModelGroups(consumption.tasks, dispatches),
    [consumption.tasks, dispatches],
  );
  // Calls priced per `provider/model` route, then grouped by model display name.
  const callGroups = useMemo(() => {
    const nameOf = (publicId: string): string => models.find((entry) => entry.publicId === publicId)?.displayName ?? shortModel(publicId);
    const grouped = (role: 'reason' | 'aux'): TaskModelGroup[] => callModelGroups(
      calls.filter((call) => (role === 'reason' ? call.role === 'reason' : call.role !== 'reason')),
      quota.data,
      nameOf,
    );
    return { reason: grouped('reason'), aux: grouped('aux') };
  }, [calls, quota.data, models]);
  // One entry per internal LLM conversation; each row is the latest reported
  // single-request actual occupancy, and the main selected model identifies the
  // reason row. Every auxiliary role the preview lists appears before its first
  // call, with no tokens.
  const roles = useMemo(
    () => roleContexts(calls, { reasonModel: modelId, resolve: resolveModel, preview: routesPreview?.roles }),
    [calls, modelId, resolveModel, routesPreview],
  );

  return {
    models,
    modelId,
    roles,
    budget,
    groups,
    clusters,
    taskGroups,
    callGroups,
    missingTasks: consumption.missingTasks,
    runningTasks: consumption.runningTasks,
    currency,
    speed,
  };
}

export function SessionStatusItems() {
  const { sessionKey, modelId, refreshContext } = useSessionUsage();
  const data = useSessionUsagePanelData();

  const selected = data.models.find((entry) => entry.publicId === modelId);

  useStatusBarItem({
    id: 'session.ctx',
    side: 'end',
    priority: 34,
    render: () => (
      <CtxStatusItem
        budget={data.budget}
        groups={data.groups}
        roles={data.roles}
        modelName={selected?.displayName}
        onRefresh={refreshContext}
      />
    ),
  });
  useStatusBarItem({
    id: 'session.metrics',
    side: 'end',
    priority: 33,
    render: () => (
      <MetricsStatusItem
        speed={data.speed}
        clusters={data.clusters}
        taskGroups={data.taskGroups}
        callGroups={data.callGroups}
        missingTasks={data.missingTasks}
        runningTasks={data.runningTasks}
        currency={data.currency}
      />
    ),
  });

  return null;
}

interface CtxStatusItemProps {
  budget: ContextBudgetView | undefined;
  groups: UsageGroupView[];
  roles: RoleContextEntry[];
  modelName: string | undefined;
  onRefresh: () => void;
}

function CtxStatusItem({ budget, groups, roles, modelName, onRefresh }: CtxStatusItemProps) {
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  // The ring and its percent report the main reason conversation's actual
  // occupancy against its model's full window; an unknown ratio shows a neutral
  // dash, never a fabricated 0%.
  const reason = roles.find((entry) => entry.role === 'reason');
  const reasonRatio = reason?.ratio !== undefined && Number.isFinite(reason.ratio) ? reason.ratio : undefined;
  const level = reasonRatio === undefined ? 'normal' : usageRingLevel(reasonRatio);
  const tone = levelTone(level);
  const pct = reasonRatio === undefined ? '—' : `${Math.round(Math.min(reasonRatio, 9.99) * 100)}%`;

  useEffect(() => {
    if (open && !wasOpen.current) onRefresh();
    wasOpen.current = open;
  }, [open, onRefresh]);

  const button = (
    <StatusBarButton ariaLabel="上下文占用" tone={tone} tooltip={ctxTooltip(reason, pct)}>
      <UsageRing ratio={reasonRatio} status={reasonRatio === undefined ? 'unknown' : 'ready'} className="size-3.5 [&_svg]:size-3.5" />
      <span className="min-w-[3ch] text-right tabular-nums">{pct}</span>
    </StatusBarButton>
  );

  const popover = (
    <div className="flex max-h-[560px] flex-col">
      <div className="min-h-0 overflow-y-auto">
        <ContextBreakdown
          roles={roles}
          budget={budget}
          groups={groups}
          modelName={modelName}
        />
      </div>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        {button}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[360px] p-0">
        {popover}
      </PopoverContent>
    </Popover>
  );
}

interface MetricsStatusItemProps {
  speed: number | undefined;
  clusters: readonly MetricCluster[];
  taskGroups: readonly TaskModelGroup[];
  callGroups: { reason: readonly TaskModelGroup[]; aux: readonly TaskModelGroup[] };
  missingTasks: number;
  runningTasks: number;
  currency: DisplayCurrency;
}

/**
 * One connected status-bar item (window-chrome spec 4.5) with three segments:
 * generation speed, main-reasoning cache-hit ratio and the session's total
 * tokens. Hovering a segment shows a two-line summary; clicking the usage
 * segment opens the session usage panel with the per-source breakdown. The speed icon turns
 * yellow above 100 t/s and blue above 200 t/s while the label text stays muted.
 * Only the segment values animate, through the shared {@link AnimatedNumber}.
 */
function MetricsStatusItem({ speed, clusters, taskGroups, callGroups, missingTasks, runningTasks, currency }: MetricsStatusItemProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const speedIconClass = speed === undefined ? undefined : speed > 200 ? 'text-sky-500' : speed > 100 ? 'text-warning' : undefined;
  const reason = clusters.find((cluster) => cluster.key === 'reason');
  const aux = clusters.find((cluster) => cluster.key === 'aux');
  const task = clusters.find((cluster) => cluster.key === 'task');
  // The cache segment tracks main reasoning only: it is the conversation whose
  // prefix the user's own turns keep extending.
  const reasonCacheRatio = reason?.cacheRatio;
  const totals = totalsOf(clusters);
  const finishedTasks = taskGroups.reduce((count, group) => count + group.count, 0);
  const average = (ms: number, count: number): string => elapsedText(count > 0 ? ms / count : 0);

  const segments: StatusBarSegment[] = [
    {
      key: 'speed',
      icon: Zap,
      iconClassName: speedIconClass,
      label: (
        <>
          <AnimatedNumber value={speed} format={formatSpeed} /> t/s
        </>
      ),
      ariaLabel: '生成速度',
      tooltip: (
        <BriefTip
          title={`推理 ${speedText(speed)} · 平均耗时 ${average(reason?.durationMs ?? 0, reason?.count ?? 0)}`}
          sub={finishedTasks === 0 ? undefined : `任务 ${speedText(task?.speed)} · 平均耗时 ${average(task?.durationMs ?? 0, finishedTasks)}`}
        />
      ),
    },
    {
      key: 'cache',
      icon: DatabaseZap,
      label: <AnimatedNumber value={reasonCacheRatio} format={formatPercent} />,
      ariaLabel: '推理缓存命中',
      tooltip: (
        <BriefTip
          title={`推理缓存命中 ${formatRatio(reasonCacheRatio)}`}
          sub={`辅助 ${formatRatio(aux?.cacheRatio)} · 任务 ${formatRatio(task?.cacheRatio)}`}
        />
      ),
    },
    {
      key: 'stats',
      icon: Coins,
      label: <AnimatedNumber value={totals.total} format={formatTokenCount} />,
      ariaLabel: '会话用量',
      onClick: () => setOpen((value) => !value),
      tooltip: (
        <BriefTip
          title={`用量 ${formatTokenCount(totals.total)}${approxCost(totals.cost, currency)}`}
          sub={`缓存 ${formatTokenCount(totals.cached)} · 输入 ${formatTokenCount(totals.fresh)} · 输出 ${formatTokenCount(totals.output)}`}
        />
      ),
    },
  ];

  return (
    // The group anchors the panel, but only the usage segment opens it: an open
    // request coming from the trigger itself is ignored, a close request is kept.
    <Popover open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarGroup segments={segments} ariaLabel="会话指标" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[360px] p-0" initialFocus={panelRef}>
        <SessionUsagePanel
          rootRef={panelRef}
          clusters={clusters}
          groups={{ ...callGroups, task: taskGroups }}
          note={taskNoteOf(runningTasks, missingTasks)}
          currency={currency}
        />
      </PopoverContent>
    </Popover>
  );
}

/** `2 个任务进行中 · 1 个任务缺数据`, or undefined when neither applies. */
function taskNoteOf(runningTasks: number, missingTasks: number): string | undefined {
  const parts: string[] = [];
  if (runningTasks > 0) parts.push(`${runningTasks} 个任务进行中`);
  if (missingTasks > 0) parts.push(`${missingTasks} 个任务缺数据`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** A two-line hover summary: the figure on top, a muted line of detail below. */
function BriefTip({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-0.5 text-xs tabular-nums" data-slot="session-metric-tip">
      <span>{title}</span>
      {sub === undefined ? null : <span className="text-background/60">{sub}</span>}
    </div>
  );
}

/** ` ≈ $0.0123` after a figure (`≥` when only partly priced); empty when nothing is priced. */
function approxCost(cost: SessionCostEstimate, currency: DisplayCurrency): string {
  if (cost.value === undefined) return '';
  return ` ${cost.partial ? '≥' : '≈'} ${formatCost(cost.value, currency)}`;
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

const speedText = (speed: number | undefined): string => (speed === undefined ? '—' : `${Math.round(speed)} t/s`);
const elapsedText = (ms: number): string => (ms > 0 ? formatElapsedMs(ms) : '—');

/** `$0.0123`, prefixed with `≥` when part of the row has no known price; an em dash when nothing is priced. */
function costLabel(cost: SessionCostEstimate, currency: DisplayCurrency): string {
  if (cost.value === undefined) return '—';
  return `${cost.partial ? '≥' : ''}${formatCost(cost.value, currency)}`;
}

/** `chatgpt/gpt-6-astra` → `gpt-6-astra`; other labels are shown as they are. */
function shortModel(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1 ? model.slice(separator + 1) : model;
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
 * The session usage panel opened from the status bar's usage segment. Main
 * reasoning leads, followed by auxiliary calls and dispatched tasks in the same
 * shape: request count, tokens, estimated cost and a token-mix bar, each
 * expandable into one row per model. A legend with the session's three token
 * totals closes the panel.
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

/** Segment speed text without the unit; the caller appends `t/s`. */
function formatSpeed(value: number): string {
  return String(Math.round(value));
}

/** A 0–1 ratio as a whole-number percentage. */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Single-line hover copy: `上下文 42% · 150.0k / 1M`. Both figures come from the
 * main reason conversation's latest reported single request and the full window
 * of the model that produced it; an unknown value shows a dash.
 */
function ctxTooltip(reason: RoleContextEntry | undefined, pct: string): string {
  if (reason === undefined || reason.tokens === undefined || reason.window === undefined) {
    return `上下文 ${pct} · 占用未知`;
  }
  return `上下文 ${pct} · ${formatTokenCount(reason.tokens)} / ${formatTokenCount(reason.window)}`;
}
