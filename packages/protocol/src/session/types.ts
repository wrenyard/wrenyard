/**
 * Session ledger wire DTOs: the `session.list` / `session.create` /
 * `session.send` / `session.interrupt` / `session.events` surface for the
 * append-only session timeline.
 *
 * The event and summary shapes are declared in `./ledger.ts` so a ledger
 * record crosses the wire unchanged.
 */
import type { LedgerEvent, LiveCall, SessionSummary } from './ledger.ts'

export type SessionListParams = Record<string, never>
export interface SessionListResult { sessions: SessionSummary[] }
export type SessionCreateParams = Record<string, never>
export interface SessionCreateResult { sessionId: string }
export interface SessionSendResult { turn: number }
export interface SessionInterruptParams { sessionId: string; turn: number }
export type SessionInterruptResult = Record<string, never>
export interface SessionEventsParams {
  sessionId: string
  afterSeq: number
  limit?: number
  waitMs?: number
  /** When true, the result also carries the current live streaming snapshot. */
  live?: boolean
}
export interface SessionEventsResult {
  events: LedgerEvent[]
  lastSeq: number
  /** Complete current live-call snapshot; present only when `live` was requested. */
  live?: LiveCall[]
}
