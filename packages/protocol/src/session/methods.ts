/**
 * The seven session methods.
 *
 * Each method is an explicit named `Params`/`Result` pair plus a descriptor
 * entry in `SessionMethods`. The descriptor map is the single source of truth
 * for typed requests/results; it is a TYPE MAP, not a runtime table.
 *
 * Semantics documented here are DRAFT protocol semantics. They describe the
 * contract a future adapter must implement; they are not a claim that any
 * runtime currently provides them.
 */

import type { RpcMethod } from '../common/methods.ts'
import type { SessionEvent } from './events.ts'
import type {
  EventSeq,
  PaginationCursor,
  Session,
  SessionId,
  SessionMessage,
  SessionModelRef,
  SessionSummary,
  SessionTurn,
  TurnId,
  WorkspaceId,
} from './types.ts'

/** Page size used when a caller omits `limit` on a paged session method. */
export const SESSION_PAGE_DEFAULT_LIMIT = 50

/** Largest accepted page size on a paged session method. */
export const SESSION_PAGE_MAX_LIMIT = 200

/** Params of `session.create`. */
export interface SessionCreateParams {
  workspaceId: WorkspaceId
  /** Server-derived default when omitted. */
  title?: string
}

/** Result of `session.create`. */
export interface SessionCreateResult {
  session: Session
}

/** Params of `session.list`. */
export interface SessionListParams {
  workspaceId: WorkspaceId
  /** Opaque continuation cursor from a previous page; absent for page one. */
  cursor?: PaginationCursor
  limit?: number
}

/** Result of `session.list`. */
export interface SessionListResult {
  sessions: SessionSummary[]
  /** Absent when the listing is exhausted. */
  nextCursor?: PaginationCursor
}

/** Params of `session.get`. */
export interface SessionGetParams {
  sessionId: SessionId
}

/** Result of `session.get`. */
export interface SessionGetResult {
  session: Session
  /** Turn currently occupying the session, when one exists. */
  activeTurn?: SessionTurn
  /**
   * Event sequence number captured at the SAME snapshot as `session` and
   * `activeTurn`. It is NOT message history. Feed it to `session.events` as
   * `afterSeq` to resume the stream without replaying the whole session.
   */
  cursor: EventSeq
}

/** Params of `session.messages.list`. */
export interface SessionMessagesListParams {
  sessionId: SessionId
  /**
   * Opaque cursor from a previous page. It freezes the pagination upper bound
   * at the moment it was issued, so later messages cannot shift a page.
   * This cursor is INDEPENDENT of the event cursor.
   */
  cursor?: PaginationCursor
  limit?: number
}

/** Result of `session.messages.list`. */
export interface SessionMessagesListResult {
  /**
   * Newest page first. Items within a page are chronological. Prepend older
   * pages as a whole to preserve that order.
   */
  messages: SessionMessage[]
  /** Absent when no older messages remain. */
  nextCursor?: PaginationCursor
}

/** Params of `session.send`. */
export interface SessionSendParams {
  sessionId: SessionId
  /**
   * Session-scoped idempotency key. An identical retry returns the same turn
   * and message ids. Reusing the key with different content is a conflict.
   */
  clientRequestId: string
  text: string
  model: SessionModelRef
}

/** Result of `session.send`. */
export interface SessionSendResult {
  /**
   * Accepted turn. This is an ACCEPTANCE response, not a completed
   * generation: the turn may still be queued or running when it returns.
   */
  turn: SessionTurn
  /** The user message persisted for this request. */
  userMessage: SessionMessage
}

/** Params of `session.cancel`. */
export interface SessionCancelParams {
  sessionId: SessionId
  /** The specific turn to cancel. */
  turnId: TurnId
}

/** Result of `session.cancel`. */
export interface SessionCancelResult {
  /**
   * The addressed turn after the cancellation request. The response is
   * idempotent for an already-terminal turn. Because cancellation is
   * cooperative, this acknowledgement may still report an active status
   * until the terminal `turn.updated` event arrives.
   */
  turn: SessionTurn
}

/** Params of `session.events`. */
export interface SessionEventsParams {
  sessionId: SessionId
  /**
   * EXCLUSIVE lower bound: only events with `seq > afterSeq` are returned.
   * `0` starts from the beginning of retained history, but only if that
   * history has not expired. Paging never skips an event.
   */
  afterSeq: EventSeq
  limit?: number
}

/** Result of `session.events`. */
export interface SessionEventsResult {
  /** Ascending by `seq`, all greater than the requested `afterSeq`. */
  events: SessionEvent[]
  /**
   * `seq` of the last returned event. On an empty page this retains the input
   * `afterSeq`, so a client may poll with it again without advancing.
   */
  nextSeq: EventSeq
  hasMore: boolean
}

/**
 * Feature method map. Keys are the exact wire method names.
 *
 * A future conversation feature declares its own map the same way and the
 * root map composes it (see `../index.ts`).
 */
export interface SessionMethods {
  'session.create': RpcMethod<SessionCreateParams, SessionCreateResult>
  'session.list': RpcMethod<SessionListParams, SessionListResult>
  'session.get': RpcMethod<SessionGetParams, SessionGetResult>
  'session.messages.list': RpcMethod<SessionMessagesListParams, SessionMessagesListResult>
  'session.send': RpcMethod<SessionSendParams, SessionSendResult>
  'session.cancel': RpcMethod<SessionCancelParams, SessionCancelResult>
  'session.events': RpcMethod<SessionEventsParams, SessionEventsResult>
}
