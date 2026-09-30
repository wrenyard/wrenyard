import { CopyButton } from '@/renderer/components/copy-button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { Markdown } from '@/renderer/components/markdown';
import { Timestamp } from '@/renderer/components/timestamp';
import { Message, MessageActions, MessageContent, MessageFooter } from '@/renderer/components/chat/message';
import { statusView } from '../../model/describe.js';
import type { TurnModel } from '../../model/types.js';
import { TurnMeta, TurnMetaSummary } from './TurnMeta.js';

function TurnMetaHover({ turn }: { turn: TurnModel }) {
  return (
    <HoverCard>
      <HoverCardTrigger render={<span className="inline-flex cursor-default flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" />}>
        <TurnMetaSummary turn={turn} />
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <TurnMeta turn={turn} />
      </HoverCardContent>
    </HoverCard>
  );
}

export interface FinalReplyProps {
  turn: TurnModel;
}

/** Assistant reply, or the muted terminal line for a turn without a final reply. */
export function FinalReply({ turn }: FinalReplyProps) {
  if (!turn.final) {
    if (turn.status === 'running') return null;
    return (
      <Message from="assistant">
        <MessageContent>
          <p className="text-xs text-muted-foreground">
            {statusView(turn.status).label}
            {turn.endedAt && <> · <Timestamp value={turn.endedAt} /></>}
          </p>
          <MessageFooter><TurnMetaHover turn={turn} /></MessageFooter>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant">
      <MessageContent>
        <Markdown streaming={turn.final.streaming}>{turn.final.text}</Markdown>
        <MessageFooter>
          <MessageActions><CopyButton text={turn.final.text} /></MessageActions>
          <TurnMetaHover turn={turn} />
          <Timestamp value={turn.final.at} />
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
