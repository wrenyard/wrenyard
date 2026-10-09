import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Message, MessageContent } from '@/renderer/components/ui/message';
import type { TurnModel } from '../../model/types.js';

export interface TurnStatusProps {
  turn: TurnModel;
}

/** Require an active reply call so gaps between steps never look like typing. */
export function isWritingReply(turn: TurnModel): boolean {
  return turn.status === 'running'
    && turn.phase === 'replying'
    && turn.calls.some((call) => call.role === 'reply' && call.status === 'running');
}

const DOT_DELAYS = ['0ms', '160ms', '320ms'] as const;

/** A compact typing bubble, visible only while a reply is being written. */
export function TurnStatus({ turn }: TurnStatusProps) {
  if (!isWritingReply(turn)) return null;
  return (
    <Message>
      <MessageContent>
        <Bubble variant="muted" role="status" aria-label="正在撰写回复">
          <BubbleContent className="px-4 py-3">
            <span className="flex items-center gap-1.5" aria-hidden="true">
              {DOT_DELAYS.map((delay) => (
                <span
                  key={delay}
                  className="motion-typing-dot size-2 rounded-full bg-muted-foreground"
                  style={{ animationDelay: delay }}
                />
              ))}
            </span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
