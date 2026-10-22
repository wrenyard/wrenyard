import { useState } from 'react';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { LegendGap, LegendList, LegendRow } from '@/renderer/components/usage/UsageCard';
import { formatTokenCount, formatRatio } from '@/renderer/lib/format';
import type { ContextBudgetView, RoleContextEntry, UsageGroupView } from '../../model/usage.js';
import { cn } from 'cn';

/**
 * Expanded detail of the ctx popover (usage spec 5.2). A Wrenyard session is
 * several separate stateless LLM conversations — reason plus auxiliary roles.
 * The forward-looking send-block estimate is shown first with its composition
 * bar and legend rows; auxiliary sessions follow as compact token-only rows.
 * Chinese product copy.
 */

/** Swatch colours matching the TokenBar reserve hatch and free-space track. */
const RESERVE_SWATCH = 'color-mix(in oklab, var(--muted-foreground) 25%, transparent)';
const FREE_SWATCH = 'var(--muted)';

export interface ContextBreakdownProps {
  /** Per-role context entries: the reason row first, then auxiliary roles. */
  roles: RoleContextEntry[];
  /** Forward-looking send-block budget (inspection total plus draft input). */
  budget: ContextBudgetView | undefined;
  /** Layer composition groups of the estimated next request. */
  groups: UsageGroupView[];
  /** Display name of the reason model, for the overflow alert. */
  modelName?: string;
}

export function ContextBreakdown({ roles, budget, groups, modelName }: ContextBreakdownProps) {
  const [auxiliaryExpanded, setAuxiliaryExpanded] = useState(false);
  const segments: TokenBarSegment[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    tokens: group.tokens,
    color: group.color,
  }));
  const compositionTotal = groups.reduce((sum, group) => sum + group.tokens, 0);
  const reason = roles.find((entry) => entry.role === 'reason');
  const auxiliary = roles.filter((entry) => entry.role !== 'reason');
  const estimateFigure = budget === undefined
    ? undefined
    : budget.available === undefined
      ? `约 ${formatTokenCount(budget.total)}`
      : `${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)}`;

  const estimateDetail = budget === undefined ? null : (
    <div className="flex flex-col gap-2" data-slot="context-estimate">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm font-medium">
          预计发送
          {budget.ratio !== undefined && (
            <span
              className={cn(
                budget.exceeded && 'text-destructive',
                !budget.exceeded && budget.ratio >= 0.7 && 'text-warning',
              )}
            >
              {' '}
              {formatRatio(budget.ratio)}
            </span>
          )}
        </span>
        {estimateFigure !== undefined && (
          <span className="ml-auto text-sm tabular-nums text-muted-foreground">{estimateFigure}</span>
        )}
      </div>
      {budget.exceeded === true && (
        <Alert variant="destructive">
          <AlertDescription>
            {`${modelName ?? reason?.model ?? '主推理'} 的上下文较大（可用窗口 ${formatTokenCount(budget.available)}），发送时将先压缩`}
          </AlertDescription>
        </Alert>
      )}
      <TokenBar segments={segments} window={budget.window} reserved={budget.reserved} />
    </div>
  );

  const window = budget !== undefined && budget.window !== undefined && budget.window > 0
    ? budget.window
    : undefined;
  const percentDenominator = window ?? compositionTotal;
  const reserved = budget !== undefined && window !== undefined && budget.reserved !== undefined
    ? Math.max(0, budget.reserved)
    : undefined;
  const freeTokens = window !== undefined && reserved !== undefined
    ? Math.max(0, window - compositionTotal - reserved)
    : undefined;
  const windowPercent = (tokens: number) =>
    `${(percentDenominator > 0 ? (tokens / percentDenominator) * 100 : 0).toFixed(1)}%`;

  return (
    <div className="flex flex-col gap-1.5" data-slot="context-breakdown">
      {estimateDetail}
      <LegendList>
        {budget !== undefined && groups.map((group) => (
          <LegendRow
            key={group.id}
            label={group.label}
            swatch={group.color}
            value={formatTokenCount(group.tokens)}
            percent={windowPercent(group.tokens)}
          />
        ))}
        {window !== undefined && reserved !== undefined && freeTokens !== undefined && (
          <>
            <LegendRow
              muted
              label="输出预留"
              swatch={RESERVE_SWATCH}
              value={formatTokenCount(reserved)}
              percent={windowPercent(reserved)}
            />
            <LegendRow
              muted
              label="空闲"
              swatch={FREE_SWATCH}
              value={formatTokenCount(freeTokens)}
              percent={windowPercent(freeTokens)}
            />
          </>
        )}
        <LegendGap />
        {auxiliary.length > 0 && (
          <LegendRow
            expandable
            expanded={auxiliaryExpanded}
            onToggle={() => setAuxiliaryExpanded((open) => !open)}
            label="辅助会话"
            percent={auxiliary.length}
          >
            {auxiliary.map((entry) => <AuxiliaryRow key={entry.role} entry={entry} />)}
          </LegendRow>
        )}
      </LegendList>
    </div>
  );
}

interface AuxiliaryRowProps {
  entry: RoleContextEntry;
}

function AuxiliaryRow({ entry }: AuxiliaryRowProps) {
  if (entry.error !== undefined) {
    return (
      <LegendRow
        muted
        label={entry.label}
        value="无可用线路"
      />
    );
  }

  const tokens = entry.tokens === undefined ? '—' : formatTokenCount(entry.tokens);
  const title = entry.latestReported === true ? '运行中 · 最近一次上报' : '最近一次请求';

  return (
    <LegendRow
      muted
      title={title}
      label={entry.label}
      value={tokens}
    />
  );
}
