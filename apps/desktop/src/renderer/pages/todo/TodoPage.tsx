import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import type { Todo } from '@/shell-contract';
import {
  Page,
  PageActions,
  PageContent,
  PageHeader,
  PageTitle,
} from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { Empty, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/renderer/components/ui/input-group';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useShellPage } from '@/renderer/lib/desktop';
import { useNavLocation } from '@/renderer/lib/navigation';
import {
  bodyExcerpt,
  countActiveTodos,
  groupActiveTodos,
  groupCompletedTodos,
  isActiveTodo,
  isCompletedTodo,
  PROJECTLESS_SECTION_LABEL,
  splitSearchTerms,
  todoMatches,
  todoMatchesSummary,
  useTodosQuery,
} from './queries';
import {
  readCollapsedSections,
  readCompletedOpen,
  TodoSection,
  writeCollapsedSections,
  writeCompletedOpen,
} from './components/TodoSection';
import { TodoRow } from './components/TodoRow';

/** Polled relative times refresh on this cadence while the page is active. */
const CLOCK_INTERVAL_MS = 60_000;

/** How long a row reached from a todo link stays highlighted. */
const FOCUS_HIGHLIGHT_MS = 1500;

/**
 * The read-only workspace todo page. It lists active todos in foldable project
 * sections and finished todos in one folded completed section; rows expand in
 * place to rendered Markdown notes. Search lives in the title bar and
 * temporarily overrides folding without changing the persisted states.
 */
export function TodoPage() {
  const page = useShellPage();
  const query = useTodosQuery();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(readCollapsedSections);
  const [completedOpen, setCompletedOpen] = useState<boolean>(readCompletedOpen);
  const [now, setNow] = useState(() => Date.now());
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ id: string } | null>(null);

  const terms = useMemo(() => splitSearchTerms(search), [search]);
  const searching = terms.length > 0;

  const todos = useMemo(() => query.data?.todos ?? [], [query.data]);
  const activeTodos = useMemo(() => todos.filter(isActiveTodo), [todos]);
  const completedTodos = useMemo(() => todos.filter(isCompletedTodo), [todos]);

  const activeSections = useMemo(() => {
    const source = searching ? activeTodos.filter((todo) => todoMatches(todo, terms)) : activeTodos;
    return groupActiveTodos(source);
  }, [activeTodos, searching, terms]);

  const matchedCompleted = useMemo(
    () => (searching ? completedTodos.filter((todo) => todoMatches(todo, terms)) : completedTodos),
    [completedTodos, searching, terms],
  );
  const completedGroups = useMemo(() => groupCompletedTodos(matchedCompleted, now), [matchedCompleted, now]);

  const matchCount = searching
    ? activeSections.reduce((total, section) => total + section.todos.length, 0) + matchedCompleted.length
    : 0;
  const counts = countActiveTodos(activeTodos);

  // A todo link navigates here with the id to reveal. The restore callback only
  // records the request; the effect below resolves it against the loaded list,
  // so arriving before the list resolves still lands on the row.
  useNavLocation({}, (restored) => {
    const todoId = restored.todo;
    if (todoId === undefined || todoId === '') return false;
    setFocusRequest(todoId);
    return true;
  });

  // Expand the requested row and its section (or the completed section), then
  // arm the scroll and the transient highlight.
  useEffect(() => {
    if (focusRequest === null) return;
    const todo = todos.find((item) => item.id === focusRequest);
    if (todo === undefined) {
      if (!query.isPending) setFocusRequest(null);
      return;
    }
    setSearch('');
    setExpandedRows((current) => {
      if (current.has(todo.id)) return current;
      const next = new Set(current);
      next.add(todo.id);
      return next;
    });
    if (isCompletedTodo(todo)) {
      setCompletedOpen(true);
      writeCompletedOpen(true);
    } else {
      const project = todo.project === undefined || todo.project === ''
        ? PROJECTLESS_SECTION_LABEL
        : todo.project;
      setCollapsedProjects((current) => {
        if (!current.has(project)) return current;
        const next = new Set(current);
        next.delete(project);
        writeCollapsedSections(next);
        return next;
      });
    }
    setHighlight({ id: todo.id });
    setPendingScroll(todo.id);
    setFocusRequest(null);
  }, [focusRequest, query.isPending, todos]);

  // Runs after the expansion commit, so the row is already mounted.
  useEffect(() => {
    if (pendingScroll === null) return;
    const element = document.getElementById(`todo-row-${pendingScroll}`);
    if (element === null) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setPendingScroll(null);
  }, [pendingScroll, collapsedProjects, completedOpen, expandedRows]);

  // The highlight is transient: remove it once the fade has run.
  useEffect(() => {
    if (highlight === null) return;
    const timer = window.setTimeout(() => setHighlight(null), FOCUS_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  // Relative timestamps stay fresh without re-rendering hidden pages: the
  // shell `Activity` boundary pauses this effect while another page is shown.
  useEffect(() => {
    if (page !== 'todo') return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [page]);

  // Cmd/Ctrl+F focuses this page's search only, and suppresses the browser's
  // find bar while the todo page is active.
  useEffect(() => {
    if (page !== 'todo') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page]);

  const onToggleRow = (todoId: string): void => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(todoId)) next.delete(todoId);
      else next.add(todoId);
      return next;
    });
  };

  const onToggleProject = (project: string, open: boolean): void => {
    if (searching) return;
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (open) next.delete(project);
      else next.add(project);
      writeCollapsedSections(next);
      return next;
    });
  };

  const onToggleCompleted = (open: boolean): void => {
    if (searching) return;
    setCompletedOpen(open);
    writeCompletedOpen(open);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (search !== '') setSearch('');
    else event.currentTarget.blur();
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('[data-todo-focusable]')) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-todo-focusable]'))
      .filter((element) => element.offsetParent !== null);
    const index = items.indexOf(target);
    if (index === -1) return;
    const next = event.key === 'ArrowDown' ? items[index + 1] : items[index - 1];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  const rows = (list: readonly Todo[]) =>
    list.map((todo) => (
      <TodoRow
        key={todo.id}
        todo={todo}
        expanded={expandedRows.has(todo.id)}
        onToggle={() => onToggleRow(todo.id)}
        now={now}
        searchTerms={terms}
        excerpt={searching && !todoMatchesSummary(todo, terms) ? bodyExcerpt(todo, terms) : null}
        completed={isCompletedTodo(todo)}
        highlighted={highlight?.id === todo.id}
      />
    ));

  const hasTodos = todos.length > 0;
  const loadedEmpty = !query.isPending && !query.isError && !hasTodos;
  const noMatches = searching && !query.isPending && !query.isError && hasTodos && matchCount === 0;

  return (
    <Page>
      <PageHeader>
        <PageTitle>待办</PageTitle>
        <PageActions>
          <InputGroup className="h-7 w-56 text-sm">
            <InputGroupAddon>
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              className="h-7 text-sm"
              value={search}
              placeholder="搜索待办"
              aria-label="搜索待办"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {search !== '' ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => setSearch('')}>
                  <X className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </PageActions>
      </PageHeader>
      <PageContent className="p-0 [&>div]:gap-0 [&>div]:p-0" onKeyDown={onListKeyDown}>
        <div className="mx-auto w-full max-w-[680px] px-6 py-6 @max-[560px]/main:px-3">
          {query.isError ? (
            <QueryError query={query} title="待办" />
          ) : query.isPending ? (
            <div>
              {Array.from({ length: 6 }, (_unused, index) => (
                <Skeleton key={index} className="mb-1 h-9 rounded-md" />
              ))}
            </div>
          ) : loadedEmpty ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无待办</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="mb-4 text-xs text-muted-foreground tabular-nums">
                {searching ? `${matchCount} 条匹配` : `进行中 ${counts.inProgress} · 未开始 ${counts.open}`}
              </div>
              {noMatches ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>没有匹配的待办</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  {activeSections.map((section, index) => (
                    <TodoSection
                      key={section.project}
                      label={section.project}
                      count={section.todos.length}
                      uppercase
                      open={searching || !collapsedProjects.has(section.project)}
                      onOpenChange={(open) => onToggleProject(section.project, open)}
                      className={index === 0 ? undefined : 'mt-6'}
                    >
                      {rows(section.todos)}
                    </TodoSection>
                  ))}
                  {searching && matchedCompleted.length === 0 ? null : (
                    <TodoSection
                      label="已完成"
                      count={matchedCompleted.length}
                      open={searching || completedOpen}
                      onOpenChange={onToggleCompleted}
                      className="mt-8"
                    >
                      {completedGroups.map((group) => (
                        <div key={group.key}>
                          <div className="mt-3 mb-1 px-2 text-[11px] text-muted-foreground">{group.label}</div>
                          {rows(group.todos)}
                        </div>
                      ))}
                    </TodoSection>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </PageContent>
    </Page>
  );
}
