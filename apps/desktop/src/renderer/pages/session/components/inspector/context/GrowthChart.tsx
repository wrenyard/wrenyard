import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/renderer/components/ui/chart';
import { formatTokenCount } from '@/renderer/lib/format';
import type { ContextBudgetView, TurnGrowth } from '../../../model/usage.js';

const GROWTH_CONFIG: ChartConfig = {
  cumulative: { label: '累计占用', color: 'var(--chart-1)' },
};

function sumTokens(values: readonly { tokens: number }[]): number {
  let total = 0;
  for (const value of values) total += value.tokens;
  return total;
}

export interface GrowthChartProps {
  growth: readonly TurnGrowth[];
  budget: ContextBudgetView;
}

/** Per-turn cumulative context growth against the model window and available budget. */
export function GrowthChart({ growth, budget }: GrowthChartProps) {
  if (growth.length === 0) return <p className="text-sm text-muted-foreground">还没有可用的轮次数据</p>;
  const baseline = Math.max(0, budget.total - sumTokens(growth));
  const data = [...growth].sort((left, right) => left.turn - right.turn).map((point) => ({ ...point, cumulative: baseline + point.cumulative }));
  const topCandidate = Math.max(...data.map((point) => point.cumulative), budget.available ?? 0, budget.window ?? 0);
  const top = topCandidate > 0 ? topCandidate : 1;

  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={GROWTH_CONFIG} className="aspect-auto h-48 w-full">
        <AreaChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="turn" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value: number) => `T${value}`} />
          <YAxis width={40} tickLine={false} axisLine={false} domain={[0, top]} tickFormatter={(value: number) => formatTokenCount(value)} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            dataKey="cumulative"
            type="monotone"
            stroke="var(--color-cumulative)"
            fill="var(--color-cumulative)"
            fillOpacity={0.3}
          />
          {budget.available !== undefined && (
            <ReferenceLine y={budget.available} stroke="var(--destructive)" strokeDasharray="4 4" />
          )}
          {budget.window !== undefined && (
            <ReferenceLine y={budget.window} stroke="var(--muted-foreground)" strokeDasharray="2 2" />
          )}
        </AreaChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-0.5 w-4 bg-destructive" />
          可用窗口 · 预留输出起点
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-0.5 w-4 bg-muted-foreground" />
          模型窗口
        </span>
      </div>
    </div>
  );
}
