import { useCallback } from 'react';
import type { Todo } from '@/shell-contract';
import { Markdown } from '@/renderer/components/markdown';
import { shell } from '@/renderer/lib/desktop';
import { formatDateTime } from '@/renderer/lib/format';
import { useAppearance } from '@/renderer/lib/theme';
import { formatRelativeUpdated, TODO_STATUS_LABEL } from '../queries';

export interface TodoDetailProps {
  todo: Todo;
  /** Id of the row button this region is labelled by. */
  rowId: string;
  now: number;
}

/**
 * Expanded notes: a metadata line, the request as the unlabelled body, then
 * the optional acceptance and delivery summary. Everything renders as the
 * stored Markdown; the page, not the panel, owns scrolling.
 */
export function TodoDetail({ todo, rowId, now }: TodoDetailProps) {
  const appearance = useAppearance();
  const openExternal = useCallback((href: string) => {
    void shell.openExternal(href);
  }, []);
  const hasRequest = todo.request !== '';
  const hasAcceptance = todo.acceptance !== '';
  const hasResult = todo.resultSummary !== undefined && todo.resultSummary !== '';
  const hasDependencies = todo.depends_on.length > 0;

  return (
    <section
      role="region"
      aria-labelledby={rowId}
      className="ml-9 mb-2 mt-1 rounded-lg border bg-card px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{todo.id}</span>
        <span>{TODO_STATUS_LABEL[todo.status]}</span>
        <span>创建 {formatDateTime(todo.created)}</span>
        <span>更新 {formatRelativeUpdated(todo.updated, now)}</span>
        {hasDependencies ? (
          <span>
            依赖{' '}
            <span className="font-mono">{todo.depends_on.join(', ')}</span>
          </span>
        ) : null}
      </div>
      {hasRequest ? (
        <div className="mt-2">
          <Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">
            {todo.request}
          </Markdown>
        </div>
      ) : null}
      {hasAcceptance ? (
        <div>
          <div className="mt-4 mb-1 text-xs font-medium text-muted-foreground">验收标准</div>
          <Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">
            {todo.acceptance}
          </Markdown>
        </div>
      ) : null}
      {hasResult ? (
        <div>
          <div className="mt-4 mb-1 text-xs font-medium text-muted-foreground">交付摘要</div>
          <Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">
            {todo.resultSummary ?? ''}
          </Markdown>
        </div>
      ) : null}
      {!hasRequest && !hasAcceptance && !hasResult ? (
        <div className="mt-2 text-muted-foreground">无备注</div>
      ) : null}
    </section>
  );
}
