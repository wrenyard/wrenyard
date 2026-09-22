/**
 * Session DTOs for the future conversation API.
 *
 * Design rules, all enforced by convention rather than by runtime validation:
 *
 * - Ids are OPAQUE non-empty strings. Never parse, order, or assume a format.
 * - Timestamps are epoch MILLISECONDS as plain numbers.
 * - Field names are camelCase.
 * - Only JSON-safe concrete shapes are used. No `Date`, `Error`, `Map`, `Set`,
 *   function, class instance, `undefined`-carrying required field, or native
 *   agent event object appears anywhere in this file.
 *
 * These are TYPES ONLY and they DO NOT VALIDATE incoming JSON. See README.md.
 */

/** Opaque session/turn/message identifier. Non-empty on the wire. */
export type SessionId = string

/** Opaque turn identifier. Non-empty on the wire. */
export type TurnId = string

/** Opaque message identifier. Non-empty on the wire. */
export type MessageId = string

/** Opaque workspace identifier. Non-empty on the wire. */
export type WorkspaceId = string

/** Epoch milliseconds since the Unix epoch. */
export type EpochMilliseconds = number

/**
 * Per-session monotonically increasing event sequence number.
 *
 * Events use positive safe integers starting at 1. A cursor may be 0 before
 * the first event. Sequence numbers are never reused within a session.
 */
export type EventSeq = number

/** Opaque pagination cursor. The encoding is owned by the feature, not here. */
export type PaginationCursor = string

/** Routing reference to the model a turn was requested against. */
export interface SessionModelRef {
  providerId: string
  modelId: string
}

/** Role of the author of a session message. */
export type SessionMessageRole = 'user' | 'assistant' | 'tool'

/** Terminal-or-in-flight state of a single turn. */
export type SessionTurnStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** Failure detail carried by a turn whose status is `failed`. */
export interface SessionTurnError {
  /** Stable machine-readable failure code. */
  code: string
  /** Human-readable failure description. */
  message: string
}

/** Lightweight session listing record. */
export interface SessionSummary {
  sessionId: SessionId
  workspaceId: WorkspaceId
  title: string
  createdAt: EpochMilliseconds
  updatedAt: EpochMilliseconds
  /**
   * Turn currently occupying the session, when one exists. At most one turn
   * of a session is active at a time (see `session.send`).
   */
  activeTurnId?: TurnId
}

/**
 * The initial protocol uses the same record for listing and detail.
 */
export type Session = SessionSummary

/** One retained message of a session. */
export interface SessionMessage {
  messageId: MessageId
  sessionId: SessionId
  turnId: TurnId
  role: SessionMessageRole
  text: string
  createdAt: EpochMilliseconds
  updatedAt: EpochMilliseconds
}

/**
 * One turn of a session: a single accepted generation request and its
 * progress toward a terminal status.
 */
export interface SessionTurn {
  turnId: TurnId
  sessionId: SessionId
  status: SessionTurnStatus
  model: SessionModelRef
  createdAt: EpochMilliseconds
  /** Absent while the turn is not terminal. */
  completedAt?: EpochMilliseconds
  /** Present only when `status` is `failed`. */
  error?: SessionTurnError
}
