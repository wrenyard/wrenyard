/**
 * Session feature surface.
 *
 * Everything here is type-only (plus the two page-size constants), and none
 * of it validates or executes anything. See ../../README.md.
 */

export type {
  EpochMilliseconds,
  EventSeq,
  MessageId,
  PaginationCursor,
  Session,
  SessionId,
  SessionMessage,
  SessionMessageRole,
  SessionModelRef,
  SessionSummary,
  SessionTurn,
  SessionTurnError,
  SessionTurnStatus,
  TurnId,
  WorkspaceId,
} from './types.ts'

export {
  SESSION_PAGE_DEFAULT_LIMIT,
  SESSION_PAGE_MAX_LIMIT,
} from './methods.ts'

export type {
  SessionCancelParams,
  SessionCancelResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionEventsParams,
  SessionEventsResult,
  SessionGetParams,
  SessionGetResult,
  SessionListParams,
  SessionListResult,
  SessionMessagesListParams,
  SessionMessagesListResult,
  SessionMethods,
  SessionSendParams,
  SessionSendResult,
} from './methods.ts'

export type {
  MessageUpsertedEvent,
  SessionEvent,
  SessionEventType,
  SessionNotifications,
  SessionUpdatedEvent,
  TurnUpdatedEvent,
} from './events.ts'

export type {
  CursorAheadErrorData,
  CursorExpiredErrorData,
  IdempotencyConflictErrorData,
  SessionBusyErrorData,
  SessionErrorData,
  SessionErrorKind,
  SessionNotFoundErrorData,
  TurnNotFoundErrorData,
} from './errors.ts'
