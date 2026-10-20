import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEvent } from '@wrenyard/session';
import { agentRequest, useRemoteConnection } from '@/renderer/lib/desktop';
import type {
  AgentCreateParams,
  AgentGroupEventsResult,
  AgentMemoryFile,
  GroupMessage,
  RoutineCreateParams,
  RoutineState,
  RoutineUpdateParams,
} from '@/shell-contract';

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
  memory: (id: string) => ['agents', 'memory', id] as const,
  routines: ['agents', 'routines'] as const,
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

/**
 * Read-only memory listing of one bot, for the settings view. It is a separate
 * query from the config so a memory change refetches the listing alone.
 */
export function useAgentMemoryQuery(id: string | null) {
  const enabled = useAgentEnabled();
  return useQuery({
    queryKey: agentKeys.memory(id ?? ''),
    queryFn: async (): Promise<AgentMemoryFile[]> => {
      if (id === null) throw new Error('no bot selected');
      const result = await agentRequest('agent.memory.list', { id });
      return result.files;
    },
    enabled: enabled && id !== null,
    retry: false,
  });
}

/** Polled routine list of all bots; callers filter the items by botId. */
export function useRoutinesQuery() {
  const enabled = useAgentEnabled();
  return useQuery({
    queryKey: agentKeys.routines,
    queryFn: async () => {
      return agentRequest('routine.list', {});
    },
    refetchInterval: 5000,
    enabled,
  });
}

/** Invalidate the agent projections after a mutation so they refetch. */
function useAgentInvalidator(): () => void {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: ['agents'] }); };
}

/**
 * Create one bot from the built-in onboard template. The daemon owns the id
 * check across both definition roots, so a clash surfaces as this mutation's
 * error rather than a local guess.
 */
export function useCreateAgentMutation() {
  const invalidate = useAgentInvalidator();
  return useMutation({
    mutationFn: (params: AgentCreateParams) => agentRequest('agent.create', params),
    onSuccess: invalidate,
  });
}

/** Wake one bot with the composer text; the queue count returns in the result. */
export function useWakeMutation() {
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => agentRequest('agent.wake', { id, text }),
  });
}

/* ------------------------------------------------------------------ */
/* Shared group transcript                                             */
/* ------------------------------------------------------------------ */

/** One catch-up page; the daemon caps the page size at 500 entries. */
const GROUP_PAGE_LIMIT = 200;
/** Bounded catch-up burst: a long absence appends at most this many pages per tick. */
const GROUP_CATCH_UP_PAGES = 5;
/** The transcript poll; replies land through the daemon, never by local replay. */
const GROUP_POLL_MS = 1000;

export interface GroupTranscript {
  /** Canonical transcript entries in `seq` order, de-duplicated by sequence. */
  messages: readonly GroupMessage[];
  /** Last poll failure, cleared by the next successful page. */
  error: string | null;
  /** Whether at least one page has been read since the endpoint was committed. */
  ready: boolean;
  /** Fetch the next page now, e.g. right after a send, without waiting for the timer. */
  refresh: () => void;
}

/** Read one bounded transcript page after a sequence cursor. */
export function fetchGroupEvents(
  afterSeq: number,
  limit: number = GROUP_PAGE_LIMIT,
): Promise<AgentGroupEventsResult> {
  return agentRequest('agent.group.events', { afterSeq, limit });
}

/**
 * Poll the daemon's persistent group transcript with a sequence cursor. Every
 * tick catches up through consecutive pages, appends entries in order and drops
 * anything at or below the last seen sequence, so a repeated or late page can
 * never duplicate a message. A serialized in-flight guard and a per-effect
 * cancellation token keep a slow request from overlapping the next tick or
 * arriving after a bot/endpoint switch or unmount.
 */
export function useGroupEvents(): GroupTranscript {
  const connection = useRemoteConnection();
  const enabled = useAgentEnabled();
  const [messages, setMessages] = useState<readonly GroupMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const cursorRef = useRef(0);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setMessages([]);
    setError(null);
    setReady(false);
    cursorRef.current = 0;
    if (!enabled) {
      refreshRef.current = () => {};
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        for (let page = 0; page < GROUP_CATCH_UP_PAGES; page += 1) {
          const before = cursorRef.current;
          const result = await fetchGroupEvents(before);
          if (cancelled) return;
          cursorRef.current = Math.max(before, result.lastSeq);
          setMessages((previous) => {
            const last = previous.length === 0 ? 0 : previous[previous.length - 1]!.seq;
            const additions = result.messages.filter((message) => message.seq > last);
            return additions.length === 0 ? previous : [...previous, ...additions];
          });
          // Stop when the page was short or the cursor did not advance.
          if (result.messages.length < GROUP_PAGE_LIMIT || result.lastSeq <= before) break;
        }
        if (cancelled) return;
        setReady(true);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    };

    refreshRef.current = () => { void poll(); };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, GROUP_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      window.clearInterval(timer);
    };
  }, [enabled, connection.state, connection.generation]);

  return { messages, error, ready, refresh: () => { refreshRef.current(); } };
}

/**
 * Post one user entry to the group. The daemon publishes it once and wakes
 * mentioned bots; the returned `awakened` list is the only success signal the
 * UI reports, so an unknown or disabled mention never looks like a wake.
 */
export function useGroupSendMutation() {
  return useMutation({
    mutationFn: (text: string) => agentRequest('agent.group.send', { text }),
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
};

/** `每 N 分钟` for a routine. */
export function frequencyText(intervalMinutes: number): string {
  const unit = intervalMinutes % 1440 === 0 ? `${intervalMinutes / 1440} 天`
    : intervalMinutes % 60 === 0 ? `${intervalMinutes / 60} 小时`
      : `${intervalMinutes} 分钟`;
  return `每 ${unit}`;
}

