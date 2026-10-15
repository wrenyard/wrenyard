import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useMiniMode } from '@/renderer/lib/mini';
import { useSessionSeen } from '@/renderer/lib/session-seen';
import { SessionDot } from './SessionDot';
import { sessionStatusOf } from '../model/session-status.js';
import type { SessionSummary } from '../model/types.js';

export interface SessionTitleProps {
  title: string;
  session?: SessionSummary;
  draft: boolean;
  /** Save a manual title for the shown session; absent when it cannot be renamed. */
  onRename?: (title: string) => Promise<void>;
}

/**
 * Title-bar session title. The main-window title is inline-editable: clicking it
 * opens a focused editor, Enter or blur saves, Escape cancels, and an empty or
 * whitespace-only title is rejected without a request.
 */
export function SessionTitle({ title, session, draft, onRename }: SessionTitleProps) {
  const mini = useMiniMode();
  const seen = useSessionSeen();
  const label = draft ? '新对话' : title;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Set once a save or cancel for the current edit is under way, so the blur a
   * completed Enter (or Escape) provokes does not submit a second time.
   */
  const settling = useRef(false);
  /** Tracks IME composition so the Enter that commits it never saves. */
  const composing = useRef(false);
  /** The session this editor was opened for; a save stays bound to it. */
  const editingSession = useRef<string | undefined>(undefined);
  /** Cleared on unmount so an in-flight save cannot touch a replaced editor. */
  const mounted = useRef(true);

  // The caller keys this component by the selected session, so a session switch
  // replaces the editor entirely. Mark the discarded instance so the blur its
  // teardown may provoke can never save, and so its async completion is inert.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      settling.current = true;
    };
  }, []);

  // Entering the editor focuses it and shows the start of a long title; later
  // caret movement scrolls natively.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(0, 0);
    input.scrollLeft = 0;
  }, [editing]);

  // While not editing, track the shown title (which an automatic title may change).
  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  // Mini card: the session status dot, then plain text inside the drag region.
  if (mini) {
    const status = session === undefined ? undefined : sessionStatusOf(session, seen);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {status !== undefined && <SessionDot status={status} />}
        <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      </span>
    );
  }

  const begin = (): void => {
    if (draft || onRename === undefined) return;
    settling.current = false;
    editingSession.current = session?.sessionId;
    setError('');
    setValue(title);
    setEditing(true);
  };

  const cancel = (): void => {
    settling.current = true;
    setError('');
    setValue(title);
    setEditing(false);
  };

  const commit = async (): Promise<void> => {
    if (!mounted.current || onRename === undefined || settling.current) return;
    // A blur that belongs to another session must never rename this one. The
    // check is synchronous, before any request is issued.
    if (session === undefined || session.sessionId !== editingSession.current) return;
    const trimmed = value.trim();
    if (trimmed === '') {
      // Rejected without persistence; stay in the editor so the user can fix it.
      setError('标题不能为空');
      inputRef.current?.focus();
      return;
    }
    settling.current = true;
    if (trimmed === title) {
      setEditing(false);
      return;
    }
    // The save keeps the session captured at edit start; a completion for a
    // replaced editor leaves the new edit untouched.
    const submittedFor = editingSession.current;
    try {
      await onRename(trimmed);
      if (!mounted.current || editingSession.current !== submittedFor) return;
      setEditing(false);
      setError('');
    } catch (failure) {
      if (!mounted.current || editingSession.current !== submittedFor) return;
      settling.current = false;
      setError(failure instanceof Error ? failure.message : String(failure));
      inputRef.current?.focus();
    }
  };

  if (draft || onRename === undefined) {
    return <Button variant="ghost" className="max-w-80 truncate text-base font-medium">{label}</Button>;
  }

  // Display and edit states share one inline box: the ghost button keeps the
  // saved title's geometry (invisible while editing) and the input overlays it.
  return (
    <span className="relative inline-flex min-w-0 max-w-80 flex-col">
      <Button
        variant="ghost"
        className={`min-w-0 max-w-full shrink truncate text-base font-medium${editing ? ' invisible' : ''}`}
        onClick={begin}
      >
        {label}
      </Button>
      {editing && (
      <Input
        ref={inputRef}
        value={value}
        aria-label="会话标题"
        aria-invalid={error !== ''}
        className="absolute inset-x-0 top-0 h-8 rounded-[4px] border-transparent bg-transparent px-3 py-0 text-base font-medium outline-none ring-0 focus-visible:border-ring focus-visible:ring-0 aria-invalid:ring-0 md:text-base dark:bg-transparent"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current) {
            event.preventDefault();
            void commit();
          }
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onBlur={() => { void commit(); }}
      />
      )}
      {editing && error !== '' && (
        <span className="px-1 pt-0.5 text-xs text-destructive">{error}</span>
      )}
    </span>
  );
}
