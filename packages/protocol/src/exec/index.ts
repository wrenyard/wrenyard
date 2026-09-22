/**
 * Exec feature surface.
 *
 * Everything here is type-only, and none of it validates or executes anything.
 * See ../../README.md.
 */

export type {
  ExecEventEnvelope,
  ExecFeatureId,
  ExecId,
  ExecSeq,
  ExecSnapshot,
  ExecStatus,
} from './types.ts'

export type {
  ExecCancelParams,
  ExecCancelResult,
  ExecEventsParams,
  ExecEventsResult,
  ExecGetParams,
  ExecGetResult,
  ExecMethods,
  ExecStartParams,
  ExecStartResult,
} from './methods.ts'

export type {
  ExecClientUnavailableErrorData,
  ExecCursorExpiredErrorData,
  ExecErrorData,
  ExecErrorKind,
  ExecFeatureUnknownErrorData,
  ExecNotFoundErrorData,
} from './errors.ts'
