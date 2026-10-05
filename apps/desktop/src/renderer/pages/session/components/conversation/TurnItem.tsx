import { memo } from 'react';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import { useNow } from '@/renderer/hooks/use-now';
import { shell } from '@/renderer/lib/desktop';
import { dividerBefore } from '../../model/dividers.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import type { DraftAttachment, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromDraftAttachment, fromSessionFile } from '../MediaAttachments.js';
import { AssistantMessage } from './AssistantMessage.js';
import { TimeDivider } from './TimeDivider.js';
import { TurnStatus } from './TurnStatus.js';
import { UserMessage } from './UserMessage.js';

export interface TurnItemProps {
  turn: TurnModel;
  /** The previous turn, used to place the time divider. */
  previous?: TurnModel;
  /** Whether this turn carries the latest actual user message. */
  latest: boolean;
  /** Ledger session id, used to resolve attachment media. */
  sessionId?: string;
  /** Whether the user message was appended after the conversation settled. */
  enterUser?: boolean;
  /** Whether the assistant reply was appended after the conversation settled. */
  enterAssistant?: boolean;
  onInterrupt: (turn: number) => void;
}

/** Completed dispatch actions that produced session files, as result cards. */
function DispatchFileCards({ turn, sessionId }: { turn: TurnModel; sessionId: string }) {
  const cards = turn.actions.filter(
    (action) => action.kind === 'dispatch' && action.status === 'done' && (action.files?.length ?? 0) > 0,
  );
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pl-10">
      {cards.map((action) => (
        <div key={action.id} className="rounded-xl border bg-muted/40 px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="truncate">{action.task?.taskName ?? action.title}</span>
            {action.taskRunId !== undefined && (
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:underline"
                onClick={() => { void shell.openTaskTranscript(action.taskRunId!); }}
              >
                查看任务
              </button>
            )}
          </div>
          <MediaAttachments items={action.files!.map(fromSessionFile)} sessionId={sessionId} />
        </div>
      ))}
    </div>
  );
}

/** One turn: optional divider, user message, assistant reply and live status. */
export const TurnItem = memo(function TurnItem({ turn, previous, latest, sessionId, enterUser, enterAssistant, onInterrupt }: TurnItemProps) {
  const label = dividerBefore(previous, turn, useNow());
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
  return (
    <MessageScrollerItem data-turn-id={turn.id} messageId={`turn-${turn.id}`} scrollAnchor className="flex flex-col gap-4">
      {label !== undefined && <TimeDivider label={label} />}
      <UserMessage
        text={turn.user.text}
        at={turn.user.at}
        enter={enterUser}
        {...(attachments.length > 0 ? { attachments } : {})}
        {...(sessionId === undefined ? {} : { sessionId })}
        {...(latest ? { readAt: turn.receivedAt } : {})}
      />
      <AssistantMessage turn={turn} enter={enterAssistant} />
      {sessionId !== undefined && <DispatchFileCards turn={turn} sessionId={sessionId} />}
      {turn.status === 'running' && <TurnStatus turn={turn} onInterrupt={onInterrupt} />}
    </MessageScrollerItem>
  );
});

export interface PendingTurnItemProps {
  pending: PendingTurn;
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  onRemove: (localId: string) => void;
}

/** Optimistic turn shown between send and the matching `turn.started` event. */
export function PendingTurnItem({ pending, onRetry, onRemove }: PendingTurnItemProps) {
  const attachments = (pending.attachments ?? []).map(fromDraftAttachment);
  return (
    <MessageScrollerItem messageId={`pending-${pending.localId}`} scrollAnchor className="flex flex-col gap-4">
      <UserMessage
        text={pending.text}
        at={pending.at}
        pending={pending}
        {...(attachments.length > 0 ? { attachments } : {})}
        onRetry={() => { onRetry(pending.text, pending.attachments ?? []); onRemove(pending.localId); }}
      />
    </MessageScrollerItem>
  );
}
