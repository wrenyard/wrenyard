import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '@/renderer/lib/utils';

export type MessageFrom = 'user' | 'assistant';

const MessageContext = createContext<MessageFrom>('assistant');

export interface MessageProps {
  from?: MessageFrom;
  children: ReactNode;
  className?: string;
}

/** One message row. `from="user"` right-aligns; the assistant spans the width. */
export function Message({ from = 'assistant', children, className }: MessageProps) {
  return (
    <MessageContext.Provider value={from}>
      <div
        data-from={from}
        className={cn('group/message flex w-full', from === 'user' ? 'justify-end' : 'justify-start', className)}
      >
        {children}
      </div>
    </MessageContext.Provider>
  );
}

/** Body wrapper. The user variant paints the bubble. */
export function MessageContent({ children, className }: { children: ReactNode; className?: string }) {
  const from = useContext(MessageContext);
  return (
    <div
      data-slot="message-content"
      className={cn(
        from === 'user'
          ? 'max-w-[80%] rounded-2xl bg-secondary px-3 py-2 text-secondary-foreground whitespace-pre-wrap'
          : 'w-full min-w-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MessageFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="message-footer"
      className={cn('mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}
    >
      {children}
    </div>
  );
}

export function MessageActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-slot="message-actions" className={cn('flex items-center gap-1', className)}>{children}</div>;
}
