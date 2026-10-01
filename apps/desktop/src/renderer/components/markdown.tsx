import type { ComponentProps } from 'react';
import { Streamdown, type Components } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { cn } from 'cn';
import { shell } from '@/renderer/lib/desktop';

const PLUGINS = { code, cjk };
/** Prototype has no dark theme yet; both slots use the light Shiki theme. */
const SHIKI_THEME: [string, string] = ['github-light', 'github-light'];

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
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      caret="block"
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEME}
      components={COMPONENTS}
      className={cn('text-sm', className)}
    >
      {children}
    </Streamdown>
  );
}
