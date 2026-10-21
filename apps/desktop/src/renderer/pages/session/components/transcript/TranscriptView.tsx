/**
 * Transcript view of the session ledger: one timeline of user messages and
 * reply blocks, followed by the optimistic pending sends and the still open
 * blocks of running turns. Blocks come from {@link transcriptTimeline};
 * the scroller, composer and page chrome stay with the session page.
 */
import { memo } from 'react';
import { cn } from 'cn';
import { MessageFooter } from '@/renderer/components/chat/MessageFooter';
import { Button } from '@/renderer/components/ui/button';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import type { TurnWaitingState } from '../../model/describe.js';
import type { DraftAttachment, ModelEntry, TurnModel } from '../../model/types.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import { MediaAttachments, fromDraftAttachment } from '../MediaAttachments.js';
import { ReplyQuote } from './ReplyQuote.js';
import { TranscriptBody, TranscriptUserMessage } from './TranscriptTurn.js';
import { transcriptTimeline } from './transcript-timeline.js';

export interface TranscriptViewProps {
  /** Folded turns, rendered in input order. */
  turns: readonly TurnModel[];
  /** Optimistic sends that have not become turns yet. */
  pending: readonly PendingTurn[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Model catalog, forwarded so replies can show a display name. */
  models?: readonly ModelEntry[];
  /** Bot display names, keyed by immutable bot id. */
  botNames?: ReadonlyMap<string, string>;
  /** Cancel one dispatched task run. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** Retry one pending send that failed. */
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  /** Remove one pending send that failed. */
  onRemove: (localId: string) => void;
  /** Per-turn live recovery waiting state, keyed by turn id. */
  waiting?: ReadonlyMap<number, TurnWaitingState>;
}

/** The transcript view: the ledger rendered as one timeline of messages and reply blocks. */
export const TranscriptView = memo(function TranscriptView({
  turns,
  pending,
  sessionId,
  models,
  botNames,
  onCancelTask,
  onRetry,
  onRemove,
  waiting,
}: TranscriptViewProps) {
  const { timeline, open } = transcriptTimeline(turns, pending.length > 0);
  return (
    <>
      {timeline.map((item) =>
        item.kind === 'user' ? (
          <MessageScrollerItem
            key={`transcript-user:${item.turn.id}`}
            messageId={`transcript-user:${item.turn.id}`}
            data-turn-id={item.turn.id}
          >
            <div data-lightbox-root>
              <TranscriptUserMessage turn={item.turn} sessionId={sessionId} botNames={botNames} />
            </div>
          </MessageScrollerItem>
        ) : (
          <MessageScrollerItem
            key={`transcript-block:${item.turn.id}:${item.index}`}
            messageId={`transcript-block:${item.turn.id}:${item.index}`}
            className="flex flex-col gap-3"
          >
            <div className="relative flex flex-col gap-3" data-lightbox-root>
              {item.quote && <ReplyQuote turn={item.turn} />}
              <TranscriptBody
                turn={item.turn}
                entries={item.entries}
                live={false}
                sessionId={sessionId}
                models={models}
                botNames={botNames}
                onCancelTask={onCancelTask}
              />
            </div>
          </MessageScrollerItem>
        ),
      )}
      {pending.map((item) => (
        <MessageScrollerItem
          key={`transcript-pending:${item.localId}`}
          messageId={`transcript-pending:${item.localId}`}
          className="flex flex-col gap-3"
        >
          <div className="group/msg flex flex-col items-end gap-1.5">
            <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
              {item.text}
              {(item.attachments?.length ?? 0) > 0 && (
                <MediaAttachments
                  items={(item.attachments ?? []).map(fromDraftAttachment)}
                  sessionId={sessionId}
                  className="mt-2"
                />
              )}
            </div>
            <MessageFooter
              align="right"
              at={item.at}
              className={cn('text-xs', item.failed === undefined ? undefined : 'text-destructive')}
            >
              <span className="flex items-center gap-2">
                {item.failed === undefined ? '发送中…' : '发送失败'}
                {item.failed !== undefined && (
                  <>
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => {
                        onRetry(item.text, item.attachments ?? []);
                        onRemove(item.localId);
                      }}
                    >
                      重试
                    </Button>
                    <Button variant="link" size="xs" onClick={() => onRemove(item.localId)}>移除</Button>
                  </>
                )}
              </span>
            </MessageFooter>
          </div>
        </MessageScrollerItem>
      ))}
      {open.map((block) => (
        <MessageScrollerItem
          key={`transcript-block:${block.turn.id}:${block.index}`}
          messageId={`transcript-block:${block.turn.id}:${block.index}`}
          className={cn('flex flex-col gap-3', '[content-visibility:visible]')}
        >
          <div className="relative flex flex-col gap-3" data-lightbox-root>
            {block.quote && <ReplyQuote turn={block.turn} />}
            <TranscriptBody
              turn={block.turn}
              entries={block.entries}
              live={true}
              waiting={waiting?.get(block.turn.id)}
              sessionId={sessionId}
              models={models}
              botNames={botNames}
              onCancelTask={onCancelTask}
            />
          </div>
        </MessageScrollerItem>
      ))}
    </>
  );
});
