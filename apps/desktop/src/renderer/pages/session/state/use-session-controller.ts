import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  initialSessionPageState,
  mergeEvents,
  sessionReducer,
  type SessionPageState,
} from './session-reducer.js';
import {
  dropRecentSession,
  readRecentSession,
  writeRecentSession,
  type RecentSessionSlice,
} from './recent-session-cache.js';
import type { AttachmentInput, DraftAttachment, LedgerEvent, ModelEntry, SessionApi, SessionBridgeTaskBrief } from '../model/types.js';
import type { ReasoningEffort } from './reasoning-effort.js';
import { clearDraft, clearDraftAttachments } from './drafts.js';
import { mini, miniSession } from '@/renderer/lib/mini';
import { preferencesQuery } from '@/renderer/lib/queries';
import { SESSION_STATUS_FILTER_DEFAULT, type SessionStatusFilter } from '@/shell-contract';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
let localSeq = 0;
/** Model availability is re-read on this interval while a session is mounted. */
const MODELS_REFRESH_MS = 15_000;

/** Recalibrates the open ledger while a turn looks running, so a dropped final turn.finished cannot leave a stale running row. */
const LEDGER_RESYNC_MS = 15_000;

/**
 * The open turn of a ledger snapshot: the last `turn.started` with no later
 * `turn.finished` or `turn.interrupted` for the same turn number.
 */
function openTurnOf(events: readonly LedgerEvent[]): number | null {
  const closed = new Set<number>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.turn === undefined) continue;
    if (event.type === 'turn.finished' || event.type === 'turn.interrupted') closed.add(event.turn);
    else if (event.type === 'turn.started' && !closed.has(event.turn)) return event.turn;
  }
  return null;
}

