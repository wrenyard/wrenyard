import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { usageRingLevel, type UsageRingLevel } from '@/renderer/components/usage/UsageRing';
import { formatTokenCount, formatRatio } from '@/renderer/lib/format';
import type { ContextBudgetView, RoleContextEntry, UsageGroupView } from '../../model/usage.js';
import { cn } from 'cn';

/**
 * Expanded detail of the ctx popover (usage spec 5.2). A Wrenyard session is
 * several separate stateless LLM conversations — reason plus the auxiliary
 * roles reply, dispatch, document, vcs, project, search, memory-search and title. The panel groups
 * by internal conversation. The forward-looking send-block estimate is shown
 * first, labelled as an estimate with its 构成明细 construction detail, and the
 * actual role rows follow from each conversation's latest reported single
 * request. The estimate is never attached to an actual token value. Chinese
 * product copy.
 */

/** Bar fill colour for a ratio at the 70% / 90% thresholds (usage spec 4). */
const ROLE_FILL_CLASS: Record<UsageRingLevel, string> = {
  normal: 'bg-muted-foreground',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

export interface ContextBreakdownProps {
  /** Per-role context entries: the reason row first, then auxiliary roles. */
  roles: RoleContextEntry[];
  /** Forward-looking send-block budget (inspection total plus draft input). */
  budget: ContextBudgetView | undefined;
  /** Layer composition groups of the estimated next request; the 构成明细 legend. */
  groups: UsageGroupView[];
  /** Display name of the reason model, for the overflow alert. */
  modelName?: string;
  /** Optional header spacing override for compact panel compositions. */
  headerClassName?: string;
}

export function ContextBreakdown({ roles, budget, groups, modelName, headerClassName }: ContextBreakdownProps) {
  const [expanded, setExpanded] = useState(false);
  const segments: TokenBarSegment[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    tokens: group.tokens,
    color: group.color,
  }));
  const compositionTotal = groups.reduce((sum, group) => sum + group.tokens, 0);
  const reason = roles.find((entry) => entry.role === 'reason');
  const auxiliary = roles.filter((entry) => entry.role !== 'reason');
  // The estimate sizes the next request against the available window and is
  // what the Composer blocks sending on; it is labelled as an estimate and is
  // never mixed into an actual role row.
  const estimateFigure = budget === undefined
    ? undefined
    : budget.available === undefined
      ? `约 ${formatTokenCount(budget.total)}`
      : `${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)}`;

  const estimateDetail = budget === undefined ? null : (
    <div className="flex flex-col gap-2 pt-1" data-slot="context-estimate">
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0">预计发送</span>
        {estimateFigure !== undefined && (
          <span className="ml-auto tabular-nums text-muted-foreground">{estimateFigure}</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-slot="context-legend-toggle"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
        构成明细
      </button>
      {expanded && (
        <>
          <TokenBar segments={segments} window={budget.window} reserved={budget.reserved} />
          <div className="flex flex-col">
            {groups.map((group) => {
              const pct = compositionTotal > 0 ? (group.tokens / compositionTotal) * 100 : 0;
              return (
                <div key={group.id} className="flex h-5 items-center gap-2 text-xs" data-slot="context-legend-row">
                  <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: group.color }} />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="tabular-nums text-muted-foreground">{formatTokenCount(group.tokens)}</span>
                  <span className="w-12 text-right tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col" data-slot="context-breakdown">
      {/* Header */}
      <div className={cn('flex items-center justify-between gap-3', headerClassName ?? 'px-3 pt-3')}>
        <span className="text-sm font-medium">会话上下文</span>
      </div>

      {budget?.exceeded === true && (
        <div className="px-3 pt-2">
          <Alert variant="destructive">
            <AlertDescription>
              {`${modelName ?? reason?.model ?? '主推理'} 的上下文较大（可用窗口 ${formatTokenCount(budget.available)}），发送时将先压缩`}
            </AlertDescription>
          </Alert>
        </div>
      )}

      <div className="px-3 pt-2">{estimateDetail}</div>

      <div className="flex flex-col gap-2.5 px-3 py-3">
        {reason !== undefined && <RoleRow entry={reason} />}
        {auxiliary.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground" data-slot="context-auxiliary-label">辅助会话</span>
            {auxiliary.map((entry) => <RoleRow key={entry.role} entry={entry} />)}
          </>
        )}
      </div>
    </div>
  );
}

interface RoleRowProps {
  entry: RoleContextEntry;
}

/**
 * One internal conversation's actual occupancy row: label, model, the latest
 * reported single-request tokens over that model's window, and its bar. An
 * unknown token count or window shows a dash with no bar or risk colour.
 */
function RoleRow({ entry }: RoleRowProps) {
  // A role with no usable route shows only its label and a muted note.
  if (entry.error !== undefined) {
    return (
      <div className="flex items-center gap-2 text-xs" data-slot="context-role-row" data-role={entry.role}>
        <span className="shrink-0">{entry.label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">无可用线路</span>
      </div>
    );
  }
  const level = entry.ratio === undefined ? 'normal' : usageRingLevel(entry.ratio);
  const width = entry.ratio === undefined ? 0 : Math.max(0, Math.min(1, entry.ratio)) * 100;
  const tokens = entry.tokens === undefined ? '—' : formatTokenCount(entry.tokens);
  // Window-known form: `tokens / window · percent`; window-unknown: tokens only.
  const amount = entry.window === undefined
    ? tokens
    : `${tokens} / ${formatTokenCount(entry.window)}${entry.ratio === undefined ? '' : ` · ${formatRatio(entry.ratio)}`}`;
  return (
    <div className="flex flex-col gap-1" data-slot="context-role-row" data-role={entry.role}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0">{entry.label}</span>
        {entry.modelLabel !== undefined && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.modelLabel}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{amount}</span>
      </div>
      <span className="text-[11px] text-muted-foreground" data-slot="context-role-basis">
        {entry.latestReported === true ? '运行中 · 最近一次上报' : '最近一次请求'}
      </span>
      {entry.ratio !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', ROLE_FILL_CLASS[level])} style={{ width: `${width}%` }} />
        </div>
      )}
    </div>
  );
}
