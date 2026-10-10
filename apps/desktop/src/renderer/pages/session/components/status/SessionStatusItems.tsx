import { Fragment, useCallback, useMemo, useState } from 'react';
import { Coins, DatabaseZap, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { StatusBarButton, levelTone } from '@/renderer/components/status-bar-button';
import { StatusBarGroup, type StatusBarSegment } from '@/renderer/components/status-bar-group';
import { UsageRing, usageRingLevel, type UsageRingStatus } from '@/renderer/components/usage/UsageRing';
import { useStatusBarItem } from '@/renderer/lib/statusbar';
import { formatRatio, formatTokenCount } from '@/renderer/lib/format';
import type { ContextInspection } from '@/shell-contract';
import {
  recentCacheRatio,
  recentTps,
  roleContexts,
  type ConsumptionRow,
  type ContextBudgetView,
  type RoleContextEntry,
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
  const cacheRatio = useMemo(() => recentCacheRatio(calls), [calls]);
  const tps = useMemo(() => recentTps(calls), [calls]);
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
      <MetricsStatusItem rows={consumption.rows} sum={consumption.sum} tps={tps} cacheRatio={cacheRatio} />
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
  rows: ConsumptionRow[];
  sum: ConsumptionRow;
  tps: number | undefined;
  cacheRatio: number | undefined;
}

/**
 * One connected status-bar item (window-chrome spec 4.5) with three segments:
 * generation speed, cache-hit ratio and the session's total tokens. Each segment
 * carries its own dark tooltip; the speed icon turns yellow above 100 t/s and
 * blue above 200 t/s while the label text stays muted.
 */
function MetricsStatusItem({ rows, sum, tps, cacheRatio }: MetricsStatusItemProps) {
  const speedLabel = tps === undefined ? '— t/s' : `${Math.round(tps)} t/s`;
  const speedIconClass = tps === undefined ? undefined : tps > 200 ? 'text-sky-500' : tps > 100 ? 'text-warning' : undefined;
  const cacheLabel = formatRatio(cacheRatio);

  const segments: StatusBarSegment[] = [
    {
      key: 'speed',
      icon: Zap,
      iconClassName: speedIconClass,
      label: speedLabel,
      ariaLabel: '生成速度',
      tooltip: `生成速度 ${speedLabel} · 最近一次主推理`,
    },
    {
      key: 'cache',
      icon: DatabaseZap,
      label: cacheLabel,
      ariaLabel: '缓存命中',
      tooltip: `缓存命中 ${cacheLabel} · 最近一次主推理`,
    },
    {
      key: 'stats',
      icon: Coins,
      label: formatTokenCount(sum.total),
      ariaLabel: '会话用量',
      tooltip: <ConsumptionTable rows={rows} sum={sum} />,
    },
  ];

  return <StatusBarGroup segments={segments} ariaLabel="会话指标" />;
}

/** `<percent> · <cached>` of a row, or `—` when the row reported no input. */
function cacheCell(row: ConsumptionRow): string {
  return row.cacheRatio === undefined
    ? '—'
    : `${formatRatio(row.cacheRatio)} · ${formatTokenCount(row.cached)}`;
}

/**
 * Dark tooltip copy for the metrics item: a compact per-conversation grid with
 * the aggregate `合计` row first, one row per conversation, and the `任务（N）`
 * row (marked when some dispatched task usage is missing) last. Every figure is
 * right-aligned and formatted with `formatTokenCount`.
 */
function ConsumptionTable({ rows, sum }: { rows: readonly ConsumptionRow[]; sum: ConsumptionRow }) {
  const partial = rows.some((row) => row.partial === true);
  return (
    <div className="flex max-w-none w-auto flex-col items-stretch gap-1 py-2">
      <div className="grid grid-cols-[auto_auto_auto_auto_auto] items-baseline gap-x-3 gap-y-1 text-xs tabular-nums">
        <span className="text-background/60">会话</span>
        <span className="text-right text-background/60">总</span>
        <span className="text-right text-background/60">输入</span>
        <span className="text-right text-background/60">输出</span>
        <span className="text-right text-background/60">缓存命中</span>

        <span className="font-medium">合计</span>
        <span className="text-right font-medium">{formatTokenCount(sum.total)}</span>
        <span className="text-right font-medium">{formatTokenCount(sum.input)}</span>
        <span className="text-right font-medium">{formatTokenCount(sum.output)}</span>
        <span className="text-right font-medium">{cacheCell(sum)}</span>

        {rows.map((row) => (
          <Fragment key={row.key}>
            <span>
              {row.key === 'task' ? `${row.label}（${row.calls}）` : row.label}
              {row.partial === true ? <span className="text-background/60"> *</span> : null}
            </span>
            <span className="text-right">{formatTokenCount(row.total)}</span>
            <span className="text-right">{formatTokenCount(row.input)}</span>
            <span className="text-right">{formatTokenCount(row.output)}</span>
            <span className="text-right">{cacheCell(row)}</span>
          </Fragment>
        ))}
      </div>
      {partial ? (
        <span className="text-xs text-background/60">* 部分任务用量不在最近运行记录中</span>
      ) : null}
    </div>
  );
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
