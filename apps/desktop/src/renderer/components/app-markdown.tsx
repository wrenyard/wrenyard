import { useCallback } from 'react';
import type { SessionFile } from '@wrenyard/protocol';
import { shell } from '@/renderer/lib/desktop';
import { getSessionBridge } from '@/renderer/lib/session';
import { useAppearance } from '@/renderer/lib/theme';
import { Markdown as PureMarkdown, type MarkdownProps } from '@/renderer/components/markdown';
import { useTodoLinkIds } from '@/renderer/components/todo-link';

export interface AppMarkdownProps extends Omit<
  MarkdownProps,
  'dark' | 'onOpenExternal' | 'attachments' | 'onReadAttachment' | 'onRevealAttachment' | 'todoIds'
> {
  /** Task files the message may reference; only their exact reference URLs render in place. */
  attachments?: readonly SessionFile[];
  /** Ledger session id authorizing attachment media reads and reveals. */
  sessionId?: string;
}

/**
 * Main-app embedder for the pure Markdown renderer: binds the resolved
 * appearance, the shell external-link opener and the session attachment bridge
 * so the renderer itself stays free of shell/theme module-load side effects.
 */
export function AppMarkdown({ attachments, sessionId, ...props }: AppMarkdownProps) {
  const { dark } = useAppearance();
  const todoIds = useTodoLinkIds();
  const onOpenExternal = useCallback((href: string) => {
    void shell.openExternal(href);
  }, []);
  const onReadAttachment = useCallback(async (file: SessionFile): Promise<string | undefined> => {
    if (sessionId === undefined || sessionId === '') return undefined;
    try {
      const result = await getSessionBridge().mediaRead({ sessionId, path: file.path });
      return result.dataUrl;
    } catch {
      return undefined;
    }
  }, [sessionId]);
  const onRevealAttachment = useCallback((file: SessionFile): void => {
    if (sessionId === undefined || sessionId === '') return;
    void getSessionBridge().revealMedia({ sessionId, path: file.path }).catch(() => undefined);
  }, [sessionId]);

  return (
    <PureMarkdown
      {...props}
      {...(attachments === undefined ? {} : { attachments })}
      dark={dark}
      todoIds={todoIds}
      onOpenExternal={onOpenExternal}
      onReadAttachment={onReadAttachment}
      onRevealAttachment={onRevealAttachment}
    />
  );
}
