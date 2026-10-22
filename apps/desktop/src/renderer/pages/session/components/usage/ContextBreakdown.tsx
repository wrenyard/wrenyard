import { useState } from 'react';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { LegendGap, LegendList, LegendRow } from '@/renderer/components/usage/UsageCard';
import { usageRingLevel } from '@/renderer/components/usage/UsageRing';
import { formatTokenCount, formatRatio } from '@/renderer/lib/format';
import type { ContextBudgetView, RoleContextEntry, UsageGroupView } from '../../model/usage.js';
import { cn } from 'cn';

/**
 * Expanded detail of the ctx popover (usage spec 5.2). A Wrenyard session is
 * several separate stateless LLM conversations — reason plus auxiliary roles.
 * The forward-looking send-block estimate is shown first with its composition
 * bar and legend rows; per-role occupancy follows as compact LegendRows.
 * Chinese product copy.
 */

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
  const auxiliaryLevel = usageRingLevel(
    Math.max(0, ...auxiliary.filter((entry) => entry.error === undefined).map((entry) => entry.ratio ?? 0)),
  );
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

  const auxiliaryCount = auxiliary.length;
  const auxiliaryValue = (
    <span className="inline-flex items-center justify-end gap-1">
      {!auxiliaryExpanded && auxiliaryLevel !== 'normal' && (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            auxiliaryLevel === 'warning' && 'bg-warning',
            auxiliaryLevel === 'destructive' && 'bg-destructive',
          )}
          aria-label={auxiliaryLevel === 'destructive' ? '上下文占用过高' : '上下文占用较高'}
        />
      )}
      {auxiliaryCount}
    </span>
  );

  return (
    <div className="flex flex-col gap-1.5" data-slot="context-breakdown">
      {estimateDetail}
      <LegendList>
        {budget !== undefined && groups.map((group) => {
          const pct = compositionTotal > 0 ? (group.tokens / compositionTotal) * 100 : 0;
          return (
            <LegendRow
              key={group.id}
              label={group.label}
              swatch={group.color}
              value={formatTokenCount(group.tokens)}
              percent={`${pct.toFixed(1)}%`}
            />
          );
        })}
        <LegendGap />
        {reason !== undefined && <RoleRow entry={reason} />}
        {auxiliary.length > 0 && (
          <LegendRow
            expandable
            expanded={auxiliaryExpanded}
            onToggle={() => setAuxiliaryExpanded((open) => !open)}
            label="辅助会话"
            value={auxiliaryValue}
          >
            {auxiliary.map((entry) => <RoleRow key={entry.role} entry={entry} />)}
          </LegendRow>
        )}
      </LegendList>
    </div>
  );
}

interface RoleRowProps {
  entry: RoleContextEntry;
}

function RoleRow({ entry }: RoleRowProps) {
  if (entry.error !== undefined) {
    return (
      <div data-slot="context-role-row" data-role={entry.role}>
        <LegendRow
          muted
          label={(
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <span className="shrink-0 whitespace-nowrap">无可用线路</span>
            </span>
          )}
        />
      </div>
    );
  }

  const level = entry.ratio === undefined ? 'normal' : usageRingLevel(entry.ratio);
  const modelPart = entry.modelLabel ?? entry.model;
  const baseName = entry.role === 'reason' ? '主推理' : entry.label;
  const name = modelPart !== undefined ? `${baseName} · ${modelPart}` : baseName;
  const tokens = entry.tokens === undefined ? '—' : formatTokenCount(entry.tokens);
  const amount = entry.window === undefined
    ? tokens
    : `${tokens} / ${formatTokenCount(entry.window)}${entry.ratio === undefined ? '' : ` · ${formatRatio(entry.ratio)}`}`;
  const title = entry.latestReported === true ? '运行中 · 最近一次上报' : '最近一次请求';

  return (
    <div data-slot="context-role-row" data-role={entry.role}>
      <LegendRow
        title={title}
        label={(
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span
              className={cn(
                'shrink-0 whitespace-nowrap tabular-nums',
                level === 'warning' && 'text-warning',
                level === 'destructive' && 'text-destructive',
                (level === 'normal' || entry.ratio === undefined) && 'text-muted-foreground',
              )}
            >
              {amount}
            </span>
          </span>
        )}
      />
    </div>
  );
}
