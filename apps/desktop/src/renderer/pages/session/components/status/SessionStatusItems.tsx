import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Coins, DatabaseZap, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { StatusBarButton, levelTone } from '@/renderer/components/status-bar-button';
import { StatusBarGroup, type StatusBarSegment } from '@/renderer/components/status-bar-group';
import { UsageRing, usageRingLevel, type UsageRingStatus } from '@/renderer/components/usage/UsageRing';
import { AnimatedNumber } from '@/renderer/components/AnimatedNumber';
import { useStatusBarItem } from '@/renderer/lib/statusbar';
import { formatCount, formatRatio, formatTokenCount } from '@/renderer/lib/format';
import type { ContextInspection } from '@/shell-contract';
import {
  mainSpeed,
  mainSpeedSeries,
  roleContexts,
  type ConsumptionRow,
  type ContextBudgetView,
  type RoleContextEntry,
  type SessionTaskRow,
  type UsageGroupView,
} from '../../model/usage.js';
import { useSessionUsage } from '../../state/session-usage.js';
import { useContextBudget } from '../../state/use-context-budget.js';
import { useSessionConsumption } from '../../state/use-session-consumption.js';
import { ContextBreakdown } from '../usage/ContextBreakdown.js';

/**
 * Session status-bar items (window-chrome spec 4.5). The component renders
 * nothing: it is mounted once inside the session page's usage provider and
 * registers two items on the status-bar `end` side, left of the global quota
 * item. Because `render` runs inside the AppShell status bar (outside the
 * session provider), every value is derived here through ordinary hooks and
 * passed to the item components as plain props. Items hide lowest-priority
 * first: ctx > metrics.
 */

export function SessionStatusItems() {
  const { sessionKey, models, turns, modelId, requestInspection, inputTokens } = useSessionUsage();
  const { inspection, budget, groups, loading, resolveModel, routesPreview } = useContextBudget(sessionKey, modelId, inputTokens);
  const consumption = useSessionConsumption();

  const calls = useMemo(() => turns.flatMap((turn) => turn.calls), [turns]);
  const speed = useMemo(() => mainSpeed(calls), [calls]);
  const speedSeries = useMemo(() => mainSpeedSeries(calls), [calls]);
  // One entry per internal LLM conversation; the reason role carries the live
  // budget total (inspection total plus draft input) that blocks sending, and
  // every auxiliary role the preview lists appears even before its first call.
  const roles = useMemo(
    () => roleContexts(calls, { reasonTokens: budget?.total, resolve: resolveModel, preview: routesPreview?.roles }),
    [calls, budget?.total, resolveModel, routesPreview],
  );

  const selected = models.find((entry) => entry.publicId === modelId);
  const status: UsageRingStatus = modelId === ''
    ? 'unknown'
    : inspection === undefined
      ? (loading ? 'loading' : 'unknown')
      : (budget?.available === undefined ? 'unknown' : 'ready');

  const onAudit = useCallback((): void => requestInspection({ tab: 'context' }), [requestInspection]);

  useStatusBarItem({
    id: 'session.ctx',
    side: 'end',
    priority: 34,
    render: () => (
      <CtxStatusItem
        budget={budget}
        groups={groups}
        roles={roles}
        inspection={inspection}
        modelName={selected?.displayName}
        status={status}
        onAudit={onAudit}
      />
    ),
  });
  useStatusBarItem({
    id: 'session.metrics',
    side: 'end',
    priority: 33,
    render: () => (
      <MetricsStatusItem
        speed={speed}
        speedSeries={speedSeries}
        rows={consumption.rows}
        sum={consumption.sum}
        tasks={consumption.tasks}
        missingTasks={consumption.missingTasks}
        runningTasks={consumption.runningTasks}
      />
    ),
  });

  return null;
}

interface CtxStatusItemProps {
  budget: ContextBudgetView | undefined;
  groups: UsageGroupView[];
  roles: RoleContextEntry[];
  inspection: ContextInspection | undefined;
  modelName: string | undefined;
  status: UsageRingStatus;
  onAudit: () => void;
}

