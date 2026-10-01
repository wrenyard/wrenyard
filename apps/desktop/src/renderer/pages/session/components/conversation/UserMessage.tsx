import { RotateCw } from 'lucide-react';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/renderer/components/ui/message';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatClock } from '@/renderer/lib/format';
import type { PendingTurn } from '../../state/session-reducer.js';
import { HoverTime } from './HoverTime.js';

export interface UserMessageProps {
  text: string;
  at: string;
  /**
   * When set, renders the `已读 HH:mm` footer. Only the latest actual user
   * message passes this; optimistic messages leave it undefined.
   */
  readAt?: string;
  /** The optimistic turn backing this message, if it has not been persisted yet. */
  pending?: PendingTurn;
  /** Restore the failed text and drop the optimistic turn. */
  onRetry?: () => void;
}

/** The user's own message: a right-aligned primary bubble with a hover time. */
export function UserMessage({ text, at, readAt, pending, onRetry }: UserMessageProps) {
  return (
    <Message align="end">
      <MessageContent>
        <div className="flex items-end justify-end gap-2">
          <HoverTime value={at} />
          <Bubble variant="default" align="end">
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        </div>
        {readAt !== undefined && (
          <MessageFooter className="gap-2">
            <span>已读</span>
            <span className="tabular-nums">{formatClock(readAt)}</span>
          </MessageFooter>
        )}
        {pending !== undefined && (pending.failed === undefined ? (
          <MessageFooter className="gap-2">
            <Spinner />
            <span>发送中…</span>
          </MessageFooter>
        ) : (
          <MessageFooter className="gap-2 font-normal text-destructive">
            <span>发送失败：{pending.failed}</span>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label="重新编辑" />}
                onClick={onRetry}
              >
                <RotateCw />
              </TooltipTrigger>
              <TooltipContent>重新编辑</TooltipContent>
            </Tooltip>
          </MessageFooter>
        ))}
      </MessageContent>
    </Message>
  );
}
