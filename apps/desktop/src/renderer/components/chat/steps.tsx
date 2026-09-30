import type { ReactNode } from 'react';
import { cn } from '@/renderer/lib/utils';

export interface StepsProps {
  children: ReactNode;
  className?: string;
}

/** Vertical step timeline; the connector rail is hidden on the last step. */
export function Steps({ children, className }: StepsProps) {
  return <div className={cn('flex flex-col', className)}>{children}</div>;
}

export interface StepProps {
  title?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** One step: icon in a rail on the left, always-visible content on the right. */
export function Step({ title, icon, children, className }: StepProps) {
  return (
    <div className={cn('group/step flex gap-3', className)}>
      <div className="flex flex-col items-center self-stretch">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
          {icon}
        </span>
        <span className="mt-1 w-px flex-1 bg-border group-last/step:hidden" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 pb-5 group-last/step:pb-0">
        {title !== undefined && <span className="flex items-center gap-2 text-sm font-medium">{title}</span>}
        <div className="pt-2">{children}</div>
      </div>
    </div>
  );
}
