import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Skeleton } from '@/renderer/components/ui/skeleton';

export interface UsageCardProps {
  id: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function UsageCard({ id, title, children, actions, footer, defaultOpen = true, className }: UsageCardProps) {
  const key = `wrenyard.usage-card.${id}`;
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'open') setOpen(true);
      else if (stored === 'closed') setOpen(false);
    } catch { /* Storage may be unavailable. */ }
  }, [key]);

  const toggle = () => setOpen((current) => {
    const next = !current;
    try { window.localStorage.setItem(key, next ? 'open' : 'closed'); } catch { /* Storage may be unavailable. */ }
    return next;
  });

  return (
    <section className={cn('flex flex-col rounded-xl border bg-card px-4 py-2.5', className)} data-slot="usage-card">
      <div className="flex h-7 items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium" aria-expanded={open} onClick={toggle}>
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast', !open && '-rotate-90')} aria-hidden="true" />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div className="flex flex-col gap-1.5">{children}</div>}
      {open && footer !== undefined && <div className="mt-2 flex items-center justify-between gap-2">{footer}</div>}
    </section>
  );
}

export function UsageCardSkeletonBody() {
  return (
    <div className="flex flex-col gap-1.5" data-slot="usage-card-skeleton">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  );
}

export interface LegendRowProps {
  label: ReactNode;
  value?: ReactNode;
  percent?: ReactNode;
  swatch?: string;
  muted?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
  title?: string;
}

export function LegendRow({ label, value, percent, swatch, muted = false, expandable = false, expanded = false, onToggle, children, title }: LegendRowProps) {
  const content = (
    <>
      {expandable ? <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true" /> : <span className="size-2.5 shrink-0 rounded-[3px]" style={swatch === undefined ? undefined : { backgroundColor: swatch }} />}
      <span className="min-w-0 flex-1 truncate" title={title}>{label}</span>
      {value !== undefined && <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{value}</span>}
      {percent !== undefined && <span className="w-14 shrink-0 text-right tabular-nums">{percent}</span>}
    </>
  );
  return (
    <div className={cn('text-sm', muted && 'text-muted-foreground')}>
      {expandable ? <button type="button" className="flex h-6 w-full items-center gap-2 text-left" aria-expanded={expanded} onClick={onToggle}>{content}</button> : <div className="flex h-6 items-center gap-2">{content}</div>}
      {expandable && expanded && children !== undefined && <div className="pl-6">{children}</div>}
    </div>
  );
}
