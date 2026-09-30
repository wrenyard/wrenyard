import { useLayoutEffect, useMemo, useRef } from 'react';
import { deriveTurns } from '../ledger-view.js';
import type { LedgerEvent } from '../types.js';
import { TurnCard } from './TurnCard.js';

export function ConversationTimeline({ events, loading, showRaw, onInterrupt }: {
  events: LedgerEvent[]; loading: boolean; showRaw: boolean; onInterrupt(turn: number): void;
}) {
  const turns = useMemo(() => deriveTurns(events), [events]);
  const stream = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (!showRaw && follow.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight;
  }, [events, showRaw]);
  return <>
    <div className="sv2-stream" ref={stream} hidden={showRaw} aria-busy={loading}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}>
      {turns.map((turn) => <TurnCard key={turn.id} turn={turn} onInterrupt={onInterrupt} />)}
      {!turns.length && <p className="sv2-empty">{loading ? '正在加载账本…' : '发送消息开始会话。'}</p>}
    </div>
    {showRaw && <pre className="sv2-raw">{events.map((event) => JSON.stringify(event)).join('\n')}</pre>}
  </>;
}
