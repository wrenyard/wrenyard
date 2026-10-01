import { useMemo, type ComponentProps } from 'react';
import { Streamdown, type Components } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { cn } from 'cn';

const PLUGINS = { code, cjk };

/** Shiki theme per appearance mode; `github-dark-default` matches the dark tokens. */
const SHIKI_THEME = { light: 'github-light', dark: 'github-dark-default' } as const;

type OpenExternal = (href: string) => void;

function MarkdownLink({
  href,
  children,
  onClick,
  onOpenExternal,
  ...rest
}: ComponentProps<'a'> & { onOpenExternal?: OpenExternal }) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href) return;
        event.preventDefault();
        onOpenExternal?.(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Link safety stays in the pure renderer: the anchor never navigates in-app.
 * The embedder injects the external opener (the main-app shell bridge or the
 * narrow Pet appearance bridge), so this module loads without shell side
 * effects.
 */
function createComponents(onOpenExternal?: OpenExternal): Components {
  return {
    a: (props) => <MarkdownLink {...props} onOpenExternal={onOpenExternal} />,
  };
}

export interface MarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
  /** Resolved dark appearance; the embedder supplies it instead of reading the theme store. */
  dark?: boolean;
  /** Opens http(s) links out of process; the anchor itself never navigates. */
  onOpenExternal?: OpenExternal;
}

/**
 * Streamdown configured for the conversation surface: code + CJK plugins only,
 * no math or mermaid. Fenced code is highlighted with the JavaScript Shiki engine.
 */
export function Markdown({
  children,
  streaming = false,
  className,
  dark = false,
  onOpenExternal,
}: MarkdownProps) {
  const components = useMemo(() => createComponents(onOpenExternal), [onOpenExternal]);
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
      components={components}
      className={cn('text-sm', className)}
    >
      {children}
    </Streamdown>
  );
}
