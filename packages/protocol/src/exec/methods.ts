/**
 * The four exec methods.
 *
 * Each method is an explicit named `Params`/`Result` pair plus a descriptor
 * entry in `ExecMethods`. The descriptor map is the single source of truth
 * for typed requests/results; it is a TYPE MAP, not a runtime table.
 *
 * The parameter shapes are the exact wire contract the product feature service
 * implements. They are narrow on purpose: an exec request may select a
 * provider, model, mode, thinking level, working directory, resume session and
 * feature set, and nothing else. There is no field for a process environment,
 * an executable path, a credential, a timeout, a retry policy, or a task id —
 * those are not part of this protocol.
 *
 * Semantics documented here are DRAFT protocol semantics. They describe the
 * contract a future adapter must implement; they are not a claim that any
 * runtime currently provides them.
 */

import type { RpcMethod } from '../common/methods.ts'
import type {
  ExecFeatureId,
  ExecEventEnvelope,
  ExecId,
  ExecSeq,
  ExecSnapshot,
} from './types.ts'

/** Params of `exec.start`. */
export interface ExecStartParams {
  /** Agent client to run, resolved by the caller (for example `codex`). */
  client: string
  /** Upstream provider id the caller already resolved; omitted when unneeded. */
  provider?: string
  /** Public provider-local model id; the daemon resolves native mappings. */
  model: string
  /** Execution mode of the resolved model; omitted when the caller has no plan. */
  mode?: 'native' | 'gateway'
  /** The raw prompt text. It is passed through, never parsed as a task. */
  prompt: string
  /** Absolute working directory for the agent process. */
  cwd: string
  /** Native session id to continue; omitted for a fresh session. */
  resumeSessionId?: string
  /** Thinking/reasoning level selected by the caller. */
  thinking?: string
  /**
   * Configured execution-feature ids to activate. Every id must be known
   * before the child is spawned; an unknown id fails the request.
   */
  features?: readonly ExecFeatureId[]
}

/**
 * Result of `exec.start`.
 *
 * Starting is ACCEPTANCE: the returned snapshot may still be `running`. Follow
 * it with `exec.events` from sequence 0 to observe progress.
 */
export interface ExecStartResult {
  execution: ExecSnapshot
}

/** Params of `exec.get`. */
export interface ExecGetParams {
  id: ExecId
}

/** Result of `exec.get`. */
export interface ExecGetResult {
  execution: ExecSnapshot
}

/** Params of `exec.events`. */
export interface ExecEventsParams {
  id: ExecId
  /**
   * EXCLUSIVE lower bound: only events with `seq > afterSeq` are returned.
   * `0` (or omission) starts from the beginning of retained history, but only
   * if that history has not been trimmed away.
   */
  afterSeq?: ExecSeq
}

/** Result of `exec.events`. */
export interface ExecEventsResult {
  /** Ascending by `seq`, all greater than the requested `afterSeq`. */
  events: ExecEventEnvelope[]
  /**
   * `seq` of the last returned event. On an empty page this retains the input
   * `afterSeq` (or 0), so a client may poll again without advancing.
   */
  nextSeq: ExecSeq
}

/** Params of `exec.cancel`. */
export interface ExecCancelParams {
  id: ExecId
}

/** Result of `exec.cancel`. */
export interface ExecCancelResult {
  id: ExecId
  /**
   * Status after the cancellation request. Cancellation is cooperative, so an
   * already-terminal execution is reported unchanged rather than as an error.
   */
  status: ExecStatus
}

/**
 * Feature method map. Keys are the exact wire method names.
 *
 * The root map composes this interface alongside the session map (see
 * `../index.ts`); conflicting definitions between features are type errors.
 */
export interface ExecMethods {
  'exec.start': RpcMethod<ExecStartParams, ExecStartResult>
  'exec.get': RpcMethod<ExecGetParams, ExecGetResult>
  'exec.events': RpcMethod<ExecEventsParams, ExecEventsResult>
  'exec.cancel': RpcMethod<ExecCancelParams, ExecCancelResult>
}
