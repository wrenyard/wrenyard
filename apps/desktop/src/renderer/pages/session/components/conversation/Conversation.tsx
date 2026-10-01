import { useEffect, useRef } from 'react';
import { notify } from '@/renderer/lib/notify';
import type { TurnModel, TurnStatus } from '../../model/types.js';

export interface ConversationProps {
  /** Active session key (`'draft'` for a new session). */
  sessionKey: string;
  turns: readonly TurnModel[];
  /** True once the ledger has finished loading; history is not trusted before. */
  ready: boolean;
}

function isTerminal(status: TurnStatus): boolean {
  return status !== 'running';
}

/**
 * Conversation completion observer. It renders nothing; it watches the folded
 * turns and emits one `sessionReplyCompleted` notification per newly observed
 * completed turn. The first snapshot after the ledger loads is adopted as the
 * baseline, so cold history never replays a burst of notifications. The
 * notification-center preference gate decides whether the event is recorded.
 */
export function Conversation({ sessionKey, turns, ready }: ConversationProps) {
  const observed = useRef<{ key: string; terminal: Set<number> }>({ key: sessionKey, terminal: new Set() });
  const primed = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (observed.current.key !== sessionKey) {
      observed.current = { key: sessionKey, terminal: new Set() };
      primed.current = false;
    }
    // Adopt already-terminal history as the baseline without notifying; turns
    // still running are left untracked so their completion is reported.
    if (!primed.current) {
      primed.current = true;
      for (const turn of turns) if (isTerminal(turn.status)) observed.current.terminal.add(turn.id);
      return;
    }
    for (const turn of turns) {
      if (turn.status !== 'completed' || observed.current.terminal.has(turn.id)) continue;
      observed.current.terminal.add(turn.id);
      notify({
        id: `session-reply-completed:${sessionKey}:${turn.id}`,
        level: 'success',
        source: 'session',
        title: '会话回复完成',
        description: `${turn.model.provider}/${turn.model.model}`,
        action: { label: '查看', command: { id: 'session.open', args: { sessionId: sessionKey } } },
      });
    }
  }, [sessionKey, turns, ready]);

  return null;
}
