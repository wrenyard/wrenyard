import { mergeEvents } from './ledger-view.js';
import type { LedgerEvent, ModelEntry, SessionSummary } from './types.js';

export interface SessionState {
  sessions: SessionSummary[];
  models: ModelEntry[];
  selectedId: string;
  events: LedgerEvent[];
  loadingList: boolean;
  loadingLedger: boolean;
  creating: boolean;
  error: string;
}

export const initialSessionState: SessionState = {
  sessions: [], models: [], selectedId: '', events: [],
  loadingList: true, loadingLedger: false, creating: false, error: '',
};

function withLedgerTitle(sessions: SessionSummary[], events: LedgerEvent[], sessionId: string): SessionSummary[] {
  const title = events.filter((event) => event.type === 'title').at(-1);
  return title ? sessions.map((session) => session.sessionId === sessionId
    ? { ...session, title: title.text } : session) : sessions;
}

type Action =
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'models'; models: ModelEntry[] }
  | { type: 'select'; sessionId: string }
  | { type: 'events'; sessionId: string; events: LedgerEvent[]; snapshot?: boolean }
  | { type: 'creating'; value: boolean }
  | { type: 'error'; message: string; sessionId?: string; loading?: 'list' | 'ledger' }
  | { type: 'clear-error' };

/** Bridge values are immutable: all updates produce new arrays and objects. */
export function sessionReducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'sessions': return {
      ...state, sessions: withLedgerTitle(action.sessions, state.events, state.selectedId), loadingList: false,
    };
    case 'models': return { ...state, models: action.models };
    case 'select': return { ...state, selectedId: action.sessionId, events: [], loadingLedger: true, error: '' };
    case 'events': {
      if (action.sessionId !== state.selectedId) return state;
      const events = mergeEvents(state.events, action.events);
      return {
        ...state, events,
        loadingLedger: action.snapshot ? false : state.loadingLedger,
        sessions: withLedgerTitle(state.sessions, events, action.sessionId),
      };
    }
    case 'creating': return { ...state, creating: action.value };
    case 'error':
      if (action.sessionId && action.sessionId !== state.selectedId) return state;
      return {
        ...state, error: action.message,
        loadingList: action.loading === 'list' ? false : state.loadingList,
        loadingLedger: action.loading === 'ledger' ? false : state.loadingLedger,
      };
    case 'clear-error': return { ...state, error: '' };
  }
}
