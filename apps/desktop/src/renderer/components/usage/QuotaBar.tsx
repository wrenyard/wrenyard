import { useEffect, useState } from 'react';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ProgressIndicator, ProgressTrack } from '@/renderer/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';

/**
 * Shared quota-window bar for the usage panel, status-bar quota panel and Model
 * Supply page. It renders one inline compact row: window name, a 4px
 * `ProgressTrack`/`ProgressIndicator` bar with a visible pace marker, the
 * remaining percentage, and the structured pace/reset text.
 *
 * The 4px bar and 8px pace line are the registered size exceptions from the
 * usage-meter spec (section 6.4): a quota bar is an information-dense metric,
 * not an interactive progress control.
 */

/** Alert level derived from the remaining percentage (usage spec 6.1). */
export type QuotaLevel = 'normal' | 'warning' | 'destructive';

/** Fill colour per alert level; otherwise the primary colour. */
const FILL_CLASS: Record<QuotaLevel, string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

/** Reset-time copy shared by the bar and (later) the quota notifications. */
export const RESET_PENDING_LABEL = '等待刷新';

/** Window-name overrides keyed by the provider window length in minutes. */
const WINDOW_MINUTE_LABELS: Readonly<Record<number, string>> = {
  300: '5h',
  10080: '7d',
  43200: '30d',
};

/**
 * Alert level for a remaining percentage: `<= 20` warns, `<= 5` is
 * destructive. Values are clamped into `[0, 100]`.
 */
export function quotaLevel(remainingPct: number): QuotaLevel {
  const value = Number.isFinite(remainingPct) ? remainingPct : 0;
  if (value <= 5) return 'destructive';
  if (value <= 20) return 'warning';
  return 'normal';
}

/** Chinese window label from the provider window length, else the raw name. */
export function formatWindowName(name: string, windowMinutes?: number): string {
  if (windowMinutes !== undefined && WINDOW_MINUTE_LABELS[windowMinutes] !== undefined) {
    return WINDOW_MINUTE_LABELS[windowMinutes];
  }
  if (name === '1mo') return '30d';
  return name;
}

export interface QuotaPaceView {
  label: string;
  /** True when consumption is faster than the uniform pace (below −5%). */
  warn: boolean;
}

/**
 * Pace delta label (`配速 +8%` / `配速 −12%`): `remainingPct -
 * expectedRemainingPct` rounded to an integer. Positive is slower than uniform
 * consumption (saving), negative is faster. Returns null without an expected
 * value so no pace is fabricated.
 */
export function paceView(remainingPct: number, expectedRemainingPct: number | null): QuotaPaceView | null {
  if (expectedRemainingPct === null || !Number.isFinite(expectedRemainingPct)) return null;
  const delta = Math.round(remainingPct - expectedRemainingPct);
  return {
    label: `配速 ${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`,
    warn: delta < -5,
  };
}

export interface QuotaResetView {
  /** Relative countdown, or `等待刷新` once the reset instant has passed. */
  label: string;
  /** Exact reset instant for the hover tooltip. */
  exact: string;
}

/**
 * Structured reset countdown from an ISO reset time. A past reset instant shows
 * `等待刷新` because the observation has not refreshed yet. Returns null when
 * the value is absent or unparseable.
 */
export function resetView(resetsAt: string | undefined, nowMs: number): QuotaResetView | null {
  if (typeof resetsAt !== 'string') return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const exact = new Date(resetMs).toLocaleString();
  const remaining = resetMs - nowMs;
  if (remaining <= 0) return { label: RESET_PENDING_LABEL, exact };
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const label = days > 0
    ? `${days} 天 ${hours} 小时后重置`
    : hours > 0
      ? `${hours} 小时 ${minutes} 分后重置`
      : `${Math.max(minutes, 1)} 分钟后重置`;
  return { label, exact };
}

export interface QuotaBarProps {
  /** Raw provider window name (used verbatim when no label override applies). */
  name: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
  resetsAt?: string;
  windowMinutes?: number;
  /** Bar width in pixels: 96 in panels, 120 on the Model Supply page. */
  width?: number;
  /** When true the whole row is dimmed and the name is marked stale. */
  stale?: boolean;
  /**
   * Narrow surfaces (popovers) put pace and reset on a second line under the
   * bar, which then fills the row instead of using a fixed width.
   */
  stacked?: boolean;
  /**
   * Current time in ms for the reset countdown. Injected by pure consumers
   * (e.g. the reusable quota tips); omitted to use the live minute clock.
   */
  now?: number;
  className?: string;
}

/**
 * One quota window row. Renders structured pace and reset countdown from the
 * projected snapshot fields; it never parses `displayLine`.
 */
export function QuotaBar({
  name,
  remainingPct,
  expectedRemainingPct,
  resetsAt,
  windowMinutes,
  width = 96,
  stale = false,
  stacked = false,
  now: injectedNow,
  className,
}: QuotaBarProps) {
  const minuteNow = useMinuteNow();
  const now = injectedNow ?? minuteNow;
  const bounded = Math.max(0, Math.min(100, Number.isFinite(remainingPct) ? remainingPct : 0));
  const label = formatWindowName(name, windowMinutes);
  const level = quotaLevel(bounded);
  const pace = paceView(bounded, expectedRemainingPct);
  const reset = resetView(resetsAt, now);
  const paceLeft = pace !== null && expectedRemainingPct !== null
    ? `${Math.max(0, Math.min(100, expectedRemainingPct))}%`
    : null;

  const bar = (
    <div className={cn('relative flex h-2 items-center', stacked ? 'min-w-0 flex-1' : 'shrink-0')} style={stacked ? undefined : { width }}>
      <ProgressPrimitive.Root
        value={bounded}
        aria-label={`${label} 剩余 ${Math.floor(bounded)}%`}
        className="w-full"
      >
        <ProgressTrack className="h-1 w-full rounded-full">
          <ProgressIndicator className={FILL_CLASS[level]} />
        </ProgressTrack>
      </ProgressPrimitive.Root>
      {paceLeft !== null && (
        <span
          data-slot="quota-pace-marker"
          className="pointer-events-none absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: paceLeft }}
        />
      )}
    </div>
  );
  const meta = (pace !== null || reset !== null) && (
    <span className={cn('flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground', stacked && 'pl-16')}>
      {pace !== null && (
        <span className={cn(pace.warn && 'text-warning')}>{pace.label}</span>
      )}
      {pace !== null && reset !== null && <span aria-hidden="true">·</span>}
      {reset !== null && (
        <Tooltip>
          <TooltipTrigger render={<span className="cursor-default">{reset.label}</span>} />
          <TooltipContent>{reset.exact}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
  const head = (
    <>
      <span className="w-14 shrink-0 truncate text-xs text-muted-foreground">{label}</span>
      {stale && <span className="shrink-0 text-xs text-warning">（数据过期）</span>}
      {bar}
      <span className="w-9 shrink-0 text-right text-xs tabular-nums">{Math.floor(bounded)}%</span>
    </>
  );

  if (stacked) {
    return (
      <div className={cn('flex flex-col gap-0.5', stale && 'opacity-60', className)}>
        <div className="flex items-center gap-2">{head}</div>
        {meta}
      </div>
    );
  }
  return (
    <div className={cn('flex items-center gap-2', stale && 'opacity-60', className)}>
      {head}
      {meta}
    </div>
  );
}

/** Re-renders once a minute so the reset countdown stays current. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
