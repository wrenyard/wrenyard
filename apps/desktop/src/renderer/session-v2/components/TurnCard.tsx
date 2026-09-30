import { useEffect, useMemo, useState } from 'react';
import { formatDuration, statusLabel, turnStats } from '../ledger-view.js';
import type { LedgerEvent, TurnView } from '../types.js';
import { CycleDetails } from './CycleDetails.js';
import { Details } from './Details.js';

function ElapsedTime({ start, end }: { start: string; end?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (end) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [end]);
  return <span>{formatDuration(start, end, now)}</span>;
}

export function TurnCard({ turn, onInterrupt }: { turn: TurnView; onInterrupt(turn: number): void }) {
  const cycles = useMemo(() => {
    const groups = new Map<number, LedgerEvent[]>();
    for (const event of turn.events) {
      const cycle = event.cycle ?? 0;
      const group = groups.get(cycle) ?? [];
      group.push(event);
      groups.set(cycle, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b);
  }, [turn.events]);
  const label = <>
    {turn.status ? statusLabel(turn.status) : turn.phase} · {turn.cycle}/10 · <ElapsedTime start={turn.started} end={turn.ended} />
    {turn.progress && <p>{turn.progress}</p>}
  </>;
  return <article className="sv2-turn">
    <div className="sv2-user">
      <pre>{turn.user}</pre>
      {!turn.status && <button type="button" onClick={() => onInterrupt(turn.id)}>中断</button>}
    </div>
    <Details label={label}>
      {cycles.map(([cycle, events]) => <CycleDetails key={cycle} cycle={cycle} events={events} interrupted={turn.status === 'interrupted'} />)}
    </Details>
    {turn.final !== undefined ? <div className="sv2-final"><pre>{turn.final}</pre><small>{turnStats(turn)}</small></div>
      : turn.status && <small>{turnStats(turn)}</small>}
  </article>;
}
