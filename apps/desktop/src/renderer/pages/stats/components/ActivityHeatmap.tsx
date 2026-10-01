import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';
import type { StatsDailySnapshot } from '@/shell-contract';
import {
  HEATMAP_EMPTY,
  HEATMAP_LOUD_LABEL,
  HEATMAP_QUIET_LABEL,
  HEATMAP_TITLE,
  heatmapTooltipLines,
} from '../model/describe.js';
import { buildActivityHeatmap, type ActivityLevel } from '../model/heatmap.js';

/** Theme-token intensity ramp; both themes adapt automatically. */
const LEVEL_CLASS: Record<ActivityLevel, string> = {
  0: 'bg-muted',
  1: 'bg-primary/20',
  2: 'bg-primary/40',
  3: 'bg-primary/60',
  4: 'bg-primary/80',
  5: 'bg-primary',
};

const LEGEND_LEVELS: ActivityLevel[] = [0, 1, 2, 3, 4, 5];

/** One year of daily tokens laid out by week; today's cell is ringed. */
export function ActivityHeatmap({ daily, todayKey }: { daily: StatsDailySnapshot[]; todayKey?: string }) {
  const model = buildActivityHeatmap(daily.slice(-365));
  if (model.slots.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{HEATMAP_TITLE}</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{HEATMAP_EMPTY}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }
  const monthByWeek = new Map(model.months.map((month) => [month.weekIndex, month.label]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{HEATMAP_TITLE}</CardTitle>
        <CardAction>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>{HEATMAP_QUIET_LABEL}</span>
            <div className="flex items-center gap-1">
              {LEGEND_LEVELS.map((level) => (
                <span key={level} className={cn('size-3 rounded-sm', LEVEL_CLASS[level])} aria-hidden />
              ))}
            </div>
            <span>{HEATMAP_LOUD_LABEL}</span>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="w-max pb-2">
            <div
              className="mb-1 grid gap-1"
              style={{ gridTemplateColumns: `repeat(${model.weekCount}, 0.75rem)` }}
            >
              {Array.from({ length: model.weekCount }, (_, weekIndex) => (
                <span key={weekIndex} className="text-muted-foreground">
                  {monthByWeek.get(weekIndex) ?? ''}
                </span>
              ))}
            </div>
            <div className="grid grid-flow-col grid-rows-7 gap-1" role="list">
              {model.slots.map((slot, index) => {
                const day = slot.day;
                if (!day) return <span key={index} className="size-3 rounded-sm" aria-hidden />;
                const isToday = todayKey !== undefined && day.dayKey === todayKey;
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
                            'size-3 rounded-sm',
                            LEVEL_CLASS[slot.level],
                            isToday && 'ring-1 ring-ring',
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
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
