import { useEffect, useState } from 'react';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ProgressIndicator, ProgressTrack } from '@/renderer/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { cn } from 'cn';

/**
 * Shared quota-window bar for the usage panel, status-bar quota panel and Model
 * Supply page. It renders one inline compact row: a text line with the window
 * name, the truncated reset countdown and pace word on the left and `已用 N%`
 * on the right, then the 6px `ProgressTrack`/`ProgressIndicator` bar with a
 * visible pace marker. It renders structured pace and reset from the projected
 * snapshot fields; it never parses `displayLine`.
 *
 * The 6px bar and 1px pace tick are the registered size exceptions from the
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

/** Descriptive window-name overrides keyed by the provider window length in minutes. */
const WINDOW_MINUTE_LABELS: Readonly<Record<number, string>> = {
  300: '5 小时',
  10080: '7 天',
  43200: '30 天',
};

/** Compact window-name overrides for the status-bar label. */
const SHORT_WINDOW_MINUTE_LABELS: Readonly<Record<number, string>> = {
  300: '5h',
  10080: '7d',
  43200: '30d',
};

/** Severity ordering for alert levels. */
const SEVERITY: Readonly<Record<QuotaLevel, number>> = { normal: 0, warning: 1, destructive: 2 };

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

/** Descriptive window label (`5 小时`) from the provider window length, else the raw name. */
function formatWindowName(name: string, windowMinutes?: number): string {
  if (windowMinutes !== undefined && WINDOW_MINUTE_LABELS[windowMinutes] !== undefined) {
    return WINDOW_MINUTE_LABELS[windowMinutes];
  }
  if (name === '1mo') return '30 天';
  return name;
}

/** Compact window label (`5h` / `7d` / `30d`) for the status-bar item. */
export function shortWindowName(name: string, windowMinutes?: number): string {
  if (windowMinutes !== undefined && SHORT_WINDOW_MINUTE_LABELS[windowMinutes] !== undefined) {
    return SHORT_WINDOW_MINUTE_LABELS[windowMinutes];
  }
  if (name === '1mo') return '30d';
  return name;
}

export interface QuotaPaceView {
  label: string;
  /** Coarse pace word: `偏快` when consuming faster than uniform, else `偏慢`. */
  word: string;
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
    word: delta < 0 ? '偏快' : '偏慢',
    warn: delta < -5,
  };
}

/**
 * Alert level of one pool: the remaining-percentage level from
 * {@link quotaLevel}, escalated to warning when the pace projects running out
 * before reset. Shared by the status-bar label tone and {@link quotaVerdict}.
 */
export function quotaPoolLevel(window: {
  remainingPct: number;
  expectedRemainingPct: number | null;
}): QuotaLevel {
  const level = quotaLevel(window.remainingPct);
  if (level !== 'normal') return level;
  return paceView(window.remainingPct, window.expectedRemainingPct)?.warn === true ? 'warning' : 'normal';
}

export interface QuotaVerdictWindow {
  name: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
  windowMinutes?: number;
}

export interface QuotaVerdict {
  /** 额度充足 / 额度偏紧 / 额度不足. */
  label: string;
  level: 'sufficient' | 'tight' | 'insufficient';
  /** Short muted reason, or undefined when every pool is normal. */
  reason: string | undefined;
}

/**
 * One-line verdict on whether to keep using the current model (usage spec 6.2):
 * `额度充足` when every pool is normal and not projected to run out before
 * reset, `额度偏紧` on any warning pool or a fast pace, `额度不足` on any
 * destructive pool. Reuses the {@link quotaLevel} / {@link paceView} thresholds
 * through {@link quotaPoolLevel} — no new thresholds.
 */
