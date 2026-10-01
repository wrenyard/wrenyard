import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatClock, formatClockSeconds, formatDateTime } from '@/renderer/lib/format';
import { cn } from 'cn';

export interface TimestampProps {
  /** An ISO date-time string. */
  value: string;
  /** `minute` renders `HH:mm`; `second` renders `HH:mm:ss`. */
  precision?: 'minute' | 'second';
  className?: string;
}

/**
 * Local time stamp with the full local date-time in a tooltip. Invalid input
 * renders the shared em dash instead of an ISO string.
 */
export function Timestamp({ value, precision = 'minute', className }: TimestampProps) {
  const text = precision === 'second' ? formatClockSeconds(value) : formatClock(value);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('tabular-nums', className)} />}>{text}</TooltipTrigger>
      <TooltipContent>{formatDateTime(value)}</TooltipContent>
    </Tooltip>
  );
}
