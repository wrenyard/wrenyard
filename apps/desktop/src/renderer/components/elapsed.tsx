import { useNow } from '@/renderer/hooks/use-now';
import { elapsedBetween, formatElapsedMs } from '@/renderer/lib/format';

function RunningElapsed({ start, className }: { start: string; className?: string }) {
  const now = useNow();
  return <span className={className}>{formatElapsedMs(elapsedBetween(start, undefined, now))}</span>;
}

export interface ElapsedProps {
  start: string;
  end?: string;
  className?: string;
}

/**
 * Elapsed time between two stamps. Only a running span subscribes to the
 * shared clock; a finished span renders once from its fixed end time.
 */
export function Elapsed({ start, end, className }: ElapsedProps) {
  if (end === undefined) return <RunningElapsed start={start} className={className} />;
  return <span className={className}>{formatElapsedMs(elapsedBetween(start, end, 0))}</span>;
}
