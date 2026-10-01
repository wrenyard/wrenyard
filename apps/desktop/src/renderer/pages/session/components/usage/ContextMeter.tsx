import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { executeCommand } from '@/renderer/lib/commands';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Separator } from '@/renderer/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { QuotaProviderBlock } from '@/renderer/components/usage/QuotaProviderBlock';
import { paceView, quotaLevel } from '@/renderer/components/usage/QuotaBar';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { UsageRing, type UsageRingLevel, type UsageRingStatus } from '@/renderer/components/usage/UsageRing';
import { notify } from '@/renderer/lib/notify';
import { useQuotaQuery } from '@/renderer/lib/queries';
import type { ContextInspection, QuotaProviderSnapshot } from '@/shell-contract';
import {
  MAX_REASON_CALLS_PER_TURN,
  contextBudget,
  formatExactTokens,
  formatTokenCount,
  growthByTurn,
  recentCacheRatio,
  remainingTurns,
  usageGroups,
} from '../../model/usage.js';
import { contextQuery, useThrottledSeq } from '../../queries.js';
import { useSessionUsage } from '../../state/session-usage.js';
import { ContextBreakdown } from './ContextBreakdown.js';

/**
 * The composer context meter: the 16px ring plus the usage popover (usage spec
 * 4, 5). It reads the shared session usage store for the model list, turns and
 * ledger seq, queries `session.context.inspect` for the selected model, and
 * requests the inspector for audit and per-event jumps. The composer passes the
 * debounced input token count and receives whether sending is blocked.
 */

const QUOTA_PANEL_COMMAND = 'quota.showPanel';
const notifiedOverflowCalls = new Set<string>();

export interface ContextMeterProps {
  sessionKey: string;
  modelId: string;
  /** Debounced token count of the current input text; absent before the first count. */
  inputTokens?: number;
  /** Notifies the composer whether the known budget is exceeded (send blocked). */
  onBudgetChange?: (exceeded: boolean) => void;
}

