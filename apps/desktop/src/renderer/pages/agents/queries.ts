import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEvent } from '@wrenyard/session';
import { agentRequest, useRemoteConnection } from '@/renderer/lib/desktop';
import type { RoutineCreateParams, RoutineDeliver, RoutineState, RoutineUpdateParams } from '@/shell-contract';

/**
 * Agent projections are only meaningful while an endpoint is committed: a
 * switch in progress or a lost remote tunnel would otherwise poll the wrong
 * daemon.
 */
function useAgentEnabled(): boolean {
  const connection = useRemoteConnection();
  return connection.state === 'local' || connection.state === 'remote';
}

/** Cache keys for the agents projections; the mutations invalidate these. */
export const agentKeys = {
  list: ['agents', 'list'] as const,
  config: (id: string) => ['agents', 'config', id] as const,
  routines: (botId: string) => ['agents', 'routines', botId] as const,
};

/** Polled bot list; the daemon kernel owns config loading and wake queues. */
export function useAgentsQuery() {
  const enabled = useAgentEnabled();
  return useQuery({
    queryKey: agentKeys.list,
    queryFn: () => agentRequest('agent.list'),
    refetchInterval: 3000,
    enabled,
  });
}

/** Raw config file text of one bot, refetched when the bot changes. */
export function useAgentConfigQuery(id: string | null) {
  const enabled = useAgentEnabled();
  return useQuery({
    queryKey: agentKeys.config(id ?? ''),
    queryFn: async () => {
      if (id === null) throw new Error('no bot selected');
      return agentRequest('agent.get', { id });
    },
    enabled: enabled && id !== null,
    retry: false,
  });
}

/** Polled routine list of one bot. An absent botId keeps the query idle. */
export function useRoutinesQuery(botId: string | null) {
  const enabled = useAgentEnabled();
  return useQuery({
    queryKey: agentKeys.routines(botId ?? ''),
    queryFn: async () => {
      if (botId === null) return { routines: [] };
      return agentRequest('routine.list', { botId });
    },
    refetchInterval: 5000,
    enabled: enabled && botId !== null,
  });
}

/** Invalidate the agent projections after a mutation so they refetch. */
function useAgentInvalidator(): () => void {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: ['agents'] }); };
}

/** Wake one bot with the composer text; the queue count returns in the result. */
export function useWakeMutation() {
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => agentRequest('agent.wake', { id, text }),
  });
}

/** Create one routine owned by the selected bot. */
export function useCreateRoutineMutation() {
  const invalidate = useAgentInvalidator();
  return useMutation({
    mutationFn: (params: RoutineCreateParams) => agentRequest('routine.create', params),
    onSuccess: invalidate,
  });
}

/** Pause or resume one routine. */
export function useUpdateRoutineMutation() {
  const invalidate = useAgentInvalidator();
  return useMutation({
    mutationFn: (params: RoutineUpdateParams) => agentRequest('routine.update', params),
    onSuccess: invalidate,
  });
}

/** Fire one routine immediately. */
export function useRunRoutineMutation() {
  const invalidate = useAgentInvalidator();
  return useMutation({
    mutationFn: (id: string) => agentRequest('routine.run', { id }),
    onSuccess: invalidate,
  });
}

/** Delete one routine. */
export function useDeleteRoutineMutation() {
  const invalidate = useAgentInvalidator();
  return useMutation({
    mutationFn: (id: string) => agentRequest('routine.delete', { id }),
    onSuccess: invalidate,
  });
}

/**
 * Accumulating poll of one bot's context ledger: every 2 s it fetches the
 * events after the last seen sequence and appends them. The accumulated list
 * resets whenever the selected bot changes.
 */
export function useAgentEvents(id: string | null): readonly LedgerEvent[] {
  const enabled = useAgentEnabled();
  const [events, setEvents] = useState<readonly LedgerEvent[]>([]);
  const afterSeqRef = useRef(0);

  useEffect(() => {
    setEvents([]);
    afterSeqRef.current = 0;
    if (id === null || !enabled) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const page = await agentRequest('agent.events', { id, afterSeq: afterSeqRef.current });
        if (cancelled) return;
        if (page.events.length > 0) {
          afterSeqRef.current = page.events[page.events.length - 1]!.seq;
          setEvents((previous) => [...previous, ...page.events]);
        }
      } catch {
        // The bot may not have a context session yet; retry on the next tick.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, enabled]);

  return events;
}

/** Chinese label and tone of every routine state. */
export const ROUTINE_STATE_VIEW: Record<RoutineState, { label: string; tone: 'running' | 'success' | 'danger' | 'warning' | 'muted' }> = {
  active: { label: '运行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'muted' },
  finished: { label: '已完成', tone: 'muted' },
  failed: { label: '失败', tone: 'danger' },
};

/** `每 N 分钟` for a recurring routine; `N 分钟后一次` for a one-shot. */
export function frequencyText(intervalMinutes: number, recurring: boolean): string {
  const unit = intervalMinutes % 1440 === 0 ? `${intervalMinutes / 1440} 天`
    : intervalMinutes % 60 === 0 ? `${intervalMinutes / 60} 小时`
      : `${intervalMinutes} 分钟`;
  return recurring ? `每 ${unit}` : `${unit}后一次`;
}

/** Display text of a routine deliver target. */
export function deliverText(deliver: RoutineDeliver): string {
  return deliver === 'none' ? '不投递' : deliver.slice('bot:'.length);
}
