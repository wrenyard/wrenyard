import { ListTree } from 'lucide-react';
import { cn } from 'cn';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/renderer/components/ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { CopyButton } from '@/renderer/components/copy-button';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { useEnterAnimation } from '@/renderer/lib/motion';
import { noFinalReply } from '../../model/describe.js';
import type { TurnModel } from '../../model/types.js';
import { useInspector } from '../inspector/Inspector.js';
import { HoverTime } from './HoverTime.js';

/** Hover-revealed assistant actions: copy the reply and open the work process. */
function AssistantFooter({ text, onInspect }: { text: string; onInspect: () => void }) {
  return (
    <MessageFooter className="gap-2 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
      <CopyButton text={text} size="icon-sm" label="复制回复" />
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="查看工作过程" />}
          onClick={onInspect}
        >
          <ListTree />
        </TooltipTrigger>
        <TooltipContent>查看工作过程</TooltipContent>
      </Tooltip>
    </MessageFooter>
  );
}

export interface AssistantMessageProps {
  turn: TurnModel;
  /** Play the entry animation; only set for genuinely new appends. */
  enter?: boolean;
}

/**
 * Every committed communication reply of a turn, in chronological order. One
 * bubble per reply with a subtle phase label for non-final phases; the hover
 * footer appears once on the last reply of an ended turn. A running turn with
 * no committed reply yet renders nothing, and raw reason/thinking output is
 * never shown here (it lives in the inspector only).
 */
export function AssistantMessage({ turn, enter }: AssistantMessageProps) {
  const { inspect } = useInspector();
  const animate = useEnterAnimation(enter === true);
  const enterClass = cn(animate && 'animate-in fade-in slide-in-from-bottom-2 duration-base ease-out');
  const onInspect = (): void => inspect({ kind: 'turn', turnId: turn.id });
  const replies = turn.replies;

  if (replies.length === 0) {
    if (turn.status === 'running') return null;
    const fallback = noFinalReply(turn);
    return (
      <Message className={enterClass}>
        <MessageContent>
          <div className="flex items-end gap-2">
            <Bubble variant={fallback.variant === 'destructive' ? 'destructive' : 'outline'}>
              <BubbleContent className="whitespace-pre-wrap">{fallback.text}</BubbleContent>
            </Bubble>
            {turn.endedAt !== undefined && <HoverTime value={turn.endedAt} />}
          </div>
          <AssistantFooter text={fallback.text} onInspect={onInspect} />
        </MessageContent>
      </Message>
    );
  }

  return (
    <>
      {replies.map((reply, index) => {
        const last = index === replies.length - 1;
        return (
          <Message key={`${turn.id}-${index}-${reply.at}`} className={enterClass}>
            <MessageContent>
              <div className="flex flex-col gap-1">
                <div className="flex items-end gap-2">
                  <Bubble variant="muted">
                    <BubbleContent>
                      <Markdown>{reply.text}</Markdown>
                    </BubbleContent>
                  </Bubble>
                  <HoverTime value={reply.at} />
                </div>
              </div>
              {last && turn.endedAt !== undefined && <AssistantFooter text={reply.text} onInspect={onInspect} />}
            </MessageContent>
          </Message>
        );
      })}
    </>
  );
}
