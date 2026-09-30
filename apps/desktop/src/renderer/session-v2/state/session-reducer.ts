import type {
  LedgerEvent,
  LiveCall,
  ModelEntry,
  SessionSummary,
  SessionV2BridgeTaskBrief,
} from '../model/types.js';

export interface PendingTurn {
  localId: string;
  text: string;
  at: string;
  turn?: number;
  failed?: string;
}

export interface SessionPageState {
  sessions: SessionSummary[];
  models: ModelEntry[];
  /** `''` means the draft state: no session exists until the first send. */
  selectedId: string;
  events: LedgerEvent[];
  live: LiveCall[];
  tasks: Record<string, SessionV2BridgeTaskBrief>;
  pending: PendingTurn[];
  interrupting: number[];
  loadingList: boolean;
  loadingLedger: boolean;
  error: string;
}

export const initialSessionPageState: SessionPageState = {
  sessions: [],
  models: [],
  selectedId: '',
  events: [],
  live: [],
  tasks: {},
  pending: [],
  interrupting: [],
  loadingList: true,
  loadingLedger: false,
  error: '',
};

/** Sequence numbers are session-local; snapshots and pushes may overlap. */
export function mergeEvents(current: LedgerEvent[], incoming: LedgerEvent[]): LedgerEvent[] {
  const bySequence = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
}

function withLedgerTitle(sessions: SessionSummary[], events: LedgerEvent[], sessionId: string): SessionSummary[] {
  const title = events.filter((event) => (event as { type: string }).type === 'title').at(-1) as { text?: string } | undefined;
  if (!title?.text) return sessions;
  return sessions.map((session) => (session.sessionId === sessionId ? { ...session, title: title.text! } : session));
}

export type SessionAction =
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'models'; models: ModelEntry[] }
  | { type: 'select'; sessionId: string }
  | { type: 'draft' }
  | { type: 'events'; sessionId: string; events: LedgerEvent[]; snapshot?: boolean }
  | { type: 'live'; sessionId: string; live: LiveCall[] }
  | { type: 'tasks'; tasks: Record<string, SessionV2BridgeTaskBrief> }
  | { type: 'pending-add'; pending: PendingTurn }
  | { type: 'pending-resolve'; localId: string; turn: number }
  | { type: 'pending-fail'; localId: string; message: string }
  | { type: 'pending-remove'; localId: string }
  | { type: 'interrupting-add'; turn: number }
  | { type: 'interrupting-clear'; turn: number }
  | { type: 'error'; message: string; sessionId?: string; loading?: 'list' | 'ledger' }
  | { type: 'clear-error' };

/** Bridge values are immutable: every update produces new arrays and objects. */
export function sessionReducer(state: SessionPageState, action: SessionAction): SessionPageState {
  switch (action.type) {
    case 'sessions':
      return { ...state, sessions: withLedgerTitle(action.sessions, state.events, state.selectedId), loadingList: false };
    case 'models':
      return { ...state, models: action.models };
    case 'select':
      return {
        ...state,
        selectedId: action.sessionId,
        events: [],
        live: [],
        tasks: {},
        pending: [],
        interrupting: [],
        loadingLedger: true,
        error: '',
      };
    case 'draft':
      return {
        ...state,
        selectedId: '',
        events: [],
        live: [],
        tasks: {},
        pending: [],
        interrupting: [],
        loadingLedger: false,
        error: '',
      };
    case 'events': {
      if (action.sessionId !== state.selectedId) return state;
      const events = mergeEvents(state.events, action.events);
      const startedTurns = new Set<number>();
      const finishedTurns = new Set<number>();
      for (const event of action.events) {
        const type = (event as { type: string }).type;
        if (type === 'turn.started' && event.turn !== undefined) startedTurns.add(event.turn);
        if (type === 'turn.finished' && event.turn !== undefined) finishedTurns.add(event.turn);
      }
      const pending = state.pending.filter((turn) => turn.turn === undefined || !startedTurns.has(turn.turn));
      return {
        ...state,
        events,
        pending,
        interrupting: state.interrupting.filter((turn) => !finishedTurns.has(turn)),
        loadingLedger: action.snapshot ? false : state.loadingLedger,
        sessions: withLedgerTitle(state.sessions, events, action.sessionId),
      };
    }
    case 'live':
      if (action.sessionId !== state.selectedId) return state;
      return { ...state, live: action.live };
    case 'tasks':
      return { ...state, tasks: action.tasks };
    case 'pending-add':
      return { ...state, pending: [...state.pending, action.pending] };
    case 'pending-resolve': {
      const alreadyStarted = state.events.some(
        (event) => (event as { type: string }).type === 'turn.started' && event.turn === action.turn,
      );
      return {
        ...state,
        pending: alreadyStarted
          ? state.pending.filter((turn) => turn.localId !== action.localId)
          : state.pending.map((turn) => (turn.localId === action.localId ? { ...turn, turn: action.turn } : turn)),
      };
    }
    case 'pending-fail':
      return {
        ...state,
        pending: state.pending.map((turn) => (turn.localId === action.localId ? { ...turn, failed: action.message } : turn)),
      };
    case 'pending-remove':
      return { ...state, pending: state.pending.filter((turn) => turn.localId !== action.localId) };
    case 'interrupting-add':
      return state.interrupting.includes(action.turn) ? state : { ...state, interrupting: [...state.interrupting, action.turn] };
    case 'interrupting-clear':
      return { ...state, interrupting: state.interrupting.filter((turn) => turn !== action.turn) };
    case 'error':
      if (action.sessionId && action.sessionId !== state.selectedId) return state;
      return {
        ...state,
        error: action.message,
        loadingList: action.loading === 'list' ? false : state.loadingList,
        loadingLedger: action.loading === 'ledger' ? false : state.loadingLedger,
      };
    case 'clear-error':
      return { ...state, error: '' };
  }
}
