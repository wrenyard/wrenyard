import { cn } from 'cn';
import { formatClock } from '@/renderer/lib/format';

export interface HoverTimeProps {
  /** ISO stamp rendered as `HH:mm`. */
  value: string;
  className?: string;
}

/**
 * `HH:mm` chip that fades in when its message row is hovered or focused.
 * Deliberately tooltip-free: the full date lives in the title card.
 */
export function HoverTime({ value, className }: HoverTimeProps) {
  return (
    <time
      dateTime={value}
      className={cn(
        'self-end text-xs text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100',
        className,
      )}
    >
      {formatClock(value)}
    </time>
  );
}
