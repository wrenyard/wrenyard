import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';

/** Persisted project ids of folded active sections. */
const COLLAPSED_SECTIONS_KEY = 'wrenyard.todo.collapsedSections';
/** Persisted open state of the completed section. */
const COMPLETED_OPEN_KEY = 'wrenyard.todo.completedOpen';

/** Stored folded project ids; any unavailable or malformed value yields none. */
export function readCollapsedSections(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsedSections(projects: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...projects]));
  } catch {
    // Storage may be unavailable; folding then simply does not persist.
  }
}

/** The completed section is folded unless storage explicitly says it is open. */
export function readCompletedOpen(): boolean {
  try {
    return localStorage.getItem(COMPLETED_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeCompletedOpen(open: boolean): void {
  try {
    localStorage.setItem(COMPLETED_OPEN_KEY, open ? 'true' : 'false');
  } catch {
    // Storage may be unavailable; the section still folds for this session.
  }
}

export interface TodoSectionProps {
  label: string;
  count: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Changes the label casing; project sections are upper case. */
  uppercase?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * One controlled fold section: a real header button with a rotating chevron,
 * the label and the row count. Rows follow directly with no gap.
 */
export function TodoSection({
  label,
  count,
  open,
  onOpenChange,
  uppercase = false,
  className,
  children,
}: TodoSectionProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            data-todo-focusable
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-medium tracking-wide text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <span className={cn(uppercase && 'uppercase')}>{label}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
