import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Todo, TodoUpdateInput } from '@/shell-contract';
import { Markdown } from '@/renderer/components/markdown';
import { shell, todoRequest } from '@/renderer/lib/desktop';
import { formatDateTime } from '@/renderer/lib/format';
import { useAppearance } from '@/renderer/lib/theme';
import { formatRelativeUpdated, TODO_LIST_QUERY_KEY, TODO_STATUS_LABEL } from '../queries';

export interface TodoDetailProps {
  todo: Todo;
  /** Id of the row button this region is labelled by. */
  rowId: string;
  now: number;
}

/** Expanded todo details, comment timeline, and user-owned todo controls. */
export function TodoDetail({ todo, rowId, now }: TodoDetailProps) {
  const appearance = useAppearance();
  const queryClient = useQueryClient();
  const openExternal = useCallback((href: string) => { void shell.openExternal(href); }, []);
  const [comment, setComment] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [request, setRequest] = useState(todo.request);
  const [acceptance, setAcceptance] = useState(todo.acceptance);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const hasRequest = todo.request !== '';
  const hasAcceptance = todo.acceptance !== '';
  const hasDependencies = todo.depends_on.length > 0;
  const comments = [...todo.comments].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  const refresh = async () => queryClient.invalidateQueries({ queryKey: TODO_LIST_QUERY_KEY });
  const run = async (method: 'todo.update' | 'todo.tag' | 'todo.untag' | 'todo.comment' | 'todo.uncomment', params: object): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await todoRequest(method, params as never);
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDescription = async () => {
    const params: TodoUpdateInput = { id: todo.id };
    if (title !== todo.title) { params.old_title = todo.title; params.title = title; }
    if (request !== todo.request) { params.old_request = todo.request; params.request = request; }
    if (acceptance !== todo.acceptance) { params.old_acceptance = todo.acceptance; params.acceptance = acceptance; }
    if (params.title === undefined && params.request === undefined && params.acceptance === undefined) {
      setEditing(false);
      return;
    }
    await run('todo.update', params);
    setEditing(false);
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    if (await run('todo.comment', { id: todo.id, text: comment })) setComment('');
  };

  return (
    <section role="region" aria-labelledby={rowId} className="ml-9 mb-2 mt-1 rounded-lg border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{todo.id}</span>
        <span>{TODO_STATUS_LABEL[todo.status]}</span>
        <span>创建 {formatDateTime(todo.created)}</span>
        <span>更新 {formatRelativeUpdated(todo.updated, now)}</span>
        {hasDependencies ? <span>依赖 <span className="font-mono">{todo.depends_on.join(', ')}</span></span> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">标签</span>
        {todo.tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {tag}<button type="button" disabled={busy} aria-label={`移除标签 ${tag}`} onClick={() => void run('todo.untag', { id: todo.id, tag })}>×</button>
          </span>
        ))}
        <form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); const tags = tagInput.split(',').map((item) => item.trim()).filter(Boolean); if (tags.length) void run('todo.tag', { id: todo.id, tags }).then(() => setTagInput('')); }}>
          <input aria-label="添加标签" value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="添加标签" className="h-7 w-28 rounded border bg-background px-2 text-xs" />
          <button type="submit" disabled={busy || !tagInput.trim()} className="rounded border px-2 text-xs">添加</button>
        </form>
      </div>

      {editing ? (
        <div className="mt-4 grid gap-2">
          <label className="grid gap-1 text-xs">标题<input value={title} onChange={(event) => setTitle(event.target.value)} className="rounded border bg-background px-2 py-1 text-sm" /></label>
          <label className="grid gap-1 text-xs">请求<textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={4} className="rounded border bg-background px-2 py-1 text-sm" /></label>
          <label className="grid gap-1 text-xs">验收标准<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} className="rounded border bg-background px-2 py-1 text-sm" /></label>
          <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void saveDescription()} className="rounded bg-primary px-3 py-1 text-primary-foreground">保存描述</button><button type="button" onClick={() => setEditing(false)} className="rounded border px-3 py-1">取消</button></div>
        </div>
      ) : (
        <>
          {hasRequest ? <div className="mt-2"><Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">{todo.request}</Markdown></div> : null}
          {hasAcceptance ? <div><div className="mt-4 mb-1 text-xs font-medium text-muted-foreground">验收标准</div><Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">{todo.acceptance}</Markdown></div> : null}
          <button type="button" onClick={() => { setTitle(todo.title); setRequest(todo.request); setAcceptance(todo.acceptance); setEditing(true); }} className="mt-3 rounded border px-2 py-1 text-xs">编辑描述</button>
        </>
      )}

      <div className="mt-4 border-t pt-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">评论</div>
        <div className="grid gap-3">
          {comments.map((item) => (
            <article key={item.id} className="rounded-md bg-muted/40 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><span>{item.author}</span><time dateTime={item.at}>{formatDateTime(item.at)}</time>
                {item.author === 'user' ? <button type="button" disabled={busy} onClick={() => void run('todo.uncomment', { id: todo.id, commentId: item.id })} className="ml-auto">删除</button> : null}
              </div>
              <Markdown dark={appearance.dark} onOpenExternal={openExternal} className="text-sm leading-relaxed">{item.text}</Markdown>
            </article>
          ))}
          {comments.length === 0 ? <div className="text-xs text-muted-foreground">暂无评论</div> : null}
        </div>
        <form className="mt-3 grid gap-2" onSubmit={(event) => { event.preventDefault(); void addComment(); }}>
          <textarea aria-label="添加评论" value={comment} onChange={(event) => setComment(event.target.value)} rows={2} placeholder="写下评论" className="rounded border bg-background px-2 py-1 text-sm" />
          <button type="submit" disabled={busy || !comment.trim()} className="justify-self-start rounded border px-3 py-1 text-xs">发表评论</button>
        </form>
      </div>
      {error ? <div role="alert" className="mt-3 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
    </section>
  );
}
