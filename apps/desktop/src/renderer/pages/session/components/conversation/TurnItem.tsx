import { memo } from 'react';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import { useNow } from '@/renderer/hooks/use-now';
import { dividerBefore } from '../../model/dividers.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import type { TurnModel } from '../../model/types.js';
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
  /** Whether the user message was appended after the conversation settled. */
  enterUser?: boolean;
  /** Whether the assistant reply was appended after the conversation settled. */
  enterAssistant?: boolean;
  onInterrupt: (turn: number) => void;
}

/** One turn: optional divider, user message, assistant reply and live status. */
export const TurnItem = memo(function TurnItem({ turn, previous, latest, enterUser, enterAssistant, onInterrupt }: TurnItemProps) {
  const label = dividerBefore(previous, turn, useNow());
  return (
    <MessageScrollerItem data-turn-id={turn.id} messageId={`turn-${turn.id}`} scrollAnchor className="flex flex-col gap-4">
      {label !== undefined && <TimeDivider label={label} />}
      <UserMessage
        text={turn.user.text}
        at={turn.user.at}
        enter={enterUser}
        {...(latest ? { readAt: turn.receivedAt } : {})}
      />
      <AssistantMessage turn={turn} enter={enterAssistant} />
      {turn.status === 'running' && <TurnStatus turn={turn} onInterrupt={onInterrupt} />}
    </MessageScrollerItem>
  );
});

export interface PendingTurnItemProps {
  pending: PendingTurn;
  onRetry: (text: string) => void;
  onRemove: (localId: string) => void;
}

/** Optimistic turn shown between send and the matching `turn.started` event. */
export function PendingTurnItem({ pending, onRetry, onRemove }: PendingTurnItemProps) {
  return (
    <MessageScrollerItem messageId={`pending-${pending.localId}`} scrollAnchor className="flex flex-col gap-4">
      <UserMessage
        text={pending.text}
        at={pending.at}
        pending={pending}
        onRetry={() => { onRetry(pending.text); onRemove(pending.localId); }}
      />
    </MessageScrollerItem>
  );
}
