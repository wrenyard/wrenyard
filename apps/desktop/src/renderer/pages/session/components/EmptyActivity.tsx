import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatTokenCount } from '@/renderer/lib/format';
import { heatmapTooltipLines } from '@/renderer/pages/stats/model/describe';
import { buildActivityHeatmap } from '@/renderer/pages/stats/model/heatmap';
import { useStatsQuery } from '@/renderer/pages/stats/queries';
import { cn } from 'cn';

type RelativeLevel = 0 | 1 | 2 | 3 | 4;

/** Intensity ramp relative to the user's own usage, not the ledger's fixed steps. */
const RELATIVE_CLASS: Record<RelativeLevel, string> = {
  0: 'bg-muted',
  1: 'bg-primary/25',
  2: 'bg-primary/50',
  3: 'bg-primary/75',
  4: 'bg-primary',
};

/** Quartile thresholds over the non-zero token counts currently on screen. */
function quartiles(values: number[]): [number, number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (position: number) => sorted[Math.min(sorted.length - 1, Math.floor(position * sorted.length))] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

function levelFor(tokens: number, [q1, q2, q3]: [number, number, number]): RelativeLevel {
  if (tokens <= 0) return 0;
  if (tokens <= q1) return 1;
  if (tokens <= q2) return 2;
  if (tokens <= q3) return 3;
  return 4;
}

/**
 * Compact Claude-app-style activity heatmap for the blank new-chat page of the
 * main window. It reuses the ledger's daily stats, tooltip copy and token
 * formatter, shows the last 26 weeks as dots on a relative scale, and hides
 * itself while the stats load, are unavailable or hold no activity.
 */
export function EmptyActivity({ weeks = 26 }: { weeks?: number }) {
  const query = useStatsQuery();
  const snapshot = query.data;
  if (query.isPending || query.isError || !snapshot || snapshot.status !== 'available') return null;

  // How many weeks of daily days feed the strip; anything older is dropped.
  const RANGE_DAYS = weeks * 7;
  const days = snapshot.daily.slice(-RANGE_DAYS);
  const lastRealDay = days.at(-1);
  if (!lastRealDay || days.every((day) => day.totalTokens === 0)) return null;

  const model = buildActivityHeatmap(days);
  const thresholds = quartiles(days.filter((day) => day.totalTokens > 0).map((day) => day.totalTokens));

  const todayKey = snapshot.today?.dayKey ?? lastRealDay.dayKey;
  const todayTokens = snapshot.today?.totalTokens ?? lastRealDay.totalTokens;
  const last7Tokens = days.slice(-7).reduce((sum, day) => sum + day.totalTokens, 0);

  // Consecutive active days ending today; when today is idle, count from yesterday.
  const activeTail = lastRealDay.totalTokens > 0 ? days : days.slice(0, -1);
  let streak = 0;
  for (const day of [...activeTail].reverse()) {
    if (day.totalTokens > 0) streak += 1;
    else break;
  }

  const parts = [`今天 ${formatTokenCount(todayTokens)} Token`, `近 7 天 ${formatTokenCount(last7Tokens)} Token`];
  if (streak > 0) parts.push(`连续 ${streak} 天`);

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="grid grid-flow-col grid-rows-7 gap-1" role="list">
        {model.slots.map((slot, index) => {
          const day = slot.day;
          if (!day) return <span key={index} className="size-2.5" aria-hidden />;
          const isToday = day.dayKey === todayKey;
          const lines = heatmapTooltipLines(day);
          return (
            <Tooltip key={index}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="listitem"
                    aria-label={lines.join('，')}
                    tabIndex={day.totalTokens > 0 || isToday ? 0 : -1}
                    className={cn(
                      'size-2.5 rounded-full',
                      RELATIVE_CLASS[levelFor(day.totalTokens, thresholds)],
                      isToday && 'ring-1 ring-ring ring-offset-1 ring-offset-background',
                    )}
                  />
                }
              />
              <TooltipContent>
                <div className="flex flex-col gap-0.5">
                  {lines.map((line) => <span key={line}>{line}</span>)}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <span className="text-xs text-muted-foreground">{parts.join(' · ')}</span>
    </div>
  );
}
