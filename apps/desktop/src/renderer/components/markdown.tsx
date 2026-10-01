import type { ComponentProps } from 'react';
import { Streamdown, type Components } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { cn } from 'cn';
import { shell } from '@/renderer/lib/desktop';
import { useAppearance } from '@/renderer/lib/theme';

const PLUGINS = { code, cjk };

/** Shiki theme per appearance mode; `github-dark-default` matches the dark tokens. */
const SHIKI_THEME = { light: 'github-light', dark: 'github-dark-default' } as const;

function MarkdownLink({ href, children, onClick, ...rest }: ComponentProps<'a'>) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href) return;
        event.preventDefault();
        void shell.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const COMPONENTS = { a: MarkdownLink } as Components;

export interface MarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
}

/**
 * Streamdown configured for the conversation surface: code + CJK plugins only,
 * no math or mermaid. Fenced code is highlighted with the JavaScript Shiki engine.
 */
export function Markdown({ children, streaming = false, className }: MarkdownProps) {
  const { dark } = useAppearance();
  // Streamdown takes a [light, dark] pair; pin both slots to the active theme so
  // highlighting follows the resolved appearance instead of the CSS `dark:` class.
  const shikiTheme: [string, string] = dark
    ? [SHIKI_THEME.dark, SHIKI_THEME.dark]
    : [SHIKI_THEME.light, SHIKI_THEME.light];

  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      caret="block"
      plugins={PLUGINS}
      shikiTheme={shikiTheme}
      components={COMPONENTS}
      className={cn('text-sm', className)}
    >
      {children}
    </Streamdown>
  );
}
