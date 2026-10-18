import { useQuery } from '@tanstack/react-query';
import type { Todo } from '@/shell-contract';
import { todoRequest, useShellPage } from '@/renderer/lib/desktop';

/** TanStack key for the one read-only todo list query. */
export const TODO_LIST_QUERY_KEY = ['todos', 'list'] as const;

/** Polling cadence while the todo page is the visible shell page. */
const TODO_POLL_INTERVAL_MS = 30_000;

/**
 * The workspace todo list. It is read-only and cached for ten seconds, and it
 * polls only while the todo page is active: hidden pages are paused by the
 * shell `Activity` boundary, so the interval resumes with the page.
 */
export function useTodosQuery() {
  const page = useShellPage();
  return useQuery({
    queryKey: TODO_LIST_QUERY_KEY,
    queryFn: () => todoRequest('todo.list'),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: page === 'todo' ? TODO_POLL_INTERVAL_MS : false,
  });
}

/** Statuses shown in the project sections. */
export const ACTIVE_TODO_STATUSES = ['open', 'in_progress'] as const;
/** Statuses shown in the bottom completed section. */
export const COMPLETED_TODO_STATUSES = ['done', 'accepted', 'cancelled'] as const;

/** Whether a todo belongs in the active project sections. */
export function isActiveTodo(todo: Todo): boolean {
  return (ACTIVE_TODO_STATUSES as readonly string[]).includes(todo.status);
}

/** Whether a todo belongs in the completed section. */
export function isCompletedTodo(todo: Todo): boolean {
  return (COMPLETED_TODO_STATUSES as readonly string[]).includes(todo.status);
}

/** Section title used for todos without a project. */
export const PROJECTLESS_SECTION_LABEL = '未分项目';

/** Chinese status names used by rows and details. */
export const TODO_STATUS_LABEL: Record<Todo['status'], string> = {
  open: '未开始',
  in_progress: '进行中',
  done: '已完成',
  accepted: '已验收',
  cancelled: '已取消',
};

export interface ActiveTodoSection {
  project: string;
  todos: Todo[];
}

/** Local calendar-day start, in milliseconds. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** `YYYY-MM-DD` in the local timezone; invalid input yields an empty key. */
export function localDateKey(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Active todos grouped by project: project ids ascending, the project-less
 * group last, in-progress first and newest update first inside each group.
 */
export function groupActiveTodos(todos: readonly Todo[]): ActiveTodoSection[] {
  const groups = new Map<string, Todo[]>();
  for (const todo of todos) {
    const project = todo.project === undefined || todo.project === '' ? PROJECTLESS_SECTION_LABEL : todo.project;
    const group = groups.get(project);
    if (group === undefined) groups.set(project, [todo]);
    else group.push(todo);
  }
  const rank = (todo: Todo): number => (todo.status === 'in_progress' ? 0 : 1);
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === PROJECTLESS_SECTION_LABEL) return 1;
      if (right === PROJECTLESS_SECTION_LABEL) return -1;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([project, group]) => ({
      project,
      todos: group.sort((left, right) => {
        const byRank = rank(left) - rank(right);
        if (byRank !== 0) return byRank;
        return Date.parse(right.updated) - Date.parse(left.updated);
      }),
    }));
}

export interface CompletedTodoGroup {
  /** Local date key (`YYYY-MM-DD`), used only as a stable group identity. */
  key: string;
  label: string;
  todos: Todo[];
}

function completedDateLabel(key: string, now: number): string {
  if (key === '') return '—';
  if (key === localDateKey(now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(yesterday)) return '昨天';
  const [year, month, day] = key.split('-');
  if (year === undefined || month === undefined || day === undefined) return key;
  return `${Number(month)}月${Number(day)}日`;
}

/** Completed todos grouped by updated local date, newest group first. */
export function groupCompletedTodos(todos: readonly Todo[], now: number): CompletedTodoGroup[] {
  const groups = new Map<string, Todo[]>();
  const sorted = [...todos].sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated));
  for (const todo of sorted) {
    const key = localDateKey(todo.updated);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [todo]);
    else group.push(todo);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .map(([key, group]) => ({ key, label: completedDateLabel(key, now), todos: group }));
}

/** Trimmed, case-insensitive search terms; an empty query has no terms. */
export function splitSearchTerms(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return [];
  return trimmed.split(/\s+/).filter((term) => term !== '');
}

/** Whether every term matches somewhere in the summary fields (id/title/project). */
export function todoMatchesSummary(todo: Todo, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  return terms.every((term) =>
    [todo.id, todo.title, todo.project ?? ''].some((value) => value.toLowerCase().includes(term)));
}

/**
 * Whether every term matches at least one searchable field. Matching is a
 * literal, case-insensitive substring test, which also works for CJK text.
 */
export function todoMatches(todo: Todo, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const summary = [todo.id, todo.title, todo.project ?? ''];
  const body = [todo.request, todo.acceptance, todo.resultSummary ?? ''];
  return terms.every((term) => {
    const haystack = [...summary, ...body].map((value) => value.toLowerCase());
    return haystack.some((value) => value.includes(term));
  });
}

/** Active counters shown in the summary line. */
export function countActiveTodos(todos: readonly Todo[]): { inProgress: number; open: number } {
  let inProgress = 0;
  let open = 0;
  for (const todo of todos) {
    if (todo.status === 'in_progress') inProgress += 1;
    else if (todo.status === 'open') open += 1;
  }
  return { inProgress, open };
}

/**
 * Relative update time: `刚刚`, `N 分钟前`, `N 小时前`, `昨天`, `N 天前`, then
 * `M月D日` with the year only when it is not the current year.
 */
export function formatRelativeUpdated(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (days <= 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestamp);
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Split text into plain and matched segments for safe literal highlighting.
 * Terms are matched case-insensitively; longer terms win at the same position
 * so overlapping terms never produce a nested mark.
 */
export function highlightSegments(text: string, terms: readonly string[]): TextSegment[] {
  const needles = terms
    .map((term) => term.toLowerCase())
    .filter((term) => term !== '')
    .sort((left, right) => right.length - left.length);
  if (needles.length === 0 || text === '') return [{ text, match: false }];
  const lowered = text.toLowerCase();
  const segments: TextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let bestIndex = -1;
    let bestTerm = '';
    for (const term of needles) {
      const index = lowered.indexOf(term, cursor);
      if (index === -1) continue;
      if (bestIndex === -1 || index < bestIndex || (index === bestIndex && term.length > bestTerm.length)) {
        bestIndex = index;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (bestIndex > cursor) segments.push({ text: text.slice(cursor, bestIndex), match: false });
    segments.push({ text: text.slice(bestIndex, bestIndex + bestTerm.length), match: true });
    cursor = bestIndex + bestTerm.length;
  }
  return segments.length === 0 ? [{ text, match: false }] : segments;
}

/**
 * A one-line excerpt centred on the first body match, about 60 characters
 * wide. Returns null when no body field matches.
 */
export function bodyExcerpt(todo: Todo, terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  const body = [todo.request, todo.acceptance, todo.resultSummary ?? '']
    .filter((value) => value !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (body === '') return null;
  const lowered = body.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lowered.indexOf(term.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) return null;
  const start = Math.max(0, index - 30);
  const end = Math.min(body.length, start + 60);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}