function CtxStatusItem({ budget, groups, roles, inspection, modelName, status, onAudit }: CtxStatusItemProps) {
  const [open, setOpen] = useState(false);
  const ratio = budget?.ratio;
  const level = ratio !== undefined && Number.isFinite(ratio) ? usageRingLevel(ratio) : 'normal';
  const tone = levelTone(level);
  const pct = ratio === undefined || !Number.isFinite(ratio) ? '—' : `${Math.round(Math.min(ratio, 9.99) * 100)}%`;

  const button = (
    <StatusBarButton ariaLabel="上下文占用" tone={tone} tooltip={ctxTooltip(budget, pct)} className="gap-1">
      <UsageRing ratio={ratio} status={status} className="size-3.5 [&_svg]:size-3.5" />
      <span className="tabular-nums">{pct}</span>
    </StatusBarButton>
  );

  const popover = (
    <div className="flex max-h-[560px] flex-col">
      {inspection !== undefined ? (
        <div className="min-h-0 overflow-y-auto">
          <ContextBreakdown
            roles={roles}
            budget={budget}
            groups={groups}
            modelName={modelName}
            onAudit={onAudit}
          />
        </div>
      ) : (
        <p className="p-4 text-xs text-muted-foreground">正在计算…</p>
      )}
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
  speedSeries: number[];
  rows: ConsumptionRow[];
  sum: ConsumptionRow;
  tasks: SessionTaskRow[];
  missingTasks: number;
  runningTasks: number;
}

/**
 * One connected status-bar item (window-chrome spec 4.5) with three segments:
 * generation speed, cache-hit ratio and the session's total tokens. Hovering any
 * segment opens the single read-only metrics panel; the speed icon turns yellow
 * above 100 t/s and blue above 200 t/s while the label text stays muted. Only
 * the values animate, through the shared {@link AnimatedNumber}.
 */
function MetricsStatusItem({ speed, speedSeries, rows, sum, tasks, missingTasks, runningTasks }: MetricsStatusItemProps) {
  const speedIconClass = speed === undefined ? undefined : speed > 200 ? 'text-sky-500' : speed > 100 ? 'text-warning' : undefined;

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
    },
    {
      key: 'cache',
      icon: DatabaseZap,
      label: <AnimatedNumber value={sum.cacheRatio} format={formatPercent} />,
      ariaLabel: '缓存命中',
    },
    {
      key: 'stats',
      icon: Coins,
      label: <AnimatedNumber value={sum.total} format={formatTokenCount} />,
      ariaLabel: '会话用量',
    },
  ];

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <StatusBarGroup segments={segments} ariaLabel="会话指标" />
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-none items-stretch px-3 py-2">
        <SessionMetricsPanel
          speed={speed}
          speedSeries={speedSeries}
          rows={rows}
          sum={sum}
          tasks={tasks}
          missingTasks={missingTasks}
          runningTasks={runningTasks}
        />
      </TooltipContent>
    </Tooltip>
  );
}

interface SessionMetricsPanelProps {
  speed: number | undefined;
  speedSeries: number[];
  rows: readonly ConsumptionRow[];
  sum: ConsumptionRow;
  tasks: readonly SessionTaskRow[];
  missingTasks: number;
  runningTasks: number;
}

/**
 * The combined metrics hover panel (session metrics spec), shared by all three
 * segments. It is read-only — no segment click action — and styled like the
 * inverse quota tips: dark surface, grouped sections and proportional bars.
 */
