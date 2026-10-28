import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEvent } from '@wrenyard/protocol/session';
import { agentRequest, useRemoteConnection } from '@/renderer/lib/desktop';
import { settingsQuery } from '@/renderer/lib/queries';
import { TODO_STATUS_LABEL } from '@/renderer/pages/todo/queries';
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

/** Persisted reading anchor: pinned to the tail or to one transcript entry. */
export type GroupTranscriptAnchor =
  | { mode: 'bottom' }
  | { mode: 'message'; seq: number; offsetPx: number };

export interface GroupTranscript {
  /** Canonical transcript entries in `seq` order, de-duplicated by sequence. */
  messages: readonly GroupMessage[];
  /** Last poll failure, cleared by the next successful page. */
  error: string | null;
  /** Whether the initial snapshot for the current endpoint identity was read. */
  ready: boolean;
  /** Whether older retained history exists before the loaded window. */
  hasMoreBefore: boolean;
  /** True while a backward history page is in flight. */
  loadingOlder: boolean;
  /** Whether live entries exist beyond the retained window's tail edge. */
  liveGap: boolean;
  /**
   * Monotonic counter bumped on every published tail resnapshot; lets the
   * view reset its bounded DOM window without watching message identity.
   */
  snapshotGen: number;
  /**
   * Fetch the next page now, e.g. right after a send, without waiting for the
   * timer. Resolves true only when the read (or live-gap resnapshot) actually
   * published a fresh snapshot; false on failure, so callers can gate UI
   * side effects like scrolling on real success.
   */
  refresh: () => Promise<boolean>;
  /** Prepend one older history page before the current earliest loaded seq. */
  loadOlder: () => void;
  /**
   * Resnapshot the newest tail window, closing any live gap. Resolves true
   * only after a real `latest` snapshot was published for this intent;
   * resolves false on failure or cancellation, never rejects.
   */
  jumpToLatest: () => Promise<boolean>;
  /** Persist the reading anchor; view state only, never publishes a snapshot. */
  setAnchor: (anchor: GroupTranscriptAnchor) => void;
  /** Read the persisted reading anchor. */
  getAnchor: () => GroupTranscriptAnchor;
}

/** Read one bounded transcript page after a sequence cursor. */
export function fetchGroupEvents(
  afterSeq: number,
  limit: number = GROUP_PAGE_LIMIT,
): Promise<AgentGroupEventsResult> {
  return agentRequest('agent.group.events', { afterSeq, limit });
}

/**
 * Read one bounded transcript page before a sequence cursor. The cursor is
 * exclusive: the newest entries with `seq < beforeSeq` are returned.
 */
