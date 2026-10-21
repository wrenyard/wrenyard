import { useEffect, useState } from 'react';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ProgressIndicator, ProgressTrack } from '@/renderer/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { QUOTA_PACE_WARN_DELTA } from '@/shell-contract';
import type { QuotaPoolState, QuotaProviderSnapshot } from '@/shell-contract';
import { QUOTA_EVIDENCE_GRACE_MS } from '@wrenyard/auto-routing/constants';
import { cn } from 'cn';

/**
 * Shared quota-window bar for the usage panel, status-bar quota panel and Model
 * Supply page. It renders one inline compact row: a single text line with the
 * window name, reset countdown and pace word on the left and `已用 N%` on the
 * right, then the 6px `ProgressTrack`/`ProgressIndicator` bar with a
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

/** Reset-pending copy shown on a quota bar while a refresh has not arrived. */
export const RESET_PENDING_LABEL = '等待刷新';

/** Copy for a provider that measures no usage at all, e.g. an enterprise
 * single-sign-on login whose usage is not measured. It matches the session
 * quota ring's `unknown_by_design` wording. */
export const UNKNOWN_USAGE_MESSAGE = '按量计费 · 用量未知';

/**
 * Note for a readable snapshot that reports no usage: the provider's own message
 * when it has one, otherwise the standard unknown-usage copy. A surface with
 * nothing measurable shows this instead of a bar or a percentage.
 */
export function unknownUsageNote(message?: string): string {
  const text = typeof message === 'string' ? message.trim() : '';
  return text.length > 0 ? text : UNKNOWN_USAGE_MESSAGE;
}

/**
 * True when a provider snapshot is readable but carries no window and no balance
 * to draw — the usage-unknown case. A failed or pending read is not
 * unknown by design and keeps its own copy.
 */
export function isUsageUnknown(
  snapshot: Pick<QuotaProviderSnapshot, 'status' | 'windows' | 'balances'>,
): boolean {
  return snapshot.status === 'ok' && snapshot.windows.length === 0 && snapshot.balances.length === 0;
}

/** Chinese label of each four-level pool state. */
export const QUOTA_POOL_STATE_LABEL: Readonly<Record<QuotaPoolState, string>> = {
  abundant: '充裕',
  sufficient: '足够',
  insufficient: '不足',
  exhausted: '用尽',
};

/** Tone class of a pool state label; the two usable levels keep the surface's muted tone. */
export function quotaPoolStateTone(state: QuotaPoolState): string | null {
  if (state === 'exhausted') return 'text-destructive';
  if (state === 'insufficient') return 'text-warning';
  return null;
}

/**
 * Copy for a provider whose quota read failed or went stale. While the last
 * measurement is inside the evidence grace and pools are still shown, the note
 * says how old the reused numbers are; after the grace — or without a usable
 * measurement — only the plain failure stands.
 */
export function quotaReadFailureNote(provider: QuotaProviderSnapshot, now: number): string {
  const reusable = provider.windows.length > 0 || provider.balances.length > 0;
  const lastSuccessAt = provider.lastSuccessAt;
  const age = typeof lastSuccessAt === 'number' && Number.isFinite(lastSuccessAt) && lastSuccessAt <= now
    ? now - lastSuccessAt
    : null;
  if (reusable && age !== null && age <= QUOTA_EVIDENCE_GRACE_MS) {
    return `读取失败，沿用 ${Math.max(1, Math.round(age / 60_000))} 分钟前的数据`;
  }
  return provider.message ? `读取失败 · ${provider.message}` : '读取失败';
}

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
    warn: delta < -QUOTA_PACE_WARN_DELTA,
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
  /** Display-only pool label; preferred over the raw window name when present. */
  poolLabel?: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
}

export interface QuotaVerdict {
  /** 充裕 / 足够 / 不足 / 用尽, the four-level pool state wording. */
  label: string;
  level: 'sufficient' | 'tight' | 'insufficient';
  /** Short muted reason, or undefined when every pool is normal. */
  reason: string | undefined;
}

/**
 * One-line verdict on whether to keep using the current model (usage spec 6.2),
 * in the four-level pool-state wording: `充裕` when every pool is normal and
 * not projected to run out before reset, `足够` on any warning pool or a fast
 * pace, `不足` on any destructive pool and `用尽` once it is empty. Reuses the
 * {@link quotaLevel} / {@link paceView} thresholds through
 * {@link quotaPoolLevel} — no new thresholds.
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
    return { label: QUOTA_POOL_STATE_LABEL.abundant, level: 'sufficient', reason: undefined };
  }
  const name = worst.window.poolLabel ?? worst.window.name;
  const exhausted = worst.window.remainingPct <= 0;
  return worst.level === 'destructive'
    ? {
      label: exhausted ? QUOTA_POOL_STATE_LABEL.exhausted : QUOTA_POOL_STATE_LABEL.insufficient,
      level: 'insufficient',
      reason: exhausted ? `${name} 已耗尽` : `${name} 将在重置前用尽`,
    }
    : { label: QUOTA_POOL_STATE_LABEL.sufficient, level: 'tight', reason: `${name} 将在重置前用尽` };
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
  /** Display-only pool label; preferred over the raw window name when present. */
  poolLabel?: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
  resetsAt?: string;
  /** Four-level pool state from the snapshot; rendered as its Chinese label. */
  state?: QuotaPoolState;
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
  /** Single-line row: truncated label, bar, remaining %, reset tooltip; extras on `title`. */
  compact?: boolean;
  className?: string;
}

