import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEvent } from '@wrenyard/protocol/session';
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
/** Cold-load/resnapshot tail window; the contract caps a request at 500 entries. */
const GROUP_SNAPSHOT_LIMIT = 500;
/** Transcript entries retained per endpoint identity; older ones are trimmed. */
const GROUP_CACHE_MESSAGES = 1000;
/** The transcript poll; replies land through the daemon, never by local replay. */
const GROUP_POLL_MS = 1000;

export interface GroupTranscript {
  /** Canonical transcript entries in `seq` order, de-duplicated by sequence. */
  messages: readonly GroupMessage[];
  /** Last poll failure, cleared by the next successful page. */
  error: string | null;
  /** Whether the initial snapshot for the current endpoint identity was read. */
  ready: boolean;
  /** True while an incremental poll is in flight after `ready` was reached. */
  refreshing: boolean;
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
 * Read the newest transcript window in one request. The `afterSeq`,
 * `beforeSeq` and `latest` parameter modes are mutually exclusive.
 */
export function fetchGroupEventsLatest(
  limit: number = GROUP_SNAPSHOT_LIMIT,
): Promise<AgentGroupEventsResult> {
  return agentRequest('agent.group.events', { latest: true, limit });
}

interface GroupTranscriptCacheEntry {
  messages: readonly GroupMessage[];
  /** Sequence cursor for the next incremental `afterSeq` page. */
  cursor: number;
  /** Whether the first snapshot for this identity completed successfully. */
  initialized: boolean;
  error: string | null;
}

/**
 * Transcript state lifted above GroupView so Activity resumes and
 * group↔private remounts rehydrate instead of reloading. Keyed by the remote
 * connection generation, which already changes whenever the committed
 * endpoint/host does, so it fully identifies the transcript's endpoint; there
 * is a single group transcript per endpoint, so no group id is needed. Stale
 * keys are pruned on every lookup and results publish only while their entry
 * is still the current one, so a late response from a stale generation can
 * never surface on a new connection.
 */
const groupTranscriptCache = new Map<string, GroupTranscriptCacheEntry>();

function groupTranscriptEntry(generation: number): GroupTranscriptCacheEntry {
  const key = `${generation}`;
  for (const stale of groupTranscriptCache.keys()) {
    if (stale !== key) groupTranscriptCache.delete(stale);
  }
  let entry = groupTranscriptCache.get(key);
  if (entry === undefined) {
    entry = { messages: [], cursor: 0, initialized: false, error: null };
    groupTranscriptCache.set(key, entry);
  }
  return entry;
}

/**
 * Poll the daemon's persistent group transcript. The first load for an
 * endpoint identity is a single `latest` tail snapshot; remounts synchronously
 * rehydrate messages and the cursor from the module-level cache and resume
 * with incremental `afterSeq` pages, so no history is ever replayed. A
 * rollback of the daemon's latest seq, a gap before the first returned entry,
 * or a backlog still incomplete after the bounded catch-up burst all trigger
 * one atomic tail resnapshot instead of paging through lost history. Polling
 * is single-flight and stops while hidden via the Activity effect lifecycle.
 */
export function useGroupEvents(): GroupTranscript {
  const connection = useRemoteConnection();
  const enabled = useAgentEnabled();
  const [messages, setMessages] = useState<readonly GroupMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    const key = `${connection.generation}`;
    const entry = groupTranscriptEntry(connection.generation);
    // Rehydrate synchronously from the cache; never clear on setup.
    setMessages(entry.messages);
    setError(entry.error);
    setReady(entry.initialized);
    setRefreshing(false);
    if (!enabled) {
      refreshRef.current = () => {};
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const publish = (): void => {
      if (cancelled || groupTranscriptCache.get(key) !== entry) return;
      setMessages(entry.messages);
      setError(entry.error);
      setReady(entry.initialized);
    };

    /** Atomic tail swap used for cold loads and for any lost-continuation case. */
    const resnapshot = async (): Promise<void> => {
      const snap = await fetchGroupEventsLatest();
      if (cancelled) return;
      entry.messages = snap.messages.slice(-GROUP_CACHE_MESSAGES);
      entry.cursor = Math.max(snap.lastSeq, snap.latestSeq);
      entry.initialized = true;
      entry.error = null;
      publish();
    };

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const initial = !entry.initialized;
      if (!initial) setRefreshing(true);
      try {
        if (initial) {
          await resnapshot();
        } else {
          let backlogRemaining = false;
          for (let page = 0; page < GROUP_CATCH_UP_PAGES; page += 1) {
            const before = entry.cursor;
            const result = await fetchGroupEvents(before);
            if (cancelled) return;
            // Watermark rollback or a gap before the first returned entry
            // means the continuation window was lost: resnapshot atomically.
            const gap = result.messages.length > 0 && result.firstSeq > before + 1;
            if (result.latestSeq < before || gap) {
              await resnapshot();
              return;
            }
            const last = entry.messages.length === 0 ? 0 : entry.messages[entry.messages.length - 1]!.seq;
            const additions = result.messages.filter((message) => message.seq > last);
            if (additions.length > 0) {
              entry.messages = [...entry.messages, ...additions].slice(-GROUP_CACHE_MESSAGES);
            }
            entry.cursor = Math.max(before, result.lastSeq);
            entry.error = null;
            backlogRemaining = result.hasMoreAfter;
            publish();
            if (!result.hasMoreAfter) break;
          }
          // A backlog still incomplete after the bounded burst resnapshots
          // once rather than visibly replaying intermediate history.
          if (!cancelled && backlogRemaining) {
            await resnapshot();
            return;
          }
        }
        if (cancelled) return;
        entry.error = null;
        publish();
      } catch (cause) {
        if (!cancelled) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          publish();
        }
      } finally {
        inFlight = false;
        if (!cancelled) setRefreshing(false);
      }
    };

    refreshRef.current = () => { void poll(); };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, GROUP_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = () => {};
      window.clearInterval(timer);
      setRefreshing(false);
    };
  }, [enabled, connection.state, connection.generation]);

  return { messages, error, ready, refreshing, refresh: () => { refreshRef.current(); } };
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
export function frequencyText(intervalMinutes?: number, on?: string, match?: string[]): string {
  if (on === 'todo') return `待办事件：${(match ?? []).map(todoMatchText).join('、')}`;
  if (intervalMinutes === undefined) return '未设置触发条件';
  const unit = intervalMinutes % 1440 === 0 ? `${intervalMinutes / 1440} 天`
    : intervalMinutes % 60 === 0 ? `${intervalMinutes / 60} 小时`
      : `${intervalMinutes} 分钟`;
  return `每 ${unit}`;
}

function todoMatchText(rule: string): string {
  if (rule === 'comment') return '新增评论';
  if (rule.startsWith('status:')) return `状态变为 ${{ open: '未开始', in_progress: '进行中', done: '已完成', cancelled: '已取消' }[rule.slice(7)] ?? rule.slice(7)}`;
  if (rule.startsWith('+')) return `添加标签 ${rule.slice(1)}`;
  if (rule.startsWith('-')) return `移除标签 ${rule.slice(1)}`;
  return rule;
}

