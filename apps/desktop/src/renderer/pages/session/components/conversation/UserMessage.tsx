import { RotateCw } from 'lucide-react';
import { cn } from 'cn';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/renderer/components/ui/message';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useEnterAnimation } from '@/renderer/lib/motion';
import type { PendingTurn } from '../../state/session-reducer.js';
import { MediaAttachments, type MediaAttachmentItem } from '../MediaAttachments.js';
import { HoverTime } from './HoverTime.js';
import { ReplyMenu } from './ReplyMenu.js';

const REPLY_PREFIX = /^> (.*)\n\n/;

/** Prefix a sent message with the quoted message it replies to. */
export function withReplyQuote(quote: string, text: string): string {
  return `> ${quote}\n\n${text}`;
}

/** Split a sent message into its reply quote (if any) and its own body. */
export function splitReplyQuote(text: string): { quote?: string; body: string } {
  const match = REPLY_PREFIX.exec(text);
  return match === null ? { body: text } : { quote: match[1]!, body: text.slice(match[0].length) };
}

export interface UserMessageProps {
  text: string;
  at: string;
  /** Ledger media references attached to the user message. */
  attachments?: MediaAttachmentItem[];
  /** Session id used to resolve ledger media; omitted for optimistic drafts. */
  sessionId?: string;
  /** The optimistic turn backing this message, if it has not been persisted yet. */
  pending?: PendingTurn;
  /** Restore the failed text and drop the optimistic turn. */
  onRetry?: () => void;
  /** Play the entry animation; only set for genuinely new appends. */
  enter?: boolean;
  onReply?: () => void;
}

/** The user's own message: a right-aligned primary bubble with a hover time. */
export function UserMessage({ text, at, attachments, sessionId, pending, onRetry, enter, onReply }: UserMessageProps) {
  const animate = useEnterAnimation(enter === true);
  const { quote, body } = splitReplyQuote(text);
  return (
    <Message
      align="end"
      className={cn(animate && 'animate-in fade-in slide-in-from-bottom-2 duration-base ease-out')}
    >
      <MessageContent className="gap-1">
        {attachments !== undefined && attachments.length > 0 && (
          <MediaAttachments
            items={attachments}
            align="end"
            {...(sessionId === undefined ? {} : { sessionId })}
          />
        )}
        {(body !== '' || quote !== undefined) && (
          <div className="flex items-end justify-end gap-2">
            <HoverTime value={at} />
            <ReplyMenu onReply={onReply}>
              <Bubble variant="default" align="end">
                <BubbleContent className="rounded-2xl px-3 py-1.5">
                  {quote !== undefined && (
                    <div className="mb-1 line-clamp-2 rounded-lg bg-primary-foreground/15 px-2 py-1 text-xs opacity-80">{quote}</div>
                  )}
                  <span className="whitespace-pre-wrap">{body}</span>
                </BubbleContent>
              </Bubble>
            </ReplyMenu>
          </div>
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
