import type {
  SessionV2Bridge,
  SessionV2BridgeEventPayload,
  SessionV2BridgeModelEntry,
} from '../../session-v2/preload.js';

export type SessionApi = SessionV2Bridge;
export type LedgerEvent = SessionV2BridgeEventPayload['event'];
export type SessionSummary = Awaited<ReturnType<SessionApi['list']>>[number];
export type ModelEntry = SessionV2BridgeModelEntry;
export type CallEvent = Extract<LedgerEvent, { type: 'call' }>;
export type EventOf<T extends LedgerEvent['type']> = Extract<LedgerEvent, { type: T }>;

export interface TurnView {
  id: number;
  events: LedgerEvent[];
  cycle: number;
  phase: string;
  started: string;
  user: string;
  progress: string;
  final?: string;
  status?: string;
  ended?: string;
}

declare global {
  interface Window { sessionV2: SessionApi }
}