/** Tail sequence of a ledger view; 0 when it holds no events. */
function lastSeqOf(events: readonly LedgerEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

/**
 * Whether a read that started at `afterSeq` continues the held tail: an empty
 * page means nothing was appended, otherwise the first event must be the very
 * next sequence. A later start leaves an unseen hole, and a last sequence at or
 * below the held tail means the daemon rewound behind the view we hold.
 */
function continuesLedger(events: readonly LedgerEvent[], afterSeq: number): boolean {
  if (events.length === 0) return true;
  const first = events[0]!.seq;
  const last = events[events.length - 1]!.seq;
  return first <= afterSeq + 1 && last > afterSeq;
}

/** Whether a session survives under the persisted Status filter. */
function matchesStatusFilter(session: { archived?: boolean }, filter: SessionStatusFilter): boolean {
  if (filter === 'archived') return session.archived === true;
  if (filter === 'all') return true;
  return session.archived !== true;
}

/**
 * Strips renderer-only fields (`id`, `bytes`, `preview`, `staged`) before a
 * send: the daemon attachment schema accepts only `path`/`name`/`dataUrl`.
 */
function toAttachmentInputs(attachments: readonly DraftAttachment[]): AttachmentInput[] {
  const inputs: AttachmentInput[] = [];
  for (const attachment of attachments) {
    if (attachment.dataUrl !== undefined && attachment.dataUrl !== '') {
      inputs.push({ dataUrl: attachment.dataUrl, ...(attachment.name === undefined ? {} : { name: attachment.name }) });
    } else if (attachment.path !== undefined && attachment.path !== '') {
      inputs.push({ path: attachment.path, ...(attachment.name === undefined ? {} : { name: attachment.name }) });
    }
  }
  return inputs;
}

/**
 * A card is opened for one session, so its first frame already carries that
 * identity — and an existing session starts in the loading state instead of as
 * an empty draft. The main window starts on a draft until the shell or the
 * session list selects one.
 */
const initialSelectedId = mini ? miniSession : '';
const initialSessionState: SessionPageState = {
  ...initialSessionPageState,
  selectedId: initialSelectedId,
  loadingLedger: initialSelectedId !== '',
};

export interface SessionController {
  state: SessionPageState;
  selectSession(sessionId: string): Promise<void>;
  newDraft(): void;
  sendMessage(text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, fast: boolean | undefined, attachments: DraftAttachment[]): Promise<void>;
  interruptTurn(turn: number): Promise<void>;
  cancelTask(taskRunId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  removePending(localId: string): void;
  setTasks(tasks: Record<string, SessionBridgeTaskBrief>): void;
  clearError(): void;
}

/** Owns selection, ledger merging, optimistic turns and interrupt requests. */
export function useSessionController(api: SessionApi) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  // Latest committed view, read when a ledger response is folded back into the
  // recent-session cache without re-subscribing the controller.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const alive = useRef(false);
  const selected = useRef(initialSelectedId);
  const selectionVersion = useRef(0);
  // Highest ledger seq applied for the open session; used to detect a gap in
  // pushed events that would leave a finished turn stuck on the running row.
  const highestSeq = useRef(0);
  // Open (not yet finished) turn number for the selected session, tracked so
  // the calibration interval only resyncs while a turn looks running.
  const openTurn = useRef<number | null>(null);
  const resyncInFlight = useRef(false);
  const listVersion = useRef(0);
  const creation = useRef<Promise<string> | null>(null);
  const preferences = useQuery(preferencesQuery);
  const statusFilter = preferences.data?.session.statusFilter ?? SESSION_STATUS_FILTER_DEFAULT;

  const reportError = useCallback((error: unknown, sessionId?: string, loading?: 'list' | 'ledger') => {
    if (alive.current) dispatch({ type: 'error', message: messageOf(error), sessionId, loading });
  }, []);

  /**
   * Fold one ledger read into the view and refresh the cached slice. The
   * response may be only the delta after a cached tail while pushed events
   * have already reached the reducer, so all three are merged by sequence.
   */
  const applyLedger = useCallback((
    sessionId: string,
    response: LedgerEvent[],
    cached: RecentSessionSlice | undefined,
  ): void => {
    const view = stateRef.current.selectedId === sessionId ? stateRef.current : undefined;
    const held = mergeEvents(cached?.events ?? [], view?.events ?? []);
    const events = mergeEvents(held, response);
    const lastSeq = lastSeqOf(events);
    highestSeq.current = Math.max(highestSeq.current, lastSeq);
    openTurn.current = openTurnOf(events);
    dispatch({ type: 'events', sessionId, events: response, snapshot: true });
    writeRecentSession(sessionId, {
      events,
      live: view?.live ?? cached?.live ?? [],
      tasks: view?.tasks ?? cached?.tasks ?? {},
      pending: view?.pending ?? cached?.pending ?? [],
      interrupting: view?.interrupting ?? cached?.interrupting ?? [],
      lastSeq,
    });
  }, []);

  const selectSession = useCallback(async (sessionId: string): Promise<void> => {
    const version = ++selectionVersion.current;
    const sameSession = selected.current === sessionId;
    selected.current = sessionId;
    // A recently opened session restores its cached conversation and asks only
    // for the delta; a first open still drains the whole ledger from zero.
    const cached = sameSession ? undefined : readRecentSession(sessionId);
    if (cached !== undefined) {
      highestSeq.current = cached.lastSeq;
      openTurn.current = openTurnOf(cached.events);
    } else if (!sameSession) {
      highestSeq.current = 0;
      openTurn.current = null;
    }
    dispatch(cached === undefined
      ? { type: 'select', sessionId }
      : { type: 'restore', sessionId, slice: cached });
    const afterSeq = highestSeq.current;
    try {
      let response = await api.ledger(sessionId, afterSeq === 0 ? undefined : afterSeq);
      if (afterSeq > 0 && !continuesLedger(response, afterSeq)) {
        // The cached tail is not a prefix of the daemon ledger: forget the
        // entry and drain the whole history once from zero.
        dropRecentSession(sessionId);
        response = await api.ledger(sessionId);
      }
      if (alive.current && version === selectionVersion.current) applyLedger(sessionId, response, cached);
    } catch (error) {
      if (version === selectionVersion.current) reportError(error, sessionId, 'ledger');
      throw error;
    }
  }, [api, reportError, applyLedger]);

  // Terminal-state calibration: refetch the open ledger for the open session
  // and re-apply it, so a missed push or reconnect converges the view back to
  // the daemon ledger. Only the events after the held tail are read.
  const resyncLedger = useCallback(async (): Promise<void> => {
    const sessionId = selected.current;
    if (!sessionId || resyncInFlight.current) return;
    const version = selectionVersion.current;
    const afterSeq = highestSeq.current;
    resyncInFlight.current = true;
    try {
      let response = await api.ledger(sessionId, afterSeq === 0 ? undefined : afterSeq);
      if (afterSeq > 0 && !continuesLedger(response, afterSeq)) {
        dropRecentSession(sessionId);
        response = await api.ledger(sessionId);
      }
      if (alive.current && version === selectionVersion.current) applyLedger(sessionId, response, undefined);
    } catch {
      // Resync is best-effort calibration; the next focus or gap retries.
    } finally {
      resyncInFlight.current = false;
    }
  }, [api, applyLedger]);

  const refreshList = useCallback(async () => {
    const version = ++listVersion.current;
    try {
      const sessions = await api.list();
      if (alive.current && version === listVersion.current) dispatch({ type: 'sessions', sessions });
      return sessions;
    } catch (error) {
      if (version === listVersion.current) reportError(error, undefined, 'list');
      throw error;
    }
  }, [api, reportError]);

  const newDraft = useCallback((): void => {
    selectionVersion.current++;
    selected.current = '';
    dispatch({ type: 'draft' });
  }, []);

  const createSession = useCallback((): Promise<string> => {
    if (creation.current) return creation.current;
    const version = selectionVersion.current;
    dispatch({ type: 'clear-error' });
    const pending = (async () => {
      try {
        const { sessionId } = await api.create();
        await refreshList();
        if (alive.current && version === selectionVersion.current) await selectSession(sessionId);
        return sessionId;
      } catch (error) {
        reportError(error);
        throw error;
      } finally {
        creation.current = null;
      }
    })();
    creation.current = pending;
    return pending;
  }, [api, refreshList, reportError, selectSession]);

  const sendMessage = useCallback(async (text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, fast: boolean | undefined, attachments: DraftAttachment[]): Promise<void> => {
    dispatch({ type: 'clear-error' });
    const localId = `local-${++localSeq}`;
    const optimistic = {
      localId,
      text,
      at: new Date().toISOString(),
      ...(attachments.length === 0 ? {} : { attachments }),
    };

    let sessionId = selected.current;
    if (!sessionId) {
      // Creating a session selects it, which resets pending; re-add right after.
      sessionId = await createSession();
      if (alive.current) dispatch({ type: 'pending-add', pending: optimistic });
    } else if (alive.current) {
      dispatch({ type: 'pending-add', pending: optimistic });
    }

    try {
      const inputs = toAttachmentInputs(attachments);
      const { turn } = await api.send({
        sessionId,
        text,
        model: {
          provider: model.provider,
          model: model.model,
          reasoningEffort,
          ...(fast === undefined ? {} : { fast }),
        },
        ...(inputs.length === 0 ? {} : { attachments: inputs }),
      });
      if (alive.current) dispatch({ type: 'pending-resolve', localId, turn });
    } catch (error) {
      if (alive.current) dispatch({ type: 'pending-fail', localId, message: messageOf(error) });
      reportError(error, sessionId);
      throw error;
    }

    // An accepted send must not be reported as failed by a list-read error.
    void refreshList().catch((error: unknown) => reportError(error, sessionId));
  }, [api, createSession, refreshList, reportError]);

  const interruptTurn = useCallback(async (turn: number): Promise<void> => {
    const sessionId = selected.current;
    dispatch({ type: 'interrupting-add', turn });
    try {
      await api.interrupt({ sessionId, turn });
    } catch (error) {
      dispatch({ type: 'interrupting-clear', turn });
      reportError(error, sessionId);
    }
  }, [api, reportError]);

  const cancelTask = useCallback(async (taskRunId: string): Promise<void> => {
    try {
      await api.cancelTask(taskRunId);
    } catch (error) {
      reportError(error, selected.current);
      throw error;
    }
  }, [api, reportError]);

  const removePending = useCallback((localId: string): void => {
    dispatch({ type: 'pending-remove', localId });
  }, []);

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    dispatch({ type: 'clear-error' });
    try {
      await api.deleteSession(sessionId);
    } catch (error) {
      reportError(error, sessionId);
      throw error;
    }
    // Drop the deleted session's drafts before any list refresh so a stale
    // draft can never be attributed to a reused id.
    clearDraft(sessionId);
    clearDraftAttachments(sessionId);
    const sessions = await refreshList();
    if (!alive.current) return;
    if (selected.current === sessionId) {
      const next = sessions.find(
        (session) => session.sessionId !== sessionId && matchesStatusFilter(session, statusFilter),
      );
      if (next) await selectSession(next.sessionId);
      else newDraft();
    }
  }, [api, refreshList, reportError, selectSession, newDraft, statusFilter]);

  const setTasks = useCallback((tasks: Record<string, SessionBridgeTaskBrief>): void => {
    dispatch({ type: 'tasks', tasks });
  }, []);

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    dispatch({ type: 'clear-error' });
    try {
      await api.renameSession(sessionId, title);
    } catch (error) {
      reportError(error, sessionId);
      throw error;
    }
    // The pushed `session.titled` event updates the title in place; the list
    // refresh keeps the sidebar and the summary in sync.
    await refreshList().catch((error: unknown) => { reportError(error, sessionId); });
  }, [api, refreshList, reportError]);

  const clearError = useCallback((): void => {
    dispatch({ type: 'clear-error' });
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    // Availability is re-read on a bounded interval and whenever the window
    // regains focus, so a recovered route reappears and a newly blocked one is
    // hidden without a manual reload. Refreshes never overlap, and a response
    // landing after teardown dispatches nothing.
    let modelsInFlight = false;
    const refreshModels = async (): Promise<void> => {
      if (modelsInFlight) return;
      modelsInFlight = true;
      try {
        const models = await api.models();
        if (!cancelled) dispatch({ type: 'models', models });
      } catch (error) {
        if (!cancelled) reportError(error);
      } finally {
        modelsInFlight = false;
      }
    };
    const offEvent = api.onEvent(({ sessionId, event }) => {
      if (cancelled) return;
      if (sessionId === selected.current && event.seq > highestSeq.current + 1) {
        // A gap means pushes were lost (poll drop or reconnect); one guarded
        // ledger resync repairs the terminal state instead of patching gaps.
        void resyncLedger();
      }
      if (sessionId === selected.current) {
        highestSeq.current = Math.max(highestSeq.current, event.seq);
        if (event.type === 'turn.started' && event.turn !== undefined) openTurn.current = event.turn;
        else if (
          (event.type === 'turn.finished' || event.type === 'turn.interrupted')
          && event.turn === openTurn.current
        ) {
          openTurn.current = null;
        }
      }
      dispatch({ type: 'events', sessionId, events: [event] });
    });
    const offLive = api.onLive(({ sessionId, live }) => {
      if (!cancelled) dispatch({ type: 'live', sessionId, live });
    });
    // A card is bound to its routed session before the list arrives, so its
    // ledger is requested right away instead of waiting for `refreshList`. The
    // fetch is started only after the push subscriptions above are in place, so
    // no snapshot or pushed update can be missed; a failure is already reported
    // through the error state and must not escape as an unhandled rejection.
    if (mini && initialSelectedId !== '') void selectSession(initialSelectedId).catch(() => undefined);
    void refreshModels();
    const timer = setInterval(() => { void refreshList(); }, 3000);
    const modelsTimer = setInterval(() => { void refreshModels(); }, MODELS_REFRESH_MS);
    const resyncTimer = setInterval(() => { if (openTurn.current !== null) void resyncLedger(); }, LEDGER_RESYNC_MS);
    const onWindowFocus = (): void => {
      void refreshModels();
      // A session may have finished while the window was away; recalibrate.
      if (selected.current) void resyncLedger();
    };
    window.addEventListener('focus', onWindowFocus);
    void refreshList().then(async (sessions) => {
      if (cancelled || creation.current) return;
      // A card is already bound to its own session (draft or routed id) and
      // never reselects from the list; only the shell window follows it.
      if (mini) return;
      // A selected session that still exists is left untouched, so a status
      // filter or archive change alone never reselects. Only a selected id that
      // vanished (deleted from another page or shell) recovers here: drop its
      // stale drafts and open the first session still visible under the
      // persisted Status filter, or an empty draft when none match.
      if (selected.current) {
        if (sessions.some((session) => session.sessionId === selected.current)) return;
        clearDraft(selected.current);
        clearDraftAttachments(selected.current);
        const next = sessions.find((session) => matchesStatusFilter(session, statusFilter));
        if (next) await selectSession(next.sessionId);
        else newDraft();
        return;
      }
      // No selection: the shell auto-selects the newest session.
      if (sessions[0]) await selectSession(sessions[0].sessionId);
    }).catch((error: unknown) => { if (!cancelled) reportError(error); });
    return () => {
      cancelled = true;
      alive.current = false;
      selectionVersion.current++;
      listVersion.current++;
      clearInterval(timer);
      clearInterval(modelsTimer);
      clearInterval(resyncTimer);
      window.removeEventListener('focus', onWindowFocus);
      offEvent();
      offLive();
    };
  }, [api, refreshList, reportError, selectSession]);

  return { state, selectSession, newDraft, sendMessage, interruptTurn, cancelTask, deleteSession, renameSession, removePending, setTasks, clearError };
}