export function quotaVerdict(windows: readonly QuotaVerdictWindow[]): QuotaVerdict {
  let worst: { level: QuotaLevel; window: QuotaVerdictWindow } | null = null;
  for (const window of windows) {
    if (!Number.isFinite(window.remainingPct)) continue;
    const level = quotaPoolLevel(window);
    if (worst === null
      || SEVERITY[level] > SEVERITY[worst.level]
      || (SEVERITY[level] === SEVERITY[worst.level] && window.remainingPct < worst.window.remainingPct)) {
      worst = { level, window };
    }
  }
  if (worst === null || worst.level === 'normal') {
    return { label: '额度充足', level: 'sufficient', reason: undefined };
  }
  const name = shortWindowName(worst.window.name, worst.window.windowMinutes);
  const exhausted = worst.window.remainingPct <= 0;
  return worst.level === 'destructive'
    ? { label: '额度不足', level: 'insufficient', reason: exhausted ? `${name} 已耗尽` : `${name} 将在重置前用尽` }
    : { label: '额度偏紧', level: 'tight', reason: `${name} 将在重置前用尽` };
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
  /** When true the whole row is dimmed and the name is marked stale. */
  stale?: boolean;
  /**
   * Current time in ms for the reset countdown. Injected by pure consumers
   * (e.g. the reusable quota tips); omitted to use the live minute clock.
   */
  now?: number;
  /**
   * Presentation surface. `card` (default) is the light panel/card; `inverse`
   * adapts the track, pace tick, fill and muted text for the dark tooltip.
   */
  surface?: 'card' | 'inverse';
  className?: string;
}

/**
 * One quota window row in the compact Claude-App style: a single text line
 * (`5 小时 · 2 小时 14 分后重置 · 偏快` / `已用 32%`) over the 6px used-fill
 * bar with a 1px pace tick. A stale pool appends `· 数据过期` inline.
 */
export function QuotaBar({
  name,
  remainingPct,
  expectedRemainingPct,
  resetsAt,
  windowMinutes,
  stale = false,
  now: injectedNow,
  surface = 'card',
  className,
}: QuotaBarProps) {
  const minuteNow = useMinuteNow();
  const now = injectedNow ?? minuteNow;
  const inverse = surface === 'inverse';
  const bounded = Math.max(0, Math.min(100, Number.isFinite(remainingPct) ? remainingPct : 0));
  const label = formatWindowName(name, windowMinutes);
  const level = quotaLevel(bounded);
  const used = 100 - bounded;
  const pace = paceView(bounded, expectedRemainingPct);
  const exhausted = bounded <= 0;
  const reset = resetView(resetsAt, now);
  const fillClass = inverse
    ? level === 'warning'
      ? 'bg-warning'
      : level === 'destructive'
        ? 'bg-destructive'
        : 'bg-background/80'
    : FILL_CLASS[level];
  const mutedClass = inverse ? 'text-background/60' : 'text-muted-foreground';
  const markerLeft = expectedRemainingPct !== null
    ? `${Math.max(0, Math.min(100, 100 - expectedRemainingPct))}%`
    : null;

  return (
    <div className={cn('flex flex-col gap-1.5', stale && 'opacity-60', className)} data-slot="quota-bar">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn('flex min-w-0 items-center gap-1', mutedClass)}>
          <span className="truncate">{label}</span>
          {reset !== null && (
            <Tooltip>
              <TooltipTrigger render={<span className="shrink-0 cursor-default">· {reset.label}</span>} />
              <TooltipContent>{reset.exact}</TooltipContent>
            </Tooltip>
          )}
          {exhausted
            ? <span className="shrink-0 text-destructive">· 已耗尽</span>
            : pace !== null && <span className={cn('shrink-0', pace.warn && 'text-warning')}>· {pace.word}</span>}
          {stale && <span className="shrink-0 text-warning">· 数据过期</span>}
        </span>
        <span className="shrink-0 tabular-nums">{`已用 ${Math.floor(used)}%`}</span>
      </div>
      <div className="relative flex h-1.5 items-center">
        <ProgressPrimitive.Root
          value={used}
          aria-label={`${label} 已用 ${Math.floor(used)}%`}
          className="w-full"
        >
          <ProgressTrack className={cn('h-1.5 w-full rounded-full', inverse && 'bg-background/20')}>
            <ProgressIndicator className={fillClass} />
          </ProgressTrack>
        </ProgressPrimitive.Root>
        {markerLeft !== null && (
          <span
            data-slot="quota-pace-marker"
            className={cn(
              'pointer-events-none absolute top-0 h-1.5 w-px -translate-x-1/2 rounded-full',
              inverse ? 'bg-background' : 'bg-foreground',
            )}
            style={{ left: markerLeft }}
          />
        )}
      </div>
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
