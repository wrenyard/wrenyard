/**
 * The session methods.
 *
 * Each method is an explicit named `Params`/`Result` pair plus a descriptor
 * entry in `SessionMethods`. The descriptor map is the single source of truth
 * for typed requests/results; it is a TYPE MAP, not a runtime table.
 *
 * Every method except the summary-model pair and `session.backend`
 * returns the same `SessionSnapshotResult`: a full product
 * conversation snapshot plus the monotonic revision it was projected at. A
 * caller never merges a delta — it replaces the projection it holds with the
 * returned snapshot, so two callers can never diverge.
 */

import type { RpcMethod } from '../common/methods.ts'
import type {
  ConversationSnapshot,
  SummarySettingsSnapshot,
  WorkspaceConfigurationSnapshot,
} from './types.ts'

/**
 * Request one product conversation snapshot.
 *
 * `afterRevision` is the revision the caller already holds. When it equals the
 * current revision the call waits (bounded by `waitMs`, at most 1000ms) for the
 * next change or terminal flush and then returns a *full* snapshot — never a
 * delta — with its revision. When it differs, or is absent, the call returns
 * immediately. `waitMs` is a wait budget, not a poll interval; a caller that
 * wants continuous updates simply re-issues the call with the last revision.
 */
export interface SessionSnapshotParams {
  afterRevision?: number
  waitMs?: number
}

/** Result of every action and snapshot method. */
export interface SessionSnapshotResult {
  conversation: ConversationSnapshot
  /** Monotonic revision of the returned projection. */
  revision: number
}

/** Params of `session.select`. */
export interface SessionSelectParams {
  sessionId: string
}

/** Params of `session.create`. */
export interface SessionCreateParams {}

/** Params of `session.selectModel`. */
export interface SessionSelectModelParams {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Params of `session.send`. */
export interface SessionSendParams {
  text: string
  clientTimeZone?: string
}

/** Params of `session.cancel`. The addressed turn, or the oldest running turn when absent. */
export interface SessionCancelParams {
  turnId?: string
}

/** Params of `session.setWorkspace`. */
export interface SessionSetWorkspaceParams {
  workspace: WorkspaceConfigurationSnapshot
}

/** Result of `session.select`. */
export type SessionSelectResult = SessionSnapshotResult

/** Result of `session.create`. */
export type SessionCreateResult = SessionSnapshotResult

/** Result of `session.selectModel`. */
export type SessionSelectModelResult = SessionSnapshotResult

/** Result of `session.send`. */
export type SessionSendResult = SessionSnapshotResult

/** Result of `session.cancel`. */
export type SessionCancelResult = SessionSnapshotResult

/** Result of `session.setWorkspace`. */
export type SessionSetWorkspaceResult = SessionSnapshotResult

/** Result of `session.summary.model.get` and `session.summary.model.set`. */
export interface SessionSummaryModelResult {
  summary: SummarySettingsSnapshot
}

export interface SessionSummaryModelGetParams {}
export interface SessionBackendParams {}

/** Params of `session.summary.model.set`. */
export interface SessionSummaryModelSetParams {
  /** Canonical (provider-independent) model id to persist. */
  canonicalModel: string
}

/**
 * Result of `session.backend`.
 *
 * Main-process diagnostics only — this is the live state of the DSH backend
 * child process. It is never projected to the renderer.
 */
export interface SessionBackendResult {
  state: 'starting' | 'running' | 'stopped' | 'failed'
  pid?: number
  message?: string
  /** DSH runtime version, retained for the product About view. */
  version?: string
}

/**
 * Feature method map. Keys are the exact wire method names.
 *
 * The root map composes this with the other feature maps (see `../index.ts`).
 */
export interface SessionMethods {
  'session.snapshot': RpcMethod<SessionSnapshotParams, SessionSnapshotResult>
  'session.select': RpcMethod<SessionSelectParams, SessionSelectResult>
  'session.create': RpcMethod<SessionCreateParams, SessionCreateResult>
  'session.selectModel': RpcMethod<SessionSelectModelParams, SessionSelectModelResult>
  'session.send': RpcMethod<SessionSendParams, SessionSendResult>
  'session.cancel': RpcMethod<SessionCancelParams, SessionCancelResult>
  'session.setWorkspace': RpcMethod<SessionSetWorkspaceParams, SessionSetWorkspaceResult>
  'session.summary.model.get': RpcMethod<SessionSummaryModelGetParams, SessionSummaryModelResult>
  'session.summary.model.set': RpcMethod<SessionSummaryModelSetParams, SessionSummaryModelResult>
  'session.backend': RpcMethod<SessionBackendParams, SessionBackendResult>
}

/**
 * Session push contract. Deliberately empty: continuous updates are pulled with
 * `session.snapshot` + `waitMs`, so no notification channel exists yet. The
 * interface is kept so the root notification composition stays stable.
 */
export interface SessionNotifications {}
