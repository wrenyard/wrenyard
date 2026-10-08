import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialSessionPageState, sessionReducer, type SessionPageState } from './session-reducer.js';
import type { AttachmentInput, DraftAttachment, ModelEntry, SessionApi, SessionBridgeTaskBrief } from '../model/types.js';
import type { ReasoningEffort } from './reasoning-effort.js';
import { clearDraft, clearDraftAttachments } from './drafts.js';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
let localSeq = 0;

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

export interface SessionController {
  state: SessionPageState;
  selectSession(sessionId: string): Promise<void>;
  newDraft(): void;
  sendMessage(text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, attachments: DraftAttachment[]): Promise<void>;
  interruptTurn(turn: number): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  removePending(localId: string): void;
  setTasks(tasks: Record<string, SessionBridgeTaskBrief>): void;
  clearError(): void;
}

/** Owns selection, ledger merging, optimistic turns and interrupt requests. */
export function useSessionController(api: SessionApi) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionPageState);
  const alive = useRef(false);
  const selected = useRef('');
  const selectionVersion = useRef(0);
  const listVersion = useRef(0);
  const creation = useRef<Promise<string> | null>(null);

  const reportError = useCallback((error: unknown, sessionId?: string, loading?: 'list' | 'ledger') => {
    if (alive.current) dispatch({ type: 'error', message: messageOf(error), sessionId, loading });
  }, []);

  const selectSession = useCallback(async (sessionId: string): Promise<void> => {
    const version = ++selectionVersion.current;
    selected.current = sessionId;
    dispatch({ type: 'select', sessionId });
    try {
      const snapshot = await api.ledger(sessionId);
      if (alive.current && version === selectionVersion.current) {
        dispatch({ type: 'events', sessionId, events: snapshot, snapshot: true });
      }
    } catch (error) {
      if (version === selectionVersion.current) reportError(error, sessionId, 'ledger');
      throw error;
    }
  }, [api, reportError]);

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

  const sendMessage = useCallback(async (text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, attachments: DraftAttachment[]): Promise<void> => {
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
      const next = sessions.find((session) => session.sessionId !== sessionId);
      if (next) await selectSession(next.sessionId);
      else newDraft();
    }
  }, [api, refreshList, reportError, selectSession, newDraft]);

  const setTasks = useCallback((tasks: Record<string, SessionBridgeTaskBrief>): void => {
    dispatch({ type: 'tasks', tasks });
  }, []);

  const clearError = useCallback((): void => {
    dispatch({ type: 'clear-error' });
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const offEvent = api.onEvent(({ sessionId, event }) => {
      if (!cancelled) dispatch({ type: 'events', sessionId, events: [event] });
    });
    const offLive = api.onLive(({ sessionId, live }) => {
      if (!cancelled) dispatch({ type: 'live', sessionId, live });
    });
    void api.models().then((models) => {
      if (!cancelled) dispatch({ type: 'models', models });
    }).catch((error: unknown) => { if (!cancelled) reportError(error); });
    void refreshList().then(async (sessions) => {
      if (!cancelled && !selected.current && !creation.current && sessions[0]) {
        await selectSession(sessions[0].sessionId);
      }
    }).catch((error: unknown) => { if (!cancelled) reportError(error); });
    return () => {
      cancelled = true;
      alive.current = false;
      selectionVersion.current++;
      listVersion.current++;
      offEvent();
      offLive();
    };
  }, [api, refreshList, reportError, selectSession]);

  return { state, selectSession, newDraft, sendMessage, interruptTurn, deleteSession, removePending, setTasks, clearError };
}