function SessionMetricsPanel({ speed, speedSeries, rows, sum, tasks, missingTasks, runningTasks }: SessionMetricsPanelProps) {
  return (
    <div className="flex w-[460px] flex-col gap-2.5 text-xs tabular-nums" data-slot="session-metrics-panel">
      <div className="grid grid-cols-3 gap-3">
        <OverviewValue
          label="速度"
          scope="主推理最近 5 次"
          value={
            <>
              <AnimatedNumber value={speed} format={formatSpeed} /> <span className="text-sm text-background/60">t/s</span>
            </>
          }
        >
          <Sparkline values={speedSeries} />
        </OverviewValue>
        <OverviewValue label="缓存命中" scope="整个会话" value={<AnimatedNumber value={sum.cacheRatio} format={formatPercent} />} />
        <OverviewValue label="用量" scope="整个会话" value={<AnimatedNumber value={sum.total} format={formatTokenCount} />} />
      </div>
      <MetricsTable rows={rows} sum={sum} />
      {tasks.length > 0 ? <TaskList tasks={tasks} /> : null}
      {missingTasks > 0 || runningTasks > 0 ? (
        <p className="text-background/60">
          {runningTasks > 0 ? `${runningTasks} 个任务进行中` : ''}
          {runningTasks > 0 && missingTasks > 0 ? ' · ' : ''}
          {missingTasks > 0 ? `${missingTasks} 个任务缺数据` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** One overview figure with its label, scope note and optional extra content. */
function OverviewValue({ label, scope, value, children }: { label: string; scope: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-background/60">{label}</span>
      <span className="text-base font-medium">{value}</span>
      <span className="text-background/60">{scope}</span>
      {children}
    </div>
  );
}

/** Mini main-reasoning speed trend; absent until two samples exist. */
function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const width = 128;
  const height = 20;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="mt-0.5 text-background/60" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** The per-source detail table: a `合计` row first, then one row per source. */
function MetricsTable({ rows, sum }: { rows: readonly ConsumptionRow[]; sum: ConsumptionRow }) {
  return (
    <div className="grid grid-cols-[auto_auto_auto_auto_auto_auto_auto] items-center gap-x-3 gap-y-1">
      <span className="text-background/60">来源</span>
      <span className="text-right text-background/60">次数</span>
      <span className="text-right text-background/60">速度</span>
      <span className="text-right text-background/60">输入</span>
      <span className="text-right text-background/60">输出</span>
      <span className="text-right text-background/60">缓存命中</span>
      <span className="text-right text-background/60">总量</span>

      <span className="font-medium">合计</span>
      <span className="text-right font-medium">{formatCount(sum.calls)}</span>
      <span className="text-right font-medium">{speedCell(sum.speed)}</span>
      <span className="text-right font-medium">{formatTokenCount(sum.input)}</span>
      <span className="text-right font-medium">{formatTokenCount(sum.output)}</span>
      <span className="flex items-center justify-end gap-1">
        <span>{formatRatio(sum.cacheRatio)}</span>
        <ShareBar ratio={sum.cacheRatio} />
      </span>
      <span className="flex items-center justify-end gap-1">
        <span>{formatTokenCount(sum.total)}</span>
        <ShareBar ratio={1} />
      </span>

      {rows.map((row) => (
        <Fragment key={row.key}>
          <span>
            {row.key === 'task' ? `${row.label}（${row.calls}）` : row.label}
            {row.partial === true ? <span className="text-background/60"> *</span> : null}
          </span>
          <span className="text-right">{formatCount(row.calls)}</span>
          <span className="text-right">{speedCell(row.speed)}</span>
          <span className="text-right">{formatTokenCount(row.input)}</span>
          <span className="text-right">{formatTokenCount(row.output)}</span>
          <span className="flex items-center justify-end gap-1">
            <span>{formatRatio(row.cacheRatio)}</span>
            <ShareBar ratio={row.cacheRatio} />
          </span>
          <span className="flex items-center justify-end gap-1">
            <span>{formatTokenCount(row.total)}</span>
            <ShareBar ratio={sum.total > 0 ? row.total / sum.total : undefined} />
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** The newest five dispatched tasks, each with a title, model, total and speed. */
function TaskList({ tasks }: { tasks: readonly SessionTaskRow[] }) {
  const visible = tasks.slice(0, 5);
  const rest = tasks.length - visible.length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1">
      <span className="text-background/60">任务</span>
      <span className="text-right text-background/60">模型</span>
      <span className="text-right text-background/60">总量</span>
      <span className="text-right text-background/60">速度</span>
      {visible.map((task) => (
        <Fragment key={task.taskRunId}>
          <span className="truncate">{task.title}</span>
          <span className="max-w-[120px] truncate text-background/60">{task.model ?? '—'}</span>
          <span className="text-right">{formatTokenCount(task.total)}</span>
          <span className="text-right">{speedCell(task.speed)}</span>
        </Fragment>
      ))}
      {rest > 0 ? <span className="col-span-4 text-background/60">其余 {rest} 个</span> : null}
    </div>
  );
}

/** Proportional bar for a cache ratio or a share of the session total. */
function ShareBar({ ratio }: { ratio: number | undefined }) {
  const pct = ratio === undefined || !Number.isFinite(ratio) ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <span className="relative inline-flex h-1 w-10 shrink-0 overflow-hidden rounded-full bg-background/20" aria-hidden="true">
      <span className="absolute inset-y-0 left-0 rounded-full bg-background/80" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** A speed column cell: whole tokens per second, or an em dash without samples. */
function speedCell(speed: number | undefined): string {
  return speed === undefined ? '—' : String(Math.round(speed));
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
 * Single-line hover copy: `上下文 42% · 约 84.2k / 200k`. The percent is the
 * reason conversation's send-blocking budget share and the figures are its
 * context over the available window. The window-unknown and no-budget variants
 * keep the `窗口未知` note.
 */
function ctxTooltip(budget: ContextBudgetView | undefined, pct: string): string {
  if (budget === undefined) return '上下文 · 窗口未知';
  const totalLabel = formatTokenCount(budget.total);
  if (budget.available === undefined) return `上下文 · 约 ${totalLabel} · 窗口未知`;
  return `上下文 ${pct} · 约 ${totalLabel} / ${formatTokenCount(budget.available)}`;
}
