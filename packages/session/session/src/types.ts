export type SessionId = string;
export type Seq = number;

export type SurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  | 'none';

export interface SessionEventBase {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly turn?: number;
  readonly step?: number;
  readonly id?: string;
  readonly parent?: string;
  readonly surfaceOp?: SurfaceOp;
}

export type SessionEventDraft<E extends SessionEventBase> =
  E extends SessionEventBase ? Omit<E, 'seq' | 'at'> : never;

export interface SessionPage<E> {
  events: E[];
  lastSeq: number;
  hasMore: boolean;
}

export interface SessionHeader {
  sessionId: string;
  createdAt: string;
  parentSessionId?: string;
  inheritedSeq?: number;
  meta?: Record<string, unknown>;
}

export interface SessionSummaryBase {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  lastSeq?: number;
  pendingTurns?: number[];
  bytes?: number;
}

export type SessionStatus = 'idle' | 'running' | 'waiting';

export interface LiveFrame {
  spanId: string;
  text: string;
  reasoning: string;
}

export type InboxMode = 'followup' | 'steer' | 'inject';

export interface InboxEntry<TInput = unknown> {
  id: string;
  mode: InboxMode;
  input: TInput;
  queuedAt: string;
}

export interface RecoveryWaitState {
  turn: number;
  key: string;
}

export interface SubSessionSpec<TInput = unknown> {
  parentEventId: string;
  input: TInput;
  inheritToSeq?: number;
}
