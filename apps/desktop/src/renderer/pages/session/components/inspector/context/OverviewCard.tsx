import type { ContextInspection } from '@/shell-contract';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/components/ui/alert';
import { TokenBar } from '@/renderer/components/usage/TokenBar';
import { formatRatio, formatTokenCount } from '@/renderer/lib/format';
import { remainingTurns, type ContextBudgetView, type TurnGrowth, type UsageGroupView } from '../../../model/usage.js';
import { Section } from '../parts.js';

export interface OverviewCardProps {
  inspection: ContextInspection;
  budget: ContextBudgetView;
  groups: readonly UsageGroupView[];
  growth: readonly TurnGrowth[];
  cacheRatio: number | undefined;
}

/** Context budget overview: ratio, composition bar, calibration and remaining turns. */
export function OverviewCard({ inspection, budget, groups, growth, cacheRatio }: OverviewCardProps) {
  const remaining = budget.available === undefined ? null : remainingTurns(growth, budget.available - budget.total);
  const rounds = remaining ? { rounds: remaining.turns, warn: remaining.warn } : null;
  const calibration = inspection.calibration?.model === inspection.model.publicId ? inspection.calibration : undefined;
  const factor = calibration && calibration.estimated > 0 ? calibration.actual / calibration.estimated : undefined;

  return (
    <Section title="上下文">
      <div className="flex flex-col gap-3">
        {budget.exceeded && (
          <Alert variant="destructive">
            <AlertTitle>上下文已超出当前模型的可用窗口</AlertTitle>
            <AlertDescription>
              {`${inspection.model.publicId} 可用 ${formatTokenCount(budget.available)}，当前约 ${formatTokenCount(budget.total)}。`}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-medium tabular-nums">{formatRatio(budget.ratio)}</span>
          <span className="text-sm text-muted-foreground">
            {`约 ${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)} 可用`}
            {budget.reserved !== undefined && ` · 预留输出 ${formatTokenCount(budget.reserved)}`}
          </span>
        </div>
        <TokenBar segments={groups} window={budget.window} reserved={budget.reserved} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{`下次推理 · ${inspection.model.publicId}`}</span>
          {calibration && factor !== undefined && (
            <span>{`按上次实际用量校准约 ${formatTokenCount(budget.total * factor)}（×${factor.toFixed(2)}）`}</span>
          )}
          <span className={cacheRatio !== undefined && cacheRatio < 0.5 ? 'text-warning' : undefined}>
            {cacheRatio === undefined ? '缓存命中 —' : `缓存命中 ${Math.round(cacheRatio * 100)}%`}
          </span>
          {inspection.files && (
            <span>{`常驻图片 ${inspection.files.images} · 省略 ${inspection.files.omitted}`}</span>
          )}
          {rounds && (
            <span className={rounds.warn ? 'text-warning' : undefined}>
              {rounds.rounds > 0 ? `按近 ${Math.min(growth.length, 5)} 轮约还能 ${rounds.rounds} 轮` : '上下文已满，无法继续'}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}
