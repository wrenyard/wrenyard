/**
 * Session events.
 *
 * An event is always a WHOLE-ENTITY update. There is no per-character or
 * per-token text delta, and no partial patch payload: a consumer applies the
 * event by upserting the entity it names, keyed by that entity's id.
 *
 * The same event union is returned by the `session.events` request/response
 * method and would be delivered by the future `session.event` notification
 * channel. `SessionNotifications` below declares that push contract ONLY —
 * there is no subscription, stream, or push implementation anywhere in this
 * package.
 *
 * These are DRAFT semantics, not a claim of existing runtime support.
 */

import type { RpcNotification } from '../common/methods.ts'
import type {
  EventSeq,
  EpochMilliseconds,
  Session,
  SessionId,
  SessionMessage,
  SessionTurn,
} from './types.ts'

/** Fields carried by every session event. */
export interface SessionEventBase {
  sessionId: SessionId
  /**
   * Per-session monotonically increasing positive safe integer. It is the
   * delivery/ordering key and the argument of `afterSeq` paging.
   */
  seq: EventSeq
  /** Feature-clock time at which the recorded change happened. */
  occurredAt: EpochMilliseconds
}

/** The session record itself changed (metadata, active turn, title, ...). */
export interface SessionUpdatedEvent extends SessionEventBase {
  type: 'session.updated'
  session: Session
}

/** A turn changed state, including its transition into a terminal status. */
export interface TurnUpdatedEvent extends SessionEventBase {
  type: 'turn.updated'
  turn: SessionTurn
}

/**
 * A message was created or changed. Upsert by `message.messageId`; the event
 * never carries a text delta, always the current full text.
 */
export interface MessageUpsertedEvent extends SessionEventBase {
  type: 'message.upserted'
  message: SessionMessage
}

/** Discriminated on `type`. */
export type SessionEvent =
  | SessionUpdatedEvent
  | TurnUpdatedEvent
  | MessageUpsertedEvent

export type SessionEventType = SessionEvent['type']

/**
 * FUTURE push contract: a notification carrying a session event.
 *
 * Declaring this descriptor does not implement push. The draft's initial
 * delivery design is polling via `session.events`, also not implemented yet.
 */
export interface SessionNotifications {
  'session.event': RpcNotification<SessionEvent>
}
