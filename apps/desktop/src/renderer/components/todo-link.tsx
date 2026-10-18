import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Todo } from '@/shell-contract';
import { cn } from 'cn';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/renderer/components/ui/hover-card';
import { todoRequest } from '@/renderer/lib/desktop';
import { navigate } from '@/renderer/lib/navigation';
import { STATUS_META } from '@/renderer/pages/todo/components/TodoRow';
import {
  formatRelativeUpdated,
  TODO_LIST_QUERY_KEY,
  TODO_STATUS_LABEL,
} from '@/renderer/pages/todo/queries';

/** Characters of the todo request shown in the hover card. */
const REQUEST_EXCERPT_LENGTH = 160;

/**
 * The todo list read used by link rendering. It shares the todo page's query
 * key and cache, so a link never issues a duplicate read while the list is
 * fresh; unlike the page it never polls.
 */
function useTodoLinkTodos() {
  return useQuery({
    queryKey: TODO_LIST_QUERY_KEY,
    queryFn: () => todoRequest('todo.list'),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Ids of the todos in the current list result. Everything that is not in this
 * set is left as plain text by the Markdown linkifier.
 */
export function useTodoLinkIds(): ReadonlySet<string> {
  const query = useTodoLinkTodos();
  const todos = query.data?.todos;
  return useMemo(() => new Set((todos ?? []).map((todo) => todo.id)), [todos]);
}

/** One line of the request, truncated for the card. */
function requestExcerpt(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim();
  return flat.length > REQUEST_EXCERPT_LENGTH ? `${flat.slice(0, REQUEST_EXCERPT_LENGTH)}…` : flat;
}

function TodoLinkCard({ todo }: { todo: Todo }) {
  const meta = STATUS_META[todo.status];
  const excerpt = requestExcerpt(todo.request);
  const project = todo.project === undefined || todo.project === '' ? undefined : todo.project;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <meta.Icon className={cn('size-3.5 shrink-0', meta.tone)} aria-hidden="true" />
        <span>{TODO_STATUS_LABEL[todo.status]}</span>
      </div>
      <div className="font-medium line-clamp-2 break-words">{todo.title}</div>
      {project === undefined ? null : (
        <div className="text-xs text-muted-foreground">{project}</div>
      )}
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatRelativeUpdated(todo.updated, Date.now())}
      </div>
      {excerpt === '' ? null : (
        <div className="text-xs text-muted-foreground break-words">{excerpt}</div>
      )}
    </div>
  );
}

export interface TodoLinkProps {
  todoId: string;
  children?: ReactNode;
}

/**
 * An inline todo reference rendered as a link: the trigger opens the todo page
 * focused on this row, and hovering previews the current list entry. It is
 * read-only; neither the trigger nor the card can change the todo.
 */
export function TodoLink({ todoId, children }: TodoLinkProps) {
  const query = useTodoLinkTodos();
  const todo = query.data?.todos.find((item) => item.id === todoId);
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            className="text-primary cursor-pointer hover:underline"
          />
        }
        onClick={() => {
          void navigate('todo', { todo: todoId });
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent>
        {todo === undefined ? (
          <span className="font-mono text-xs text-muted-foreground">{todoId}</span>
        ) : (
          <TodoLinkCard todo={todo} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