export function ContextMeter({ sessionKey, modelId, inputTokens, onBudgetChange }: ContextMeterProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { sessionKey: contextKey, models, turns, seq, requestInspection } = useSessionUsage();
  const throttledSeq = useThrottledSeq(seq);
  const query = useQuery(contextQuery(sessionKey, modelId, throttledSeq));
  const inspection = query.data;

  const selected = models.find((entry) => entry.publicId === modelId);
  const input = inputTokens ?? 0;
  const budget = useMemo(
    () => {
      if (!inspection) return undefined;
      const model = selected
        ? { publicId: selected.publicId, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }
        : inspection.model.publicId === modelId ? inspection.model : { publicId: modelId };
      return contextBudget({ ...inspection, model }, input);
    },
    [inspection, input, selected, modelId],
  );
  const groups = useMemo(() => (inspection ? usageGroups(inspection, input) : []), [inspection, input]);
  const growth = useMemo(() => growthByTurn(inspection?.items ?? []), [inspection]);
  const calls = useMemo(() => turns.flatMap((turn) => turn.calls), [turns]);
  const cacheRatio = useMemo(() => recentCacheRatio(calls), [calls]);
  // Only turns observed running can surface a new failure; loaded history is silent.
  const tracked = useRef<{ key: string; turns: Set<number> }>({ key: sessionKey, turns: new Set() });
  useEffect(() => {
    if (contextKey !== sessionKey) return;
    if (tracked.current.key !== sessionKey) tracked.current = { key: sessionKey, turns: new Set() };
    for (const turn of turns) {
      if (turn.status === 'running') tracked.current.turns.add(turn.id);
      if (!tracked.current.turns.has(turn.id)) continue;
      for (const call of turn.calls) {
        if (!call.error?.startsWith('context_overflow:')) continue;
        const id = `context-overflow:${sessionKey}:${call.id}`;
        if (notifiedOverflowCalls.has(id)) continue;
        notifiedOverflowCalls.add(id);
        const metadata = models.find((entry) => entry.publicId === call.model);
        notify({
          id, level: 'error', source: 'session', title: '上下文已满，本轮已停止',
          description: `${metadata?.displayName ?? call.model} · 窗口 ${formatTokenCount(metadata?.contextWindow)}`,
          action: { label: '查看', command: { id: 'session.inspectContext', args: { sessionId: sessionKey } } },
        });
      }
    }
  }, [turns, models, sessionKey, contextKey]);
  const runningTurn = turns.find((turn) => turn.status === 'running');
  const remaining = budget?.available !== undefined && budget !== undefined
    ? remainingTurns(growth.filter((entry) => turns.some((turn) => turn.id === entry.turn && turn.status !== 'running')), budget.available - budget.total)
    : null;

  const exceeded = budget?.exceeded ?? false;
  useEffect(() => {
    onBudgetChange?.(exceeded);
  }, [exceeded, onBudgetChange]);

  const quota = useQuotaQuery();
  const providerQuota = useMemo(
    () => (selected ? quota.data?.catalog?.find((entry) => entry.id === selected.provider)?.quota : undefined),
    [quota.data, selected],
  );
  const quotaAlert = useMemo(() => quotaAlertLevel(providerQuota), [providerQuota]);

  const status: UsageRingStatus = modelId === ''
    ? 'unknown'
    : inspection === undefined
      ? (query.isPending ? 'loading' : 'unknown')
      : (budget?.available === undefined ? 'unknown' : 'ready');

  const tooltip = ringTooltip(budget);
  const calibration = calibrationTooltip(inspection, budget?.total ?? 0, modelId);

  const audit = (): void => {
    setOpen(false);
    requestInspection({ tab: 'context' });
  };
  const inspectSeq = (target: number): void => {
    setOpen(false);
    requestInspection({ tab: 'ledger', seq: target });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setExpanded(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <InputGroupButton type="button" variant="ghost" size="icon-sm" aria-label="上下文占用">
                  <UsageRing ratio={budget?.ratio} status={status} {...(quotaAlert ? { quotaAlert } : {})} />
                </InputGroupButton>
              }
            />
          }
        />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <PopoverContent side="top" align="end" sideOffset={8} className={expanded ? 'w-[440px] p-0' : 'w-[360px] p-0'}>
        <div className={expanded ? 'max-h-[560px] overflow-y-auto' : undefined}>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium">上下文</span>
              <span className="tabular-nums text-muted-foreground">{ratioLabel(budget?.ratio)}</span>
            </div>

            {exceeded && inspection && (
              <Alert variant="destructive">
                <AlertDescription>
                  {`上下文超出 ${selected?.displayName ?? inspection.model.publicId} 的可用窗口 ${formatTokenCount(budget?.available)}，无法发送`}
                </AlertDescription>
              </Alert>
            )}

            <TokenBar
              segments={summarize(groups)}
              window={inspection?.model.contextWindow}
              reserved={inspection?.model.maxOutputTokens}
            />

            {budget === undefined ? (
              <p className="text-xs text-muted-foreground">正在计算…</p>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={<p className="w-fit cursor-default text-xs text-muted-foreground">{budgetLine(budget)}</p>}
                  />
                  <TooltipContent>
                    <span className="flex flex-col gap-0.5">
                      <span>{exactBudgetLine(budget)}</span>
                      {calibration !== null && <span>{calibration}</span>}
                    </span>
                  </TooltipContent>
                </Tooltip>
                <p className="text-xs text-muted-foreground">
                  {`下一次推理 · ${selected?.displayName ?? (modelId || '未选择模型')} · ${windowLine(budget.window)}`}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  {cacheRatio !== undefined && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className={cacheRatio < 0.5 ? 'cursor-default text-warning' : 'cursor-default'}>
                            {`缓存命中 ${Math.round(cacheRatio * 100)}%`}
                          </span>
                        }
                      />
                      {cacheRatio < 0.5 && <TooltipContent>前缀未命中缓存，费用和延迟都会增加</TooltipContent>}
                    </Tooltip>
                  )}
                  {runningTurn && (
                    <span className={MAX_REASON_CALLS_PER_TURN - runningTurn.cycle <= 2 ? 'text-warning' : undefined}>
                      {`本轮推理 ${runningTurn.cycle} / ${MAX_REASON_CALLS_PER_TURN}`}
                    </span>
                  )}
                  {remaining && (
                    <span className={remaining.warn ? 'text-warning' : undefined}>
                      {`按近 ${Math.min(growth.length, 5)} 轮约还能 ${remaining.turns} 轮`}
                    </span>
                  )}
                </div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  不含准备阶段将要加载的资料
                </p>
              </>
            )}
          </div>

          <Separator />
          <div className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{`额度 · ${providerQuota?.label || selected?.provider || '供应商'}`}</span>
              <span className="text-muted-foreground">{updatedAgo(quota.data?.refreshedAt)}</span>
            </div>
            {providerQuota === undefined ? (
              selected === undefined ? (
                <p className="text-xs text-muted-foreground">未选择模型</p>
              ) : (
                <p className="text-xs text-muted-foreground">此供应商不提供额度信息</p>
              )
            ) : (
              <QuotaProviderBlock provider={providerQuota} />
            )}
          </div>

          {expanded && inspection && (
            <>
              <Separator />
              <div className="p-4">
                <ContextBreakdown
                  inspection={inspection}
                  groups={groups}
                  growth={growth}
                  total={budget?.total ?? inspection.totalTokens}
                  turns={turns}
                  onAudit={audit}
                  onInspect={inspectSeq}
                />
              </div>
            </>
          )}

          <Separator />
          <div className="flex items-center justify-between gap-2 p-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起明细' : '展开明细'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => executeCommand(QUOTA_PANEL_COMMAND)}
            >
              全部额度
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The summary bar reuses the full token bar, narrowed to the group segments. */
function summarize(groups: ReturnType<typeof usageGroups>): TokenBarSegment[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    tokens: group.tokens,
    color: group.color,
  }));
}

