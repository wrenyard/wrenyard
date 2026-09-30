import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialSessionState, sessionReducer } from './session-state.js';
import type { ModelEntry, SessionApi } from './types.js';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function useSessionController(api: SessionApi) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
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

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const off = api.onEvent(({ sessionId, event }) => {
      if (!cancelled) dispatch({ type: 'events', sessionId, events: [event] });
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
      off();
    };
  }, [api, refreshList, reportError, selectSession]);

  const createSession = useCallback((): Promise<string> => {
    if (creation.current) return creation.current;
    const version = selectionVersion.current;
    dispatch({ type: 'creating', value: true });
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
        if (alive.current) dispatch({ type: 'creating', value: false });
      }
    })();
    creation.current = pending;
    return pending;
  }, [api, refreshList, reportError, selectSession]);

  const sendMessage = useCallback(async (text: string, model: ModelEntry, reasoningEffort: string) => {
    dispatch({ type: 'clear-error' });
    const sessionId = selected.current || await createSession();
    try {
      await api.send({ sessionId, text, model: {
        provider: model.provider, model: model.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      } });
    } catch (error) {
      reportError(error, sessionId);
      throw error;
    }
    // A list-read failure must not turn an accepted message into a failed send.
    void refreshList().catch((error: unknown) => reportError(error, sessionId));
  }, [api, createSession, refreshList, reportError]);

  const interruptTurn = useCallback(async (turn: number) => {
    const sessionId = selected.current;
    try { await api.interrupt({ sessionId, turn }); }
    catch (error) { reportError(error, sessionId); }
  }, [api, reportError]);

  return { state, selectSession, createSession, sendMessage, interruptTurn };
}
