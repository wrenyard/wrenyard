import type { ReactNode } from 'react';
import { Circle } from 'lucide-react';
import { ItemMedia } from '@/renderer/components/ui/item';
import { Separator } from '@/renderer/components/ui/separator';
import { cn } from 'cn';

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
        <ItemMedia variant="icon" className="text-muted-foreground">{icon ?? <Circle />}</ItemMedia>
        <Separator orientation="vertical" className="my-1 flex-1 group-last/step:hidden" />
      </div>
      <div className="mb-5 flex min-w-0 flex-1 flex-col gap-2 group-last/step:mb-0">
        {title !== undefined && <div className="flex items-center gap-2">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}
