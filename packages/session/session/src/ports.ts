import type { TailRepairPlan } from './fork.ts';
import type {
  SessionEventBase,
  SessionEventDraft,
  SessionPage,
  SessionSummaryBase,
  SubSessionSpec,
} from './types.ts';

export type SessionStorageMode = 'read' | 'write';

export interface SessionStorageHandle<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  readonly sessionId: string;
  readonly mode: SessionStorageMode;
  read(): E[];
  readPage(afterSeq: number, limit: number): SessionPage<E>;
  append(draft: SessionEventDraft<E>): Promise<E>;
  appendBatch?(drafts: readonly SessionEventDraft<E>[]): Promise<E[]>;
  flush(): Promise<void>;
  summary(): TSummary | undefined;
  close(): Promise<void>;
}

export interface SessionPersistencePort<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  init?(): Promise<void>;
  create(
    sessionId: string,
    initialDrafts?: readonly SessionEventDraft<E>[],
    options?: { isSeed?: boolean },
  ): Promise<SessionStorageHandle<E, TSummary>>;
  open(sessionId: string, mode: SessionStorageMode): Promise<SessionStorageHandle<E, TSummary>>;
  stat(sessionId: string): TSummary | undefined;
  list(): TSummary[];
  read(sessionId: string): E[];
  readPage?(sessionId: string, afterSeq: number, limit: number): SessionPage<E>;
  subscribe(sessionId: string, listener: (event: E) => void): () => void;
  deleteSession(sessionId: string): Promise<void>;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

export interface Projector<E extends SessionEventBase, TView> {
  readonly id: string;
  isSurfaceEvent?(event: E): boolean;
  replaceRange?(event: E): { startSeq: number; endSeq: number } | undefined;
  fold(activeEvents: readonly E[], allEvents: readonly E[]): TView;
}

export interface SessionDriverContext<E extends SessionEventBase, TTurnInput> {
  sessionId: string;
  turn: number;
  input: TTurnInput;
  signal: AbortSignal;
  read(): E[];
  append(draft: SessionEventDraft<E>): Promise<E>;
  flush(): Promise<void>;
  project<TView>(projector: Projector<E, TView>): TView;
}

export interface SessionDriverPort<
  E extends SessionEventBase,
  TTurnInput,
  TResult = void,
> {
  recoverSession?(ctx: {
    sessionId: string;
    events: readonly E[];
    repair: TailRepairPlan;
  }): Promise<void>;
  runTurn(ctx: SessionDriverContext<E, TTurnInput>): Promise<TResult>;
  interruptTurn?(ctx: { sessionId: string; turn: number; reason: string }): Promise<void>;
  runSubSession?<TSubInput, TSubResult = void>(ctx: {
    parentSessionId: string;
    subSessionId: string;
    spec: SubSessionSpec<TSubInput>;
    signal: AbortSignal;
  }): Promise<TSubResult>;
}