export function fetchGroupEventsBefore(
  beforeSeq: number,
  limit: number = GROUP_PAGE_LIMIT,
): Promise<AgentGroupEventsResult> {
  return agentRequest('agent.group.events', { beforeSeq, limit });
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

/**
 * Trim `entry.messages` to the cap without evicting a persisted message
 * anchor. Overflow at the head is dropped only while the anchor stays inside
 * the retained window; when it would be evicted, the newest tail entries are
 * dropped instead so prepended history stays reachable. After any trim the
 * retained-first seq becomes `earliestSeq`, and `hasMoreBefore` stays true
 * whenever a dropped head range remains fetchable via `beforeSeq`.
 */
function retainWindow(entry: GroupTranscriptCacheEntry, fetchedHeadCount = 0): void {
  const anchor = entry.anchor;
  const protectedSeq = anchor.mode === 'message' ? anchor.seq : null;
  const headBefore = entry.messages.length === 0 ? null : entry.messages[0]!.seq;
  let messages = entry.messages;
  if (messages.length > GROUP_CACHE_MESSAGES) {
    let anchorIndex = messages.length - 1;
    if (protectedSeq !== null) {
      const found = messages.findIndex((message) => message.seq === protectedSeq);
      if (found !== -1) anchorIndex = found;
    }
    const overflow = messages.length - GROUP_CACHE_MESSAGES;
    if (fetchedHeadCount === 0 && overflow <= anchorIndex) {
      // Head-trim only when the dropped zone holds neither fetched entries
      // nor the anchor; the range stays refetchable via beforeSeq.
      messages = messages.slice(overflow);
      entry.messages = messages;
      entry.hasMoreBefore = true;
    } else if (anchorIndex < GROUP_CACHE_MESSAGES) {
      // Tail-trim: keep the fetched head page and the anchor, drop the
      // newest tail. Any dropped entry sits beyond the retained tail edge,
      // and dropped seqs are skipped by the cursor advance either way, so
      // the gap exists regardless of their relation to the old cursor; only
      // a fresh tail snapshot closes it.
      const dropped = messages.slice(GROUP_CACHE_MESSAGES);
      messages = messages.slice(0, GROUP_CACHE_MESSAGES);
      entry.messages = messages;
      if (dropped.length > 0) entry.liveGap = true;
    } else {
      // The anchor and the fetched head cannot coexist in one window: the
      // anchor wins and the dropped head stays refetchable via beforeSeq.
      messages = messages.slice(-GROUP_CACHE_MESSAGES);
      entry.messages = messages;
      entry.hasMoreBefore = true;
    }
  }
  const first = messages[0];
  // The retained-first seq is always the real backward edge; anything below
  // it was dropped but remains refetchable via the exclusive beforeSeq.
  entry.earliestSeq = first === undefined ? 0 : first.seq;
  // A trim that moved the retained head invalidates in-flight older pages.
  if (first !== undefined && first.seq !== headBefore) entry.windowGen += 1;
}

interface GroupTranscriptCacheEntry {
  messages: readonly GroupMessage[];
  /** Sequence cursor for the next incremental `afterSeq` page. */
  cursor: number;
  /** Whether the first snapshot for this identity completed successfully. */
  initialized: boolean;
  error: string | null;
  /** Persisted reading position; view state, not part of the published data. */
  anchor: GroupTranscriptAnchor;
  /** Lowest seq currently loaded in `messages`. */
  earliestSeq: number;
  /** Whether older retained history exists before `earliestSeq`. */
  hasMoreBefore: boolean;
  /** Single-flight guard for `beforeSeq` prepend requests. */
  loadingOlder: boolean;
  /** Whether live entries exist beyond the retained window's tail edge. */
  liveGap: boolean;
  /**
   * Monotonic window generation, bumped on every `latest` resnapshot and on
   * any trim/replace that moves the retained head. `loadOlder` fences its
   * reply against this so a stale page can never merge into a newer window.
   */
  windowGen: number;
  /** Count of published tail resnapshots; a view reset signal, not a fence. */
  snapshotGen: number;
}

/**
 * Transcript state lifted above GroupView so Activity resumes and
 * group↔private remounts rehydrate instead of reloading. Keyed by the remote
 * connection generation plus the active workspace identity, which changes on
 * workspace switch even though the daemon process and generation stay the
 * same. Stale keys are pruned on every lookup and results publish only while
 * their entry is still the current one, so a late response from a stale
 * generation or workspace can never surface on the current context.
 */
const groupTranscriptCache = new Map<string, GroupTranscriptCacheEntry>();

function groupTranscriptEntry(generation: number, workspaceId: string | null): GroupTranscriptCacheEntry {
  const key = `${generation}:${workspaceId ?? ''}`;
  for (const stale of groupTranscriptCache.keys()) {
    if (stale !== key) groupTranscriptCache.delete(stale);
  }
  let entry = groupTranscriptCache.get(key);
  if (entry === undefined) {
    entry = {
      messages: [],
      cursor: 0,
      initialized: false,
      error: null,
      anchor: { mode: 'bottom' },
      earliestSeq: 0,
      hasMoreBefore: false,
      loadingOlder: false,
      liveGap: false,
      windowGen: 0,
      snapshotGen: 0,
    };
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
  const settings = useQuery(settingsQuery);
  const workspacePath = settings.data?.service.workspace.path ?? null;
  const [messages, setMessages] = useState<readonly GroupMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [liveGap, setLiveGap] = useState(false);
  const [snapshotGen, setSnapshotGen] = useState(0);
  const refreshRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const loadOlderRef = useRef<() => void>(() => {});
  const jumpToLatestRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const anchorRef = useRef<GroupTranscriptAnchor>({ mode: 'bottom' });

  useEffect(() => {
    const key = `${connection.generation}:${workspacePath ?? ''}`;
    const entry = groupTranscriptEntry(connection.generation, workspacePath);
    anchorRef.current = entry.anchor;
    // Rehydrate synchronously from the cache; never clear on setup.
    setMessages(entry.messages);
    setError(entry.error);
    setReady(entry.initialized);
    setHasMoreBefore(entry.hasMoreBefore);
    setLoadingOlder(entry.loadingOlder);
    setLiveGap(entry.liveGap);
    setSnapshotGen(entry.snapshotGen);
    if (!enabled) {
      refreshRef.current = () => Promise.resolve(false);
      loadOlderRef.current = () => {};
      jumpToLatestRef.current = () => Promise.resolve(false);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    // Explicit latest intents arriving while a read is in flight coalesce
    // into one pending resnapshot; every queued Promise resolves with the
    // success flag after that single snapshot attempt settles.
    let pendingLatest: Array<(success: boolean) => void> | null = null;

    const publish = (): void => {
      if (cancelled || groupTranscriptCache.get(key) !== entry) return;
      setMessages(entry.messages);
      setError(entry.error);
      setReady(entry.initialized);
      setHasMoreBefore(entry.hasMoreBefore);
      setLoadingOlder(entry.loadingOlder);
      setLiveGap(entry.liveGap);
      setSnapshotGen(entry.snapshotGen);
    };

    /**
     * Atomic tail swap used for cold loads, explicit latest intents, and any
     * lost-continuation case. An automatic resnapshot triggered while the
     * reader is anchored on a message keeps the retained reading band: the
     * fetched tail is a disconnected newer range, so it is not spliced in;
     * the canonical cursor still advances to the snapshot high-water mark
     * and `liveGap` marks the new tail as reachable via explicit latest.
     */
    const resnapshot = async (automatic = false): Promise<void> => {
      const snap = await fetchGroupEventsLatest();
      if (cancelled) return;
      if (automatic && entry.anchor.mode === 'message') {
        entry.cursor = Math.max(entry.cursor, snap.latestSeq);
        entry.initialized = true;
        entry.error = null;
        entry.liveGap = true;
        retainWindow(entry);
        publish();
        return;
      }
      entry.messages = snap.messages.slice(-GROUP_CACHE_MESSAGES);
      entry.windowGen += 1;
      entry.snapshotGen += 1;
      entry.cursor = Math.max(snap.lastSeq, snap.latestSeq);
      entry.initialized = true;
      entry.error = null;
      entry.earliestSeq = entry.messages.length === 0 ? 0 : (snap.firstSeq > 0 ? snap.firstSeq : snap.earliestSeq);
      entry.hasMoreBefore = snap.hasMoreBefore;
      // A fresh tail snapshot always closes a live gap.
      entry.liveGap = false;
      retainWindow(entry);
      // A resnapshot that dropped the anchored entry resets the reading
      // position to the tail rather than pointing at vanished content.
      const anchor = entry.anchor;
      if (anchor.mode === 'message'
        && !entry.messages.some((message) => message.seq === anchor.seq)) {
        entry.anchor = { mode: 'bottom' };
        anchorRef.current = entry.anchor;
      }
      publish();
    };

    const poll = async (): Promise<boolean> => {
      if (cancelled || inFlight) return false;
      inFlight = true;
      const initial = !entry.initialized;
      try {
        if (initial) {
          await resnapshot();
        } else {
          // Catch-up pages accumulate privately and the burst commits once:
          // publishing each page would visibly replay backlog history in the
          // pinned viewport, so only the final coherent window is published.
          let burst: GroupMessage[] = [];
          let cursor = entry.cursor;
          let drained = false;
          for (let page = 0; page < GROUP_CATCH_UP_PAGES; page += 1) {
            const result = await fetchGroupEvents(cursor);
            if (cancelled) return false;
            if (result.latestSeq < cursor) {
              // Watermark rollback is a true epoch/cursor reset, not a
              // continuation gap: the old anchor and retained band belong to
              // a dead epoch, so discard them and fence any in-flight older
              // page before the replacement publishes — a stale beforeSeq
              // reply must never merge into the new window.
              entry.anchor = { mode: 'bottom' };
              anchorRef.current = entry.anchor;
              entry.windowGen += 1;
              await resnapshot();
              return !cancelled;
            }
            // A gap before the first returned entry is a same-epoch lost
            // continuation: keep the anchored band via resnapshot(true).
            if (result.messages.length > 0 && result.firstSeq > cursor + 1) {
              await resnapshot(true);
              return !cancelled;
            }
            burst = burst.concat(result.messages);
            cursor = Math.max(cursor, result.lastSeq);
            if (!result.hasMoreAfter) {
              drained = true;
              break;
            }
          }
          // A backlog still incomplete after the bounded burst resnapshots
          // once rather than visibly replaying intermediate history.
          if (!drained) {
            await resnapshot(true);
            return !cancelled;
          }
          // Once a live gap opens, incoming seqs are discontinuous with the
          // retained tail: keep advancing the cursor so nothing is missed,
          // but only a tail resnapshot appends again.
          if (!entry.liveGap && burst.length > 0) {
            const last = entry.messages.length === 0 ? 0 : entry.messages[entry.messages.length - 1]!.seq;
            const additions = burst.filter((message) => message.seq > last);
            if (additions.length > 0) {
              entry.messages = [...entry.messages, ...additions];
              retainWindow(entry, 0);
            }
          }
          entry.cursor = Math.max(entry.cursor, cursor);
          entry.error = null;
        }
        if (cancelled) return false;
        entry.error = null;
        publish();
        return true;
      } catch (cause) {
        if (!cancelled) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          publish();
        }
        return false;
      } finally {
        inFlight = false;
        void runPendingLatest();
      }
    };

    /** Prepend one older history page; never touches the live `cursor`. */
    const loadOlder = async (): Promise<void> => {
      if (cancelled || !entry.initialized || !entry.hasMoreBefore || entry.loadingOlder) return;
      entry.loadingOlder = true;
      // Fence the reply against window mutations: a resnapshot or a head
      // trim while the request flies makes the result's relative position
      // unknowable, so it must be dropped rather than merged.
      const gen = entry.windowGen;
      publish();
      try {
        const result = await fetchGroupEventsBefore(entry.earliestSeq);
        if (cancelled) return;
        // Contiguity: the page must end immediately before the retained
        // head. A gap means part of the range was trimmed or the window was
        // replaced; merging would splice discontinuous history together, so
        // the whole reply is discarded and `hasMoreBefore` stays true — the
        // range remains fetchable via the exclusive beforeSeq.
        const headSeq = entry.messages.length === 0 ? null : entry.messages[0]!.seq;
        if (entry.windowGen !== gen || headSeq === null || result.lastSeq + 1 !== headSeq) {
          entry.hasMoreBefore = true;
          return;
        }
        const first = result.firstSeq > 0 ? result.firstSeq : result.earliestSeq;
        if (first > 0) {
          entry.earliestSeq = entry.earliestSeq === 0
            ? first
            : Math.min(entry.earliestSeq, first);
        }
        entry.hasMoreBefore = result.hasMoreBefore;
        const known = new Set(entry.messages.map((message) => message.seq));
        const additions = result.messages.filter((message) => !known.has(message.seq));
        if (additions.length > 0) {
          // A contiguous reply stays contiguous after a dedupe union only
          // when the union's head-to-tail ordering still joins; since the
          // reply ends at headSeq - 1, dedupe can only drop its own entries
          // already present at the head, which keeps the merge contiguous.
          const merged = [...additions, ...entry.messages];
          if (merged.length < 2
            || merged.every((message, index) => index === 0 || message.seq > merged[index - 1]!.seq)) {
            entry.messages = merged;
            // The fetched page is protected head: pass its size so the
            // normal case keeps the whole page inside the retained window.
            retainWindow(entry, additions.length);
          }
        }
        entry.error = null;
      } catch (cause) {
        if (!cancelled) entry.error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (!cancelled) {
          entry.loadingOlder = false;
          publish();
        }
      }
    };

    /**
     * One atomic tail resnapshot that closes a live gap, single-flight.
     * Reports real success: resolves true only after a `latest` snapshot was
     * actually published for this intent; resolves false when cancelled or
     * the fetch failed — the error is published through `entry.error` while
     * messages, anchor, liveGap and unread state stay untouched, so callers
     * must gate scrolling or indicator clearing on `=== true`. Never
     * rejects, so click and send paths cannot produce unhandled rejections.
     */
    const runLatest = async (): Promise<boolean> => {
      inFlight = true;
      try {
        await resnapshot();
        return !cancelled;
      } catch (cause) {
        if (!cancelled) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          publish();
        }
        return false;
      } finally {
        inFlight = false;
        // Intents queued while this resnapshot ran drain into one follow-up.
        void runPendingLatest();
      }
    };

    const runPendingLatest = async (): Promise<void> => {
      if (cancelled || inFlight || pendingLatest === null) return;
      const waiters = pendingLatest;
      pendingLatest = null;
      const success = await runLatest();
      for (const resolve of waiters) resolve(success);
    };

    const requestLatest = (): Promise<boolean> => {
      if (cancelled || !entry.initialized) return Promise.resolve(false);
      if (inFlight) {
        return new Promise<boolean>((resolve) => {
          if (pendingLatest === null) pendingLatest = [];
          pendingLatest.push(resolve);
        });
      }
      return runLatest();
    };

    // A refresh while a live gap is open resnapshots the tail instead of
    // polling into a discontinuous window; a pending latest intent queued
    // behind the current poll is still honored once the poll settles.
    refreshRef.current = () => (entry.liveGap ? requestLatest() : poll());
    loadOlderRef.current = () => { void loadOlder(); };
    jumpToLatestRef.current = requestLatest;
    void poll();
    const timer = window.setInterval(() => { void poll(); }, GROUP_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = () => Promise.resolve(false);
      loadOlderRef.current = () => {};
      jumpToLatestRef.current = () => Promise.resolve(false);
      window.clearInterval(timer);
    };
  }, [enabled, connection.state, connection.generation, workspacePath]);

  return {
    messages,
    error,
    ready,
    hasMoreBefore,
    loadingOlder,
    liveGap,
    snapshotGen,
    refresh: () => refreshRef.current(),
    loadOlder: () => { loadOlderRef.current(); },
    jumpToLatest: () => jumpToLatestRef.current(),
    setAnchor: (anchor) => {
      const entry = groupTranscriptEntry(connection.generation, workspacePath);
      entry.anchor = anchor;
      anchorRef.current = anchor;
    },
    getAnchor: () => anchorRef.current,
  };
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
  if (rule.startsWith('status:')) return `状态变为 ${TODO_STATUS_LABEL[rule.slice(7) as keyof typeof TODO_STATUS_LABEL] ?? rule.slice(7)}`;
  if (rule.startsWith('+')) return `添加标签 ${rule.slice(1)}`;
  if (rule.startsWith('-')) return `移除标签 ${rule.slice(1)}`;
  return rule;
}