function ratioLabel(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(Math.min(ratio, 9.99) * 100)}%`;
}

function ringTooltip(budget: ReturnType<typeof contextBudget> | undefined): string {
  if (budget === undefined) return '上下文';
  if (budget.available === undefined) return `上下文 · 约 ${formatTokenCount(budget.total)} · 窗口未知`;
  return `上下文 ${ratioLabel(budget.ratio)} · 约 ${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)}`;
}

function budgetLine(budget: NonNullable<ReturnType<typeof contextBudget>>): string {
  if (budget.available === undefined) return `约 ${formatTokenCount(budget.total)} · 窗口未知`;
  const base = `约 ${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)} 可用`;
  return budget.reserved === undefined ? base : `${base} · 预留输出 ${formatTokenCount(budget.reserved)}`;
}

/** Exact token counts for the hover tooltip behind the abbreviated numbers. */
function exactBudgetLine(budget: NonNullable<ReturnType<typeof contextBudget>>): string {
  if (budget.available === undefined) return `约 ${formatExactTokens(budget.total)} · 窗口未知`;
  const base = `约 ${formatExactTokens(budget.total)} / ${formatExactTokens(budget.available)} 可用`;
  return budget.reserved === undefined ? base : `${base} · 预留输出 ${formatExactTokens(budget.reserved)}`;
}

function windowLine(window: number | undefined): string {
  return window === undefined ? '窗口未知' : `${formatTokenCount(window)} 窗口`;
}

/** Calibrated estimate copy; null when no calibration applies to this model. */
function calibrationTooltip(
  inspection: ContextInspection | undefined,
  total: number,
  modelId: string,
): string | null {
  const calibration = inspection?.calibration;
  if (!calibration || calibration.model !== modelId || calibration.estimated <= 0) return null;
  const factor = calibration.actual / calibration.estimated;
  const calibrated = Math.round(total * factor);
  return `按上次实际用量校准约 ${formatTokenCount(calibrated)}（×${factor.toFixed(2)}）`;
}

function quotaAlertLevel(
  provider: QuotaProviderSnapshot | undefined,
): Exclude<UsageRingLevel, 'normal'> | undefined {
  let level: Exclude<UsageRingLevel, 'normal'> | undefined;
  for (const window of provider?.windows ?? []) {
    const severity = quotaLevel(window.remainingPct);
    if (severity === 'destructive') return 'destructive';
    if (severity === 'warning') level = 'warning';
    if (paceView(window.remainingPct, window.expectedRemainingPct)?.warn) level ??= 'warning';
  }
  return level;
}

function updatedAgo(refreshedAt: number | undefined): string {
  if (refreshedAt === undefined) return '';
  const minutes = Math.max(0, Math.round((Date.now() - refreshedAt) / 60_000));
  if (minutes <= 0) return '刚刚更新';
  if (minutes < 60) return `更新于 ${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return `更新于 ${hours} 小时前`;
}
