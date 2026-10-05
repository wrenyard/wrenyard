import {
  Bot,
  Brain,
  FilePenLine,
  FileText,
  MessageSquare,
  OctagonX,
  User,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { TokenBar, type TokenBarSegment } from '@/renderer/components/usage/TokenBar';
import { formatTokenCount } from '@/renderer/lib/format';
import type { ContextInspection, ContextItemKind } from '@/shell-contract';
import type { TurnGrowth, UsageGroupView } from '../../model/usage.js';
import { formatExactTokens, ITEM_KIND_LABEL } from '../../model/usage.js';
import type { TurnModel } from '../../model/types.js';

/**
 * Expanded detail of the usage panel (usage spec 5.2): composition, largest
 * entries and per-turn growth. It renders only; the meter owns the popover and
 * the inspector requests.
 */

const KIND_ICON: Record<ContextItemKind, LucideIcon> = {
  user: User,
  assistant: Bot,
  thinking: Brain,
  'doc-search': FileText,
  files: FileText,
  error: OctagonX,
  reply: MessageSquare,
  doc: FileText,
  memory: Brain,
  'action-result': Wrench,
  'ws-update': FilePenLine,
  interrupt: OctagonX,
};

export interface ContextBreakdownProps {
  inspection: ContextInspection;
  groups: UsageGroupView[];
  growth: TurnGrowth[];
  /** Total usage including the input text; the legend percentage denominator. */
  total: number;
  turns: readonly TurnModel[];
  /** Open the inspector context tab and close the panel. */
  onAudit: () => void;
  /** Jump to the ledger event for a composition item. */
  onInspect: (seq: number) => void;
}

export function ContextBreakdown({
  inspection,
  groups,
  growth,
  total,
  turns,
  onAudit,
  onInspect,
}: ContextBreakdownProps) {
  const segments: TokenBarSegment[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    tokens: group.tokens,
    color: group.color,
  }));
  const largest = [...inspection.items].sort((left, right) => right.tokens - left.tokens).slice(0, 5);
  const peak = growth.reduce((max, entry) => Math.max(max, entry.tokens), 0);

  return (
    <div className="flex flex-col gap-4" data-slot="context-breakdown">
      {/* Composition */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">构成</h3>
        <TokenBar segments={segments} window={inspection.model.contextWindow} reserved={inspection.model.maxOutputTokens} />
        <div className="flex flex-col gap-1">
          {groups.map((group) => {
            const pct = total > 0 ? (group.tokens / total) * 100 : 0;
            return (
              <div key={group.id} className="flex items-center gap-2 text-xs">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <span className="tabular-nums text-muted-foreground">{formatTokenCount(group.tokens)}</span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Largest entries */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">最大的条目</h3>
        {largest.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无条目</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {largest.map((item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <Button
                  key={`${item.seq}:${item.kind}`}
                  type="button"
                  onClick={() => onInspect(item.seq)}
                  variant="ghost"
                  className="w-full justify-start"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>
                  <span className="shrink-0 text-muted-foreground">{ITEM_KIND_LABEL[item.kind]}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">第 {item.turn} 轮</span>
                  <span className="shrink-0 tabular-nums">{formatTokenCount(item.tokens)}</span>
                </Button>
              );
            })}
          </div>
        )}
      </section>

      {/* Growth per turn */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">按轮增长</h3>
        {growth.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无轮次数据</p>
        ) : (
          <div className="flex h-16 items-end gap-1" data-slot="context-growth">
            {growth.map((entry) => {
              const height = peak > 0 ? Math.max(2, (entry.tokens / peak) * 100) : 2;
              const firstLine = firstUserLine(turns, entry.turn);
              return (
                <Tooltip key={entry.turn}>
                  <TooltipTrigger
                    render={
                      <span
                        className="w-3 shrink-0 rounded-sm bg-chart-3"
                        style={{ height: `${height}%` }}
                      />
                    }
                  />
                  <TooltipContent>
                    <span className="flex flex-col gap-0.5">
                      <span>第 {entry.turn} 轮 · 新增 {formatExactTokens(entry.tokens)}</span>
                      {firstLine !== undefined && <span className="max-w-56 truncate">{firstLine}</span>}
                    </span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
      </section>

      <Button type="button" variant="outline" size="sm" onClick={onAudit}>
        在检查器中审计
      </Button>
    </div>
  );
}

function firstUserLine(turns: readonly TurnModel[], turnId: number): string | undefined {
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn) return undefined;
  const line = turn.user.text.split('\n')[0]?.trim() ?? '';
  return line === '' ? undefined : line;
}
