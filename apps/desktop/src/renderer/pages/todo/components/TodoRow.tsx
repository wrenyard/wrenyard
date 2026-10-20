import { Fragment, type KeyboardEvent } from 'react';
import { Circle, CircleCheck, CircleDot, CircleSlash } from 'lucide-react';
import type { Todo } from '@/shell-contract';
import { cn } from 'cn';
import { Collapsible, CollapsibleContent } from '@/renderer/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatDateTime } from '@/renderer/lib/format';
import {
  formatRelativeUpdated,
  highlightSegments,
  TODO_STATUS_LABEL,
  type TextSegment,
} from '../queries';
import { TodoDetail } from './TodoDetail';

export interface StatusMeta {
  Icon: typeof Circle;
  tone: string;
}

/** Status icon and colour, shared with inline todo links. */
export const STATUS_META: Record<Todo['status'], StatusMeta> = {
  open: { Icon: Circle, tone: 'text-muted-foreground' },
  in_progress: { Icon: CircleDot, tone: 'text-primary' },
  done: { Icon: CircleCheck, tone: 'text-muted-foreground' },
  cancelled: { Icon: CircleSlash, tone: 'text-muted-foreground' },
};

/** Render literal search matches with a safe `<mark>`. */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  const segments: TextSegment[] = highlightSegments(text, terms);
  return (
    <>
      {segments.map((segment, index) => (
        segment.match ? (
          <mark key={index} className="rounded-sm bg-primary/15 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        )
      ))}
    </>
  );
}

export interface TodoRowProps {
  todo: Todo;
  expanded: boolean;
  onToggle(): void;
  now: number;
  /** Search terms used for title and excerpt highlighting. */
  searchTerms: readonly string[];
  /** Body-only match excerpt shown under the title while searching. */
  excerpt: string | null;
  /** Completed rows add the project prefix and muted title styling. */
  completed?: boolean;
  /** Transient focus highlight applied after navigating from a todo link. */
  highlighted?: boolean;
}

/**
 * One todo row: a real toggle button with the decorative status icon, the
 * title and the id/relative-time pair. The details render directly below.
 */
export function TodoRow({
  todo,
  expanded,
  onToggle,
  now,
  searchTerms,
  excerpt,
  completed = false,
  highlighted = false,
}: TodoRowProps) {
  const meta = STATUS_META[todo.status];
  const statusLabel = TODO_STATUS_LABEL[todo.status];
  const rowId = `todo-row-${todo.id}`;
  const detailId = `todo-detail-${todo.id}`;
  const titleTone = completed
    ? todo.status === 'cancelled'
      ? 'text-muted-foreground line-through'
      : 'text-muted-foreground'
    : 'text-foreground';

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <Collapsible open={expanded}>
      <button
        type="button"
        id={rowId}
        data-todo-focusable
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        className={cn(
          'group flex min-h-9 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          expanded && 'bg-muted/40',
          highlighted && 'bg-primary/10 transition-colors duration-[1500ms]',
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={statusLabel}
                tabIndex={-1}
                className="flex size-4 shrink-0 items-center justify-center"
              />
            }
          >
            <meta.Icon className={cn('size-4', meta.tone)} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{statusLabel}</TooltipContent>
        </Tooltip>
        {completed && todo.project !== undefined && todo.project !== '' ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{todo.project}</span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block text-sm',
              titleTone,
              expanded ? 'whitespace-normal' : 'truncate',
            )}
          >
            <Highlighted text={todo.title} terms={searchTerms} />
          </span>
          {excerpt === null ? null : (
            <span className="block truncate text-xs text-muted-foreground">
              <Highlighted text={excerpt} terms={searchTerms} />
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <span className="font-mono text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
            {todo.id}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={-1}
                  className="w-16 text-right text-xs tabular-nums text-muted-foreground"
                />
              }
            >
              {formatRelativeUpdated(todo.updated, now)}
            </TooltipTrigger>
            <TooltipContent>{formatDateTime(todo.updated)}</TooltipContent>
          </Tooltip>
        </span>
      </button>
      <CollapsibleContent
        id={detailId}
        className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0"
      >
        <TodoDetail todo={todo} rowId={rowId} now={now} />
      </CollapsibleContent>
    </Collapsible>
  );
}
