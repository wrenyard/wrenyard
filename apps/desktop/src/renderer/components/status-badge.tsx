import { Badge } from '@/renderer/components/ui/badge';
import { Spinner } from '@/renderer/components/ui/spinner';
import { cn } from 'cn';

/** Visual tone of a status badge. Callers resolve it from a business status. */
export type StatusTone = 'running' | 'success' | 'danger' | 'warning' | 'muted';

const DOT_CLASS: Record<Exclude<StatusTone, 'running'>, string> = {
  success: 'bg-success',
  danger: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};

export interface StatusBadgeProps {
  tone: StatusTone;
  /** Rendered next to the icon; an empty label yields an icon-only badge. */
  label: string;
  className?: string;
}

/** Unified status icon and label; the caller supplies the resolved tone. */
export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn(className)}>
      {tone === 'running'
        ? <Spinner />
        : <span className={cn('size-2 rounded-full', DOT_CLASS[tone])} />}
      {label !== '' && label}
    </Badge>
  );
}
