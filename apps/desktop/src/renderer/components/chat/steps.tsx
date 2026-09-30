import { Children, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { StatusBadge } from '@/renderer/components/status-badge';
import { cn } from '@/renderer/lib/utils';

export interface StepsProps {
  children: ReactNode;
  className?: string;
}

/** Vertical step timeline; the last step hides its connector rail. */
export function Steps({ children, className }: StepsProps) {
  const items = Children.toArray(children);
  return (
    <div className={cn('flex flex-col', className)}>
      {items.map((child, index) => isValidElement(child)
        ? cloneElement(child as ReactElement<{ last?: boolean }>, { last: index === items.length - 1 })
        : child)}
    </div>
  );
}

export interface StepProps {
  title?: ReactNode;
  icon?: ReactNode;
  status?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  last?: boolean;
  children: ReactNode;
  className?: string;
}

/** One step: status icon in a rail on the left, content on the right. */
export function Step({ title, icon, status, collapsible = false, defaultOpen = true, last = false, children, className }: StepProps) {
  const [open, setOpen] = useState(defaultOpen);

  const rail = (
    <div className="flex flex-col items-center self-stretch">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
        {icon}
      </span>
      {!last && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
    </div>
  );

  const header = (
    <span className="flex items-center gap-2 text-sm font-medium">
      {title}
      {status && <StatusBadge status={status} />}
    </span>
  );

  return (
    <div className={cn('flex gap-3', className)}>
      {rail}
      <div className={cn('min-w-0 flex-1', !last && 'pb-5')}>
        {collapsible ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="flex w-full items-center gap-1 text-left">
              <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
              {header}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
          </Collapsible>
        ) : (
          <>
            {header}
            <div className="pt-2">{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
