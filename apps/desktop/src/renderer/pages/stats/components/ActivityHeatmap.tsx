import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';
import { useEffect, useRef, useState } from 'react';
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

const CELL_PX = 12;
const GAP_PX = 4;

function monthFromDayKey(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = Number(match[1]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? month
    : null;
}

function buildVisibleMonthLabels(visibleSlots: { day: StatsDailySnapshot | null }[], visibleWeeks: number): string[] {
  let lastLabelWeekIndex = -Infinity;
  let previousMonth: number | null = null;
  const labels: string[] = [];

  for (let weekIndex = 0; weekIndex < visibleWeeks; weekIndex++) {
    let month: number | null = null;
    for (let row = 0; row < 7; row++) {
      const dayKey = visibleSlots[weekIndex * 7 + row]?.day?.dayKey;
      if (dayKey) {
        month = monthFromDayKey(dayKey);
        if (month !== null) break;
      }
    }

    let label = '';
    if (month !== null && (previousMonth === null || month !== previousMonth)) {
      if (lastLabelWeekIndex === -Infinity || weekIndex - lastLabelWeekIndex >= 3) {
        label = `${month}月`;
        lastLabelWeekIndex = weekIndex;
      }
    }
    if (month !== null) previousMonth = month;
    labels.push(label);
  }

  return labels;
}

/** One year of daily tokens laid out by week; today's cell is ringed. */
export function ActivityHeatmap({ daily, todayKey }: { daily: StatsDailySnapshot[]; todayKey?: string }) {
  const model = buildActivityHeatmap(daily.slice(-365), { endAt: new Date() });
  const containerRef = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const fit = Math.floor((width + GAP_PX) / (CELL_PX + GAP_PX));
      setWeeks(Math.max(1, Math.min(fit, model.weekCount)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [model.weekCount]);

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

  const visibleSlots = model.slots.slice(-weeks * 7);
  const visibleWeeks = visibleSlots.length / 7;
  const monthLabels = buildVisibleMonthLabels(visibleSlots, visibleWeeks);
  const columnStyle = { gridTemplateColumns: `repeat(${visibleWeeks}, ${CELL_PX}px)`, gap: GAP_PX };

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
        <div ref={containerRef} className="w-full pb-2">
          <div className="mb-1 grid" style={columnStyle}>
            {monthLabels.map((label, weekIndex) => (
              <span key={weekIndex} className="whitespace-nowrap text-muted-foreground">
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-7" style={columnStyle} role="list">
            {visibleSlots.map((slot, index) => {
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
      </CardContent>
    </Card>
  );
}
