import type { ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';

export interface ConversationProps {
  children: ReactNode;
  className?: string;
}

/**
 * Scroll container for the conversation stream. Uses a native scroll element
 * (not `ScrollArea`) because stick-to-bottom owns the scroll target.
 */
export function Conversation({ children, className }: ConversationProps) {
  return (
    <StickToBottom
      className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', className)}
      resize="smooth"
      initial="smooth"
    >
      {children}
    </StickToBottom>
  );
}

export function ConversationContent({ children, className }: ConversationProps) {
  return (
    <StickToBottom.Content className={cn('flex flex-col gap-6 px-4 py-6', className)}>
      {children}
    </StickToBottom.Content>
  );
}

/** Appears only while the user has scrolled away from the newest content. */
export function ConversationScrollButton({ className }: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="回到最新"
      className={cn('absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full', className)}
      onClick={() => void scrollToBottom()}
    >
      <ArrowDown />
    </Button>
  );
}
