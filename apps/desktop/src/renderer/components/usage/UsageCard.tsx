import { useState, type ComponentProps, type ReactNode } from 'react';
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
  const [open, setOpen] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'open') return true;
      if (stored === 'closed') return false;
    } catch { /* Storage may be unavailable. */ }
    return defaultOpen;
  });

  const toggle = () => setOpen((current) => {
    const next = !current;
    try { window.localStorage.setItem(key, next ? 'open' : 'closed'); } catch { /* Storage may be unavailable. */ }
    return next;
  });

  return (
    <section className={cn('flex flex-col rounded-xl border bg-card px-4 py-2.5', className)} data-slot="usage-card">
      <div className="flex h-7 items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium" aria-expanded={open} onClick={toggle}>
          <span className="truncate">{title}</span>
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast', !open && '-rotate-90')} aria-hidden="true" />
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

/** Shared four-column grid (icon · title · value · trailing) for a card's legend rows. */
export function LegendList({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('grid grid-cols-[--spacing(3.5)_minmax(0,1fr)_auto_auto] gap-x-2', className)} {...rest} />;
}

/** Spacer row between the legend section and the expandable section. */
export function LegendGap() {
  return <div className="col-span-full h-2" aria-hidden="true" />;
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
  className?: string;
}

export function LegendRow({ label, value, percent, swatch, muted = false, expandable = false, expanded = false, onToggle, children, title, className }: LegendRowProps) {
  const rowClassName = cn('col-span-full grid grid-cols-subgrid h-6 items-center text-sm', muted && 'text-muted-foreground', className);
  const content = (
    <>
      <span className="flex size-3.5 items-center justify-center">
        {expandable
          ? <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
          : swatch !== undefined && <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: swatch }} />}
      </span>
      <span className="min-w-0 truncate" title={title}>{label}</span>
      {value !== undefined ? <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{value}</span> : <span />}
      {percent !== undefined ? <span className="overflow-hidden whitespace-nowrap text-right tabular-nums">{percent}</span> : <span />}
    </>
  );
  return (
    <>
      {expandable
        ? <button type="button" className={cn(rowClassName, 'text-left')} aria-expanded={expanded} onClick={onToggle}>{content}</button>
        : <div className={rowClassName}>{content}</div>}
      {expandable && expanded ? children : null}
    </>
  );
}
