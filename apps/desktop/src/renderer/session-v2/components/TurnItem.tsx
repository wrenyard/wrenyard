import { memo } from 'react';
import { RotateCw, Square } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { CopyButton } from '@/renderer/components/copy-button';
import { Message, MessageContent } from '@/renderer/components/chat/message';
import { formatClock, formatDateTime } from '@/renderer/lib/format';
import type { PendingTurn } from '../state/session-reducer.js';
import type { TurnModel } from '../model/types.js';
import { ActivityCards } from './ActivityCards.js';
import { FinalReply } from './FinalReply.js';
import { WorkProcess } from './WorkProcess.js';

function InterruptButton({ turn, onInterrupt }: { turn: TurnModel; onInterrupt: (turn: number) => void }) {
  if (turn.interrupting) {
    return (
      <Button size="icon-sm" variant="ghost" disabled aria-label="正在中断">
        <Spinner className="size-3.5" />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="中断此轮次" />}
        onClick={() => onInterrupt(turn.id)}
      >
        <Square className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>中断此轮次</TooltipContent>
    </Tooltip>
  );
}

function UserBubble({ text, at }: { text: string; at: string }) {
  return (
    <MessageContent>
      <div className="flex items-end gap-2">
        <CopyButton text={text} className="opacity-0 transition-opacity group-hover/message:opacity-100" label="复制消息" />
        <div className="flex flex-col items-end">
          <span className="whitespace-pre-wrap">{text}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="text-[10px] opacity-70" />}>{formatClock(at)}</TooltipTrigger>
            <TooltipContent>{formatDateTime(at)}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </MessageContent>
  );
}

export interface TurnItemProps {
  turn: TurnModel;
  onInterrupt: (turn: number) => void;
}

/** One turn: user message, work process, system activity and final reply. */
export const TurnItem = memo(function TurnItem({ turn, onInterrupt }: TurnItemProps) {
  const running = turn.status === 'running';
  return (
    <div className="flex flex-col gap-3">
      <Message from="user">
        {running && <div className="mr-2 self-center"><InterruptButton turn={turn} onInterrupt={onInterrupt} /></div>}
        <UserBubble text={turn.user.text} at={turn.user.at} />
      </Message>
      <WorkProcess turn={turn} />
      <ActivityCards turn={turn} />
      <FinalReply turn={turn} />
    </div>
  );
});

export interface PendingTurnItemProps {
  pending: PendingTurn;
  onRetry: (text: string) => void;
  onRemove: (localId: string) => void;
}

/** Optimistic turn shown between send and the matching `turn.started` event. */
export function PendingTurnItem({ pending, onRetry, onRemove }: PendingTurnItemProps) {
  const failed = pending.failed !== undefined;
  return (
    <div className="flex flex-col gap-3">
      <Message from="user"><UserBubble text={pending.text} at={pending.at} /></Message>
      {failed ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span>发送失败：{pending.failed}</span>
          <Button variant="outline" size="xs"
            onClick={() => { onRetry(pending.text); onRemove(pending.localId); }}>
            <RotateCw /> 重新编辑
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-3.5" />发送中…</div>
      )}
    </div>
  );
}
