import { ListTree } from 'lucide-react';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/renderer/components/ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { CopyButton } from '@/renderer/components/copy-button';
import { Markdown } from '@/renderer/components/markdown';
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
}

/**
 * The single assistant message of an ended turn. A streaming final reply is
 * still rendered here while the turn is running, so the live text stays
 * visible; a running turn without a reply renders nothing. The hover footer
 * only appears once the turn has ended, never while the reply streams.
 */
export function AssistantMessage({ turn }: AssistantMessageProps) {
  const { inspect } = useInspector();
  const onInspect = (): void => inspect({ kind: 'turn', turnId: turn.id });

  if (!turn.final) {
    if (turn.status === 'running') return null;
    const fallback = noFinalReply(turn);
    return (
      <Message>
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
    <Message>
      <MessageContent>
        <div className="flex items-end gap-2">
          <Bubble variant="muted">
            <BubbleContent>
              <Markdown streaming={turn.final.streaming}>{turn.final.text}</Markdown>
            </BubbleContent>
          </Bubble>
          <HoverTime value={turn.final.at} />
        </div>
        {turn.endedAt !== undefined && <AssistantFooter text={turn.final.text} onInspect={onInspect} />}
      </MessageContent>
    </Message>
  );
}
