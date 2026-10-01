import { useEffect, useState, type ReactNode } from 'react';
import { BrainCircuit, ChevronRight } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { cn } from 'cn';

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
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger render={<Button variant="ghost" />} className="w-full justify-start">
        <ChevronRight className={cn(open && 'rotate-90')} />
        <BrainCircuit />
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="text-muted-foreground">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
