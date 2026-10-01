import { cn } from 'cn';

/**
 * Segmented context bar for the usage panel (usage spec 5.1): the full width is
 * the model context window, the left solid part is the current usage split by
 * composition group, the hatched right part is the reserved output allowance,
 * and the middle is free space. Used sparingly: it is a pure metric, not an
 * interactive progress control.
 */

export interface TokenBarSegment {
  id: string;
  label: string;
  tokens: number;
  /** CSS colour, e.g. `var(--chart-1)`. */
  color: string;
}

export interface TokenBarProps {
  segments: readonly TokenBarSegment[];
  /** Full window; falls back to the used total plus the reserve when unknown. */
  window?: number;
  /** Reserved output allowance drawn as a hatched segment at the right. */
  reserved?: number;
  className?: string;
}

export function TokenBar({ segments, window, reserved = 0, className }: TokenBarProps) {
  const used = segments.reduce((sum, segment) => sum + Math.max(0, segment.tokens), 0);
  const reserve = Math.max(0, reserved);
  const denominator = window !== undefined && window > 0 ? window : used + reserve;

  if (denominator <= 0) {
    return <div className={cn('h-1.5 w-full rounded-full bg-muted', className)} data-slot="token-bar" />;
  }

  return (
    <div
      data-slot="token-bar"
      className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      {segments
        .filter((segment) => segment.tokens > 0)
        .map((segment) => (
          <span
            key={segment.id}
            data-slot="token-bar-segment"
            title={segment.label}
            className="h-full shrink-0"
            style={{ width: `${(segment.tokens / denominator) * 100}%`, backgroundColor: segment.color }}
          />
        ))}
      <span className="h-full flex-1" style={{ minWidth: 0 }} />
      {reserve > 0 && (
        <span
          data-slot="token-bar-reserve"
          className="h-full shrink-0 bg-muted-foreground/25"
          style={{
            width: `${(Math.min(reserve, denominator) / denominator) * 100}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, var(--muted-foreground) 0 1px, transparent 1px 4px)',
          }}
        />
      )}
    </div>
  );
}
