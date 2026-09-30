import { useEffect, useState, type ReactNode } from 'react';
import { BrainCircuit, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { cn } from '@/renderer/lib/utils';

export interface ReasoningProps {
  children: ReactNode;
  streaming?: boolean;
  defaultOpen?: boolean;
  title?: string;
  className?: string;
}

/**
 * Collapsible thinking block. Opens automatically while the stream is live and
 * folds once it ends, so completed turns stay compact.
 */
export function Reasoning({ children, streaming = false, defaultOpen, title = '思考过程', className }: ReasoningProps) {
  const [open, setOpen] = useState(defaultOpen ?? streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-md border border-border/60', className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <BrainCircuit className="size-3.5" />
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
