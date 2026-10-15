/**
 * Transcript view of the session ledger: one item per folded turn, followed by
 * the optimistic pending sends. Each turn delegates to {@link TranscriptTurn};
 * the scroller, composer and page chrome stay with the session page.
 */
import { memo } from 'react';
import { cn } from 'cn';
import { Timestamp } from '@/renderer/components/timestamp';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import type { TurnModel } from '../../model/types.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import { TranscriptTurn } from './TranscriptTurn.js';

export interface TranscriptViewProps {
  /** Folded turns, rendered in input order. */
  turns: readonly TurnModel[];
  /** Optimistic sends that have not become turns yet. */
  pending: readonly PendingTurn[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Interrupt one running turn. */
  onInterrupt: (turn: number) => void;
  /** Cancel one dispatched task run. */
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** The transcript view: the ledger rendered inline as chronological turn cards. */
export const TranscriptView = memo(function TranscriptView({
  turns,
  pending,
  sessionId,
  onInterrupt,
  onCancelTask,
}: TranscriptViewProps) {
  return (
    <>
      {turns.map((turn) => (
        <MessageScrollerItem
          key={`transcript:${turn.id}`}
          messageId={`transcript:${turn.id}`}
          data-turn-id={turn.id}
          className="flex flex-col gap-3"
        >
          <TranscriptTurn
            turn={turn}
            sessionId={sessionId}
            onInterrupt={onInterrupt}
            onCancelTask={onCancelTask}
          />
        </MessageScrollerItem>
      ))}
      {pending.map((item) => (
        <MessageScrollerItem
          key={`transcript-pending:${item.localId}`}
          messageId={`transcript-pending:${item.localId}`}
          className="flex flex-col gap-3"
        >
          <div className="rounded-xl bg-muted/60 px-4 py-3">
            <div className="text-xs text-muted-foreground">
              你 · <Timestamp value={item.at} precision="second" />
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm">{item.text}</div>
            <p className={cn('mt-1 text-xs', item.failed === undefined ? 'text-muted-foreground' : 'text-destructive')}>
              {item.failed === undefined ? '发送中…' : '发送失败'}
            </p>
          </div>
        </MessageScrollerItem>
      ))}
    </>
  );
});
