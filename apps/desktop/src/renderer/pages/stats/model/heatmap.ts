import type { StatsDailySnapshot } from '@/shell-contract';

/** Intensity bucket of one heatmap cell. */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ActivityHeatmapSlot {
  day: StatsDailySnapshot | null;
  level: ActivityLevel;
}

export interface ActivityHeatmapMonth {
  label: string;
  weekIndex: number;
}

export interface ActivityHeatmapModel {
  slots: ActivityHeatmapSlot[];
  months: ActivityHeatmapMonth[];
  weekCount: number;
}

/** One level per 100M daily tokens, capped at the fifth level. */
const TOKENS_PER_LEVEL = 100_000_000;

function parseLocalDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function activityLevel(value: number): ActivityLevel {
  if (value <= 0) return 0;
  return Math.min(5, Math.floor(value / TOKENS_PER_LEVEL) + 1) as 1 | 2 | 3 | 4 | 5;
}

/**
 * Lays one day per row down weekly columns: seven local days per column with
 * leading and trailing placeholders, a short month label at the week where the
 * month starts, and a fixed 0-5 token-intensity level per day.
 */
export function buildActivityHeatmap(daily: StatsDailySnapshot[]): ActivityHeatmapModel {
  const parsed = daily
    .map((day) => ({ day, date: parseLocalDayKey(day.dayKey) }))
    .filter((item): item is { day: StatsDailySnapshot; date: Date } => item.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (parsed.length === 0) return { slots: [], months: [], weekCount: 0 };

  const leading = parsed[0].date.getDay();
  const slots: ActivityHeatmapSlot[] = Array.from({ length: leading }, () => ({ day: null, level: 0 }));
  const months: ActivityHeatmapMonth[] = [];
  let previousMonth = '';

  for (const { day, date } of parsed) {
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    const weekIndex = Math.floor(slots.length / 7);
    if (monthKey !== previousMonth) {
      const month = {
        label: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date),
        weekIndex,
      };
      if (months.at(-1)?.weekIndex === weekIndex) months[months.length - 1] = month;
      else months.push(month);
      previousMonth = monthKey;
    }
    slots.push({ day, level: activityLevel(day.totalTokens) });
  }

  const trailing = (7 - (slots.length % 7)) % 7;
  slots.push(...Array.from({ length: trailing }, () => ({ day: null, level: 0 } as ActivityHeatmapSlot)));
  return { slots, months, weekCount: slots.length / 7 };
}
