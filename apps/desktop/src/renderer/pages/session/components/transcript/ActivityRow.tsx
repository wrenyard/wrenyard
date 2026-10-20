/**
 * Generic expandable step row of the agent transcript: a verb, a subject, an
 * optional meta line, a status slot and a chevron over the step's details.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Spinner } from '@/renderer/components/ui/spinner';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/renderer/components/ui/collapsible';

/** Terminal or live state of one step. */
export function ActivityRowStatus({ running, failed, cancelled }: { running?: boolean; failed?: boolean; cancelled?: boolean }) {
  if (running === true) return <Spinner className="size-3 shrink-0" />;
  if (failed === true) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-destructive">
        <span className="size-1.5 rounded-full bg-destructive" />
        失败
      </span>
    );
  }
  if (cancelled === true) return <span className="shrink-0 text-xs text-muted-foreground">已取消</span>;
  return null;
}

/** Scrollable monospace box for a step's output or code. */
export function OutputBox({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border bg-background/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

export interface ActivityRowProps {
  /** Short action word before the subject. */
  verb: string;
  /** The row's main line. */
  subject: ReactNode;
  /** Right-aligned metadata shown while collapsed. */
  meta?: ReactNode;
  /** Right-aligned metadata shown while expanded. */
  openMeta?: ReactNode;
  /** Status slot rendered after the metadata. */
  status?: ReactNode;
  /** The row's detail content. */
  children: ReactNode;
  /** Tighter spacing for rows nested inside an action. */
  compact?: boolean;
  /** Force the row open while true; it never closes it again. */
  openWhile?: boolean;
}

/** One expandable step row. */
export function ActivityRow({
  verb,
  subject,
  meta,
  openMeta,
  status,
  children,
  compact = false,
  openWhile = false,
}: ActivityRowProps) {
  const [open, setOpen] = useState(false);
  const headerId = useId();
  useEffect(() => {
    if (openWhile) setOpen(true);
  }, [openWhile]);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={(
          <button
            type="button"
            id={headerId}
            className={cn(
              'flex w-full items-center gap-2 text-left text-sm hover:bg-muted/40',
              compact ? 'px-2 py-1.5' : 'px-3 py-2',
            )}
          />
        )}
      >
        <span className="shrink-0 text-muted-foreground">{verb}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{subject}</span>
        <span className="inline-flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {open && openMeta !== undefined ? openMeta : meta}
        </span>
        {status}
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent
        role="region"
        aria-labelledby={headerId}
        className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-fast data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0"
      >
        <div className={cn('flex flex-col gap-2 text-sm', compact ? 'px-2 pb-2 pt-1' : 'px-3 pb-3 pt-1')}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
