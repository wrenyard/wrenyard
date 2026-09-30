import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatElapsedMs } from '@/renderer/lib/format';
import { cn } from '@/renderer/lib/utils';

export interface TimelineRange {
  /** Epoch milliseconds. */
  start: number;
  end: number;
}

export interface TimelineBar {
  id: string;
  /** Epoch milliseconds. */
  start: number;
  /** Epoch milliseconds; absent means "still running" and ends at `now`. */
  end?: number;
  tone?: string;
  label: string;
  detail?: string;
}

export interface TimelineLane {
  id: string;
  label: string;
  bars: TimelineBar[];
}

export interface TimelineBarsProps {
  range: TimelineRange;
  now?: number;
  lanes: TimelineLane[];
  onSelect?: (bar: TimelineBar) => void;
  className?: string;
}

const TONE_CLASS: Record<string, string> = {
  preparing: 'bg-muted-foreground/40',
  reasoning: 'bg-primary',
  acting: 'bg-[var(--moss)]',
  replying: 'bg-[var(--lamp-deep)]',
  'reason-wait': 'bg-primary/25',
  'reason-output': 'bg-primary',
  cheap: 'bg-secondary-foreground/50',
  done: 'bg-[var(--moss)]',
  ok: 'bg-[var(--moss)]',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/40',
  aborted: 'bg-muted-foreground/40',
  interrupted: 'bg-muted-foreground/40',
  skipped: 'bg-muted-foreground/30',
  running: 'bg-primary',
};

function toneClass(tone: string | undefined): string {
  return TONE_CLASS[tone ?? ''] ?? 'bg-primary/50';
}

/** Candidate tick intervals, from one second up to one week. */
const TICK_STEPS_MS = [
  1_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000, 7_200_000, 10_800_000,
  21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000,
];

/** Smallest interval keeping the axis at roughly 3-5 labels. */
function pickTickStep(span: number): number {
  for (const step of TICK_STEPS_MS) {
    if (span / step <= 4) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** `0`, `30s`, `1m`, `1m 30s`, `1h 5m`. */
function formatTick(ms: number): string {
  if (ms <= 0) return '0';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/**
 * Generic lane-based profiler. Bars are positioned with percentage `left` /
 * `width` styles and never shrink below 2px, so the shortest call stays visible.
 */
export function TimelineBars({ range, now, lanes, onSelect, className }: TimelineBarsProps) {
  const span = range.end - range.start;
  const total = Math.max(1, span);
  const cursor = now === undefined ? range.end : Math.min(Math.max(now, range.start), range.end);
  const showNow = now !== undefined && now >= range.start && now <= range.end;

  const ticks: { ms: number; pct: number }[] = [{ ms: 0, pct: 0 }];
  if (Number.isFinite(span) && span > 0) {
    const step = pickTickStep(span);
    const count = Math.min(12, Math.floor(span / step));
    for (let i = 1; i <= count; i += 1) {
      const offset = i * step;
      ticks.push({ ms: offset, pct: (offset / total) * 100 });
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2" aria-hidden="true">
        <span />
        <div className="relative h-3.5 text-[10px] leading-none text-muted-foreground tabular-nums">
          {ticks.map((tick) => (
            <span key={tick.ms} className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${tick.pct}%` }}>
              {formatTick(tick.ms)}
            </span>
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div key={lane.id} className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">{lane.label}</span>
          <div className="relative h-5 rounded-sm bg-muted/40">
            {lane.bars.map((bar) => {
              const end = bar.end ?? cursor;
              const left = ((bar.start - range.start) / total) * 100;
              const width = ((Math.max(0, end - bar.start)) / total) * 100;
              return (
                <Tooltip key={bar.id}>
                  <TooltipTrigger
                    render={<button type="button" />}
                    className={cn(
                      'absolute top-0 h-full rounded-sm outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring',
                      toneClass(bar.tone),
                    )}
                    style={{ left: `${left}%`, width: `${width}%`, minWidth: 2 }}
                    onClick={() => onSelect?.(bar)}
                    aria-label={bar.label}
                  />
                  <TooltipContent side="top">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{bar.label}</span>
                      <span>
                        +{formatElapsedMs(Math.max(0, bar.start - range.start))}
                        {' · '}
                        {formatElapsedMs(Math.max(0, end - bar.start))}
                      </span>
                      {bar.detail && <span>{bar.detail}</span>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {showNow && (
              <span
                className="pointer-events-none absolute top-[-2px] bottom-[-2px] w-px bg-foreground/70"
                style={{ left: `${((cursor - range.start) / total) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
