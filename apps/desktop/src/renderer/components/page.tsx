import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { SourceDevelopmentBadge } from '@/renderer/components/source-development-badge';

/** Full-height page frame that stacks a header above scrollable content. */
export function Page({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex h-full min-h-0 flex-col', className)} {...props} />;
}

/** Fixed-height page header aligned with the shell chrome height. */
export function PageHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('flex h-(--header-height) shrink-0 items-center gap-2 border-b px-4', className)}
      {...props}
    />
  );
}

export function PageTitle({ className, children, ...props }: ComponentProps<'h1'>) {
  return (
    <h1 className={cn('flex items-center gap-2 text-base font-medium', className)} {...props}>
      <SourceDevelopmentBadge />
      {children}
    </h1>
  );
}

export function PageDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground', className)} {...props} />;
}

/** Right-aligned action cluster inside a `PageHeader`. */
export function PageActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('ml-auto flex items-center gap-2', className)} {...props} />;
}

export interface PageContentProps extends ComponentProps<'div'> {
  /**
   * Keeps children as flex items that fill the available height instead of
   * scrolling (split layouts such as the tasks page).
   */
  fill?: boolean;
}

/**
 * Scrollable page body and container-query root for page-local layouts. The
 * default variant wraps the children in a plain block so cards grow to their
 * content height and the outer element scrolls; `fill` keeps the flex column
 * for pages whose children must fill the height.
 */
export function PageContent({ className, fill = false, children, ...props }: PageContentProps) {
  if (fill) {
    return (
      <div
        className={cn('@container/main flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4', className)}
        {...props}
      >
        {children}
      </div>
    );
  }
  return (
    <div className={cn('@container/main min-h-0 flex-1 overflow-auto', className)} {...props}>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </div>
  );
}
