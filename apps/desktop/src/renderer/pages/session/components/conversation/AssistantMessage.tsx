import { cn } from 'cn';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Message, MessageContent } from '@/renderer/components/ui/message';
import { MessageFooter } from '@/renderer/components/chat/MessageFooter';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { useEnterAnimation } from '@/renderer/lib/motion';
import type { ReplyModel, SessionFile, TurnModel } from '../../model/types.js';
import { ReplyMenu } from './ReplyMenu.js';

export interface AssistantMessageProps {
  turn: TurnModel;
  /** The reply to render: a recorded publication, or the closing reply the turn derived on read. */
  reply: ReplyModel;
  /** A contextual reference to an earlier message separated by other turns. */
  reference?: { author: string; text: string; onJump: () => void };
  /** Play the entry animation; only set for genuinely new appends. */
  enter?: boolean;
  onReply?: () => void;
  /** Every task file the session produced, so the reply's references resolve. */
  attachmentFiles?: readonly SessionFile[];
  /** Ledger session id, used to authorize attachment media reads and reveals. */
  sessionId?: string;
  /** Display name of the model that wrote this reply. */
  model?: string;
}

/**
 * One committed communication reply, including the closing reply a turn
 * derived on read. Raw reason/thinking output is never shown here (it lives in
 * the transcript view only).
 */
export function AssistantMessage({ turn, reply, reference, enter, onReply, attachmentFiles, sessionId, model }: AssistantMessageProps) {
  const animate = useEnterAnimation(enter === true);
  const at = reply.at || turn.endedAt;
  return (
    <Message className={cn('group/msg', animate && 'animate-in fade-in slide-in-from-bottom-2 duration-base ease-out')}>
      <MessageContent>
        <div className="flex items-end gap-2">
          <ReplyMenu text={reply.text} onReply={onReply}>
            <Bubble variant={reply.tone === 'destructive' ? 'destructive' : reply.tone === 'muted' ? 'outline' : 'muted'}>
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
                <Markdown
                  {...(attachmentFiles === undefined ? {} : { attachments: attachmentFiles })}
                  {...(sessionId === undefined ? {} : { sessionId })}
                >
                  {reply.text}
                </Markdown>
              </BubbleContent>
            </Bubble>
          </ReplyMenu>
        </div>
        <MessageFooter align="left" at={at} text={reply.text} model={model} />
      </MessageContent>
    </Message>
  );
}
