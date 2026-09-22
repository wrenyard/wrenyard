/**
 * Session-specific error data.
 *
 * Every variant is discriminated by `kind` and carries only the identifiers
 * relevant to it. These shapes are the `error.data` payload of a JSON-RPC
 * error response.
 *
 * NUMERIC MAPPING IS PENDING. `session_not_found` already has the wire code
 * `-32003` (`PROTOCOL_ERROR_CODES.SESSION_NOT_FOUND` in `../common/errors.ts`).
 * The remaining variants deliberately have NO assigned number yet: inventing
 * speculative codes would freeze an arbitrary choice into the wire format.
 * A runtime adapter must define the full mapping and reject unknown codes
 * before this protocol is integrated. Consumers should discriminate on
 * `kind` and treat the numeric code as transport detail.
 */

/** The addressed session does not exist. */
export interface SessionNotFoundErrorData {
  kind: 'session_not_found'
  sessionId: string
}

/** The addressed turn does not exist within the session. */
export interface TurnNotFoundErrorData {
  kind: 'turn_not_found'
  sessionId: string
  turnId: string
}

/** The session already owns an active turn. */
export interface SessionBusyErrorData {
  kind: 'session_busy'
  sessionId: string
  /** Turn currently occupying the session, when known. */
  activeTurnId?: string
}

/**
 * `clientRequestId` was reused with different content. An identical retry is
 * NOT a conflict; it returns the original ids.
 */
export interface IdempotencyConflictErrorData {
  kind: 'idempotency_conflict'
  sessionId: string
  clientRequestId: string
}

/**
 * The requested `afterSeq` (or pagination cursor) is older than retained
 * history. The client must discard local event state and resynchronize with a
 * fresh snapshot.
 */
export interface CursorExpiredErrorData {
  kind: 'cursor_expired'
  sessionId: string
  /** Oldest sequence number still retained, when known. */
  oldestRetainedSeq?: number
}

/**
 * The requested `afterSeq` is ahead of the session's latest sequence number.
 * Usually a client bug or a session identity mix-up; the client must
 * resynchronize rather than wait.
 */
export interface CursorAheadErrorData {
  kind: 'cursor_ahead'
  sessionId: string
  /** Latest sequence number the session has assigned. */
  latestSeq?: number
}

/** Discriminated union of all session error data payloads. */
export type SessionErrorData =
  | SessionNotFoundErrorData
  | TurnNotFoundErrorData
  | SessionBusyErrorData
  | IdempotencyConflictErrorData
  | CursorExpiredErrorData
  | CursorAheadErrorData

export type SessionErrorKind = SessionErrorData['kind']
