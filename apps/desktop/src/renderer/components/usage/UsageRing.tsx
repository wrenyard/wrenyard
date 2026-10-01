import { Spinner } from '@/renderer/components/ui/spinner';
import { cn } from 'cn';

/**
 * The context-usage ring shown in the composer toolbar (usage spec 4). It only
 * receives the ratio and a coarse status; the caller owns the tooltip, the
 * popover and the send-blocking decision.
 *
 * A 16px SVG with a 2.5px stroke: the base ring is `--muted-foreground` at 30%
 * opacity so the full track stays visible, the progress arc starts at 12
 * o'clock with round caps and grows clockwise. An unknown window renders a
 * dashed base ring with no arc, and the first load shows a spinner.
 */

export type UsageRingStatus = 'loading' | 'unknown' | 'ready';
export type UsageRingLevel = 'normal' | 'warning' | 'destructive';

/** Fill colour for a ratio at the 70% / 90% thresholds (usage spec 4). */
export function usageRingLevel(ratio: number): UsageRingLevel {
  if (ratio >= 0.9) return 'destructive';
  if (ratio >= 0.7) return 'warning';
  return 'normal';
}

const ARC_CLASS: Record<UsageRingLevel, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const DOT_CLASS: Record<Exclude<UsageRingLevel, 'normal'>, string> = {
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface UsageRingProps {
  /** Used / available ratio; values above 1 render a full ring. */
  ratio?: number;
  status?: UsageRingStatus;
  /** Quota alert dot colour when the current provider has a window in alert. */
  quotaAlert?: Exclude<UsageRingLevel, 'normal'>;
  className?: string;
}

export function UsageRing({ ratio, status = 'ready', quotaAlert, className }: UsageRingProps) {
  const dot = quotaAlert === undefined ? null : (
    <span
      data-slot="usage-ring-quota-dot"
      className={cn('absolute -top-0.5 -right-0.5 size-1.5 rounded-full', DOT_CLASS[quotaAlert])}
    />
  );

  if (status === 'loading') {
    return (
      <span className={cn('relative inline-flex size-4 items-center justify-center', className)}>
        <Spinner className="size-4" />
        {dot}
      </span>
    );
  }

  if (status === 'unknown') {
    return (
      <span className={cn('relative inline-flex size-4 items-center justify-center', className)}>
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <circle
            cx={8}
            cy={8}
            r={RADIUS}
            fill="none"
            strokeWidth={2}
            strokeDasharray="2 2"
            className="stroke-muted"
          />
        </svg>
        {dot}
      </span>
    );
  }

  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio ?? 0) ? ratio! : 0));
  const level = usageRingLevel(clamped);
  // A non-zero share renders at least a 3% arc so it is distinguishable from an
  // empty track (a bare round cap would otherwise read like a loading spinner).
  const share = clamped > 0 ? Math.max(clamped, 0.03) : 0;
  return (
    <span className={cn('relative inline-flex size-4 items-center justify-center', className)}>
      <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
        <circle
          cx={8}
          cy={8}
          r={RADIUS}
          fill="none"
          strokeWidth={2.5}
          className="stroke-muted-foreground/30"
        />
        <circle
          cx={8}
          cy={8}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - share)}
          transform="rotate(-90 8 8)"
          className={cn(ARC_CLASS[level], 'transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none')}
        />
      </svg>
      {dot}
    </span>
  );
}
