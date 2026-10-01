import type { ComponentProps } from 'react';
import { cn } from 'cn';

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

export function PageTitle({ className, ...props }: ComponentProps<'h1'>) {
  return <h1 className={cn('text-base font-medium', className)} {...props} />;
}

export function PageDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground', className)} {...props} />;
}

/** Right-aligned action cluster inside a `PageHeader`. */
export function PageActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('ml-auto flex items-center gap-2', className)} {...props} />;
}

/** Scrollable page body and container-query root for page-local layouts. */
export function PageContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('@container/main flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4', className)}
      {...props}
    />
  );
}
