import { Check, CircleAlert, CircleSlash, X } from 'lucide-react';
import { Spinner } from '@/renderer/components/ui/spinner';
import { cn } from '@/renderer/lib/utils';

/** Visual tone of a status badge. Callers resolve it from a business status. */
export type StatusTone = 'running' | 'success' | 'danger' | 'warning' | 'muted';

const TONE_CLASS: Record<StatusTone, string> = {
  running: 'text-primary',
  success: 'text-[var(--moss-deep)]',
  danger: 'text-destructive',
  warning: 'text-[var(--lamp-deep)]',
  muted: 'text-muted-foreground',
};

function StatusIcon({ tone }: { tone: StatusTone }) {
  if (tone === 'running') return <Spinner className="size-3.5" />;
  if (tone === 'success') return <Check className="size-3.5" />;
  if (tone === 'danger') return <X className="size-3.5" />;
  if (tone === 'warning') return <CircleAlert className="size-3.5" />;
  return <CircleSlash className="size-3.5" />;
}

export interface StatusBadgeProps {
  tone: StatusTone;
  /** Rendered next to the icon; an empty label yields an icon-only badge. */
  label: string;
  className?: string;
}

/** Unified status icon and label; the caller supplies the resolved tone. */
export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_CLASS[tone], className)}>
      <StatusIcon tone={tone} />
      {label !== '' && label}
    </span>
  );
}