/**
 * One quota window row in the compact Claude-App style: a single text line
 * (`5 小时 · 2 小时 14 分后重置 · 偏快` / `已用 32%`) over the 6px used-fill
 * bar with a 1px pace tick. A stale pool appends `· 数据过期` inline.
 */
export function QuotaBar({
  name,
  poolLabel,
  remainingPct,
  expectedRemainingPct,
  resetsAt,
  state,
  stale = false,
  now: injectedNow,
  surface = 'card',
  compact = false,
  className,
}: QuotaBarProps) {
  const minuteNow = useMinuteNow();
  const now = injectedNow ?? minuteNow;
  const inverse = surface === 'inverse';
  const bounded = Math.max(0, Math.min(100, Number.isFinite(remainingPct) ? remainingPct : 0));
  const label = poolLabel ?? name;
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
  // Without a measured remaining percentage there is nothing to draw: an
  // unmeasured quota must never be rendered as a floored `0%` and `已用 100%`.
  if (!Number.isFinite(remainingPct)) {
    return (
      <div
        className={cn('flex items-center gap-2 text-xs', stale && 'opacity-60', className)}
        data-slot="quota-bar"
        data-quota-usage="unknown"
      >
        <span className={cn('min-w-0 truncate', mutedClass)}>{label}</span>
        <span className="shrink-0">{unknownUsageNote()}</span>
      </div>
    );
  }
  const markerLeft = expectedRemainingPct !== null
    ? `${Math.max(0, Math.min(100, 100 - expectedRemainingPct))}%`
    : null;
  const usedLabel = `已用 ${Math.floor(used)}%`;
  // The projected four-level state replaces the ad-hoc exhaustion word so one
  // pool never carries two parallel wordings.
  const stateView = state === undefined
    ? null
    : { label: QUOTA_POOL_STATE_LABEL[state], tone: quotaPoolStateTone(state) ?? mutedClass };

  if (compact) {
    // Single-row layout: details that would wrap stay on the row title.
    const detailParts = [
      stateView !== null ? stateView.label : exhausted ? '已耗尽' : pace !== null ? `${pace.word}（${pace.label}）` : null,
      stale ? '数据过期' : null,
    ].filter((part): part is string => part !== null);
    return (
      <div
        className={cn('flex items-center gap-2 text-xs whitespace-nowrap', stale && 'opacity-60', className)}
        data-slot="quota-bar"
        title={detailParts.length > 0 ? detailParts.join(' · ') : undefined}
      >
        <span className={cn('max-w-24 min-w-0 truncate', mutedClass)}>{label}</span>
        <div className="relative flex h-1 min-w-6 flex-1 items-center">
          <ProgressPrimitive.Root
            value={used}
            aria-label={`${label} 已用 ${Math.floor(used)}%`}
            className="w-full"
          >
            <ProgressTrack className={cn('h-1 w-full rounded-full', inverse && 'bg-background/20')}>
              <ProgressIndicator className={fillClass} />
            </ProgressTrack>
          </ProgressPrimitive.Root>
          {markerLeft !== null && (
            <span
              data-slot="quota-pace-marker"
              className={cn(
                'pointer-events-none absolute top-0 h-1 w-px -translate-x-1/2 rounded-full',
                inverse ? 'bg-background' : 'bg-foreground',
              )}
              style={{ left: markerLeft }}
            />
          )}
        </div>
        <span className="shrink-0 tabular-nums">{Math.floor(bounded)}%</span>
        {reset !== null && (
          <Tooltip>
            <TooltipTrigger render={<span className={cn('shrink-0 cursor-default', mutedClass)}>{reset.label}</span>} />
            <TooltipContent>{reset.exact}</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', stale && 'opacity-60', className)} data-slot="quota-bar">
      {inverse ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={cn('flex min-w-0 items-center gap-1', mutedClass)}>
            <span className="truncate">{label}</span>
            {reset !== null && (
              <Tooltip>
                <TooltipTrigger render={<span className="shrink-0 cursor-default">· {reset.label}</span>} />
                <TooltipContent>{reset.exact}</TooltipContent>
              </Tooltip>
            )}
            {stateView !== null
              ? <span className={cn('shrink-0', stateView.tone)}>· {stateView.label}</span>
              : exhausted
                ? <span className="shrink-0 text-destructive">· 已耗尽</span>
                : pace !== null && <span className={cn('shrink-0', pace.warn && 'text-warning')}>· {pace.word}</span>}
            {stale && <span className="shrink-0 text-warning">· 数据过期</span>}
          </span>
          <span className="shrink-0 tabular-nums">{usedLabel}</span>
        </div>
      ) : (
        <div className="flex items-baseline justify-between gap-2 overflow-x-auto text-xs whitespace-nowrap">
          <span className={cn('inline-flex shrink-0 items-baseline gap-1 tabular-nums', mutedClass)}>
            <span>{label}</span>
            {reset !== null && (
              <Tooltip>
                <TooltipTrigger render={<span className="shrink-0 cursor-default">· {reset.label}</span>} />
                <TooltipContent>{reset.exact}</TooltipContent>
              </Tooltip>
            )}
            {stateView !== null
              ? <span className={cn('shrink-0', stateView.tone)}>· {stateView.label}</span>
              : exhausted
                ? <span className="shrink-0 text-destructive">· 已耗尽</span>
                : pace !== null && <span className={cn('shrink-0', pace.warn && 'text-warning')}>· {pace.word}</span>}
            {stale && <span className="shrink-0 text-warning">· 数据过期</span>}
          </span>
          <span className="shrink-0 tabular-nums">{usedLabel}</span>
        </div>
      )}
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
