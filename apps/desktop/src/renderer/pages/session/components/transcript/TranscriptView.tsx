/**
 * Transcript view of the session ledger: one item per folded turn, followed by
 * the optimistic pending sends. Each turn delegates to {@link TranscriptTurn};
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
import { TranscriptTurn } from './TranscriptTurn.js';

export interface TranscriptViewProps {
  /** Folded turns, rendered in input order. */
  turns: readonly TurnModel[];
  /** Optimistic sends that have not become turns yet. */
  pending: readonly PendingTurn[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Model catalog, forwarded so replies can show a display name. */
  models?: readonly ModelEntry[];
  /** Cancel one dispatched task run. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** Retry one pending send that failed. */
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  /** Remove one pending send that failed. */
  onRemove: (localId: string) => void;
  /** Per-turn live recovery waiting state, keyed by turn id. */
  waiting?: ReadonlyMap<number, TurnWaitingState>;
}

/** The transcript view: the ledger rendered inline as chronological turn cards. */
export const TranscriptView = memo(function TranscriptView({
  turns,
  pending,
  sessionId,
  models,
  onCancelTask,
  onRetry,
  onRemove,
  waiting,
}: TranscriptViewProps) {
  return (
    <>
      {turns.map((turn) => (
        <MessageScrollerItem
          key={`transcript:${turn.id}`}
          messageId={`transcript:${turn.id}`}
          data-turn-id={turn.id}
          className={cn('flex flex-col gap-3', turn.status === 'running' && '[content-visibility:visible]')}
        >
          <TranscriptTurn
            turn={turn}
            sessionId={sessionId}
            models={models}
            onCancelTask={onCancelTask}
            waiting={waiting?.get(turn.id)}
          />
        </MessageScrollerItem>
      ))}
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
    </>
  );
});
