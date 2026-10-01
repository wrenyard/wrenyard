import { useCallback } from 'react';
import { shell } from '@/renderer/lib/desktop';
import { useAppearance } from '@/renderer/lib/theme';
import { Markdown as PureMarkdown, type MarkdownProps } from '@/renderer/components/markdown';

export type AppMarkdownProps = Omit<MarkdownProps, 'dark' | 'onOpenExternal'>;

/**
 * Main-app embedder for the pure Markdown renderer: binds the resolved
 * appearance and the shell external-link opener so the renderer itself stays
 * free of shell/theme module-load side effects.
 */
export function AppMarkdown(props: AppMarkdownProps) {
  const { dark } = useAppearance();
  const onOpenExternal = useCallback((href: string) => {
    void shell.openExternal(href);
  }, []);

  return <PureMarkdown {...props} dark={dark} onOpenExternal={onOpenExternal} />;
}
