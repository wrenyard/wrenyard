import { cn } from 'cn';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Message, MessageContent } from '@/renderer/components/ui/message';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { useEnterAnimation } from '@/renderer/lib/motion';
import { noFinalReply } from '../../model/describe.js';
import type { ReplyModel, TurnModel } from '../../model/types.js';
import { HoverTime } from './HoverTime.js';
import { ReplyMenu } from './ReplyMenu.js';

export interface AssistantMessageProps {
  turn: TurnModel;
  /** The reply to render; omitted for the terminal fallback of a turn without replies. */
  reply?: ReplyModel;
  /** A contextual reference to an earlier message separated by other turns. */
  reference?: { author: string; text: string; onJump: () => void };
  /** Play the entry animation; only set for genuinely new appends. */
  enter?: boolean;
  onReply?: () => void;
}

/**
 * One committed communication reply, or the terminal fallback when `reply` is
 * omitted. Raw reason/thinking output is never shown here (it lives in the
 * inspector only).
 */
export function AssistantMessage({ turn, reply, reference, enter, onReply }: AssistantMessageProps) {
  const animate = useEnterAnimation(enter === true);
  const fallback = reply === undefined ? noFinalReply(turn) : undefined;
  const at = reply?.at ?? turn.endedAt;
  return (
    <Message className={cn(animate && 'animate-in fade-in slide-in-from-bottom-2 duration-base ease-out')}>
      <MessageContent>
        <div className="flex items-end gap-2">
          <ReplyMenu onReply={onReply}>
            <Bubble variant={fallback === undefined ? 'muted' : fallback.variant === 'destructive' ? 'destructive' : 'outline'}>
              <BubbleContent className="rounded-2xl px-3 py-1.5">
                {reference !== undefined && (
                  <button
                    type="button"
                    className="mb-1 flex w-full min-w-0 flex-col rounded-lg bg-foreground/5 px-2 py-1 text-left text-xs hover:bg-foreground/10"
                    aria-label={`查看引用的${reference.author}消息：${reference.text}`}
                    onClick={reference.onJump}
                  >
                    <span className="text-muted-foreground">{reference.author}</span>
                    <span className="line-clamp-2 text-muted-foreground">{reference.text}</span>
                  </button>
                )}
                {reply !== undefined
                  ? <Markdown>{reply.text}</Markdown>
                  : <span className="whitespace-pre-wrap">{fallback!.text}</span>}
              </BubbleContent>
            </Bubble>
          </ReplyMenu>
          {at !== undefined && <HoverTime value={at} />}
        </div>
      </MessageContent>
    </Message>
  );
}
