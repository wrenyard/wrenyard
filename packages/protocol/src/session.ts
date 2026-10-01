/**
 * Session feature wire DTOs: the read-only context inspection contract.
 *
 * Declared independently of any runtime package, exactly like the provider and
 * exec surfaces: the shapes are structural and describe what crosses the IPC
 * boundary, with no import from `@wrenyard/session` (or any other runtime
 * package). The daemon holds the runtime JSON schema that validates these.
 */
import type { RpcMethod } from './common/methods.ts'

/** Every layer of the main reasoning view except the transient `wy-user`. */
export type ContextLayerId =
  | 'wy-system'
  | 'wy-global'
  | 'wy-role'
  | 'wy-workspace'
  | 'wy-ctx'
  | 'wy-info'

/** How one context item reads in the detailed breakdown. */
export type ContextItemKind =
  | 'user'
  | 'assistant'
  | 'reply'
  | 'doc'
  | 'memory'
  | 'action-result'
  | 'ws-update'
  | 'interrupt'

/** Params of `session.context.inspect`. */
export interface SessionContextInspectParams {
  /** Omitted means a new session: resident layers plus the workspace snapshot. */
  sessionId?: string
  /** Gateway public id of the model the input box currently has selected. */
  model: string
}

/** One layer's token total. */
export interface ContextLayerTokens {
  id: ContextLayerId
  tokens: number
}

/** One rendered context event, for the largest-entries list. */
export interface ContextItem {
  seq: number
  turn: number
  cycle?: number
  kind: ContextItemKind
  label: string
  tokens: number
}

/** Model window facts resolved from the same config as the call budget. */
export interface ContextInspectModel {
  publicId: string
  contextWindow?: number
  maxOutputTokens?: number
}

/** The most recent main-reasoning call that reported usage. */
export interface ContextInspectCalibration {
  callId: string
  model: string
  /** The call's `estimatedInputTokens`. */
  estimated: number
  /** The call's `usage.input` (including cached input). */
  actual: number
}

/** Result of `session.context.inspect`. */
export interface ContextInspection {
  /** Latest ledger `seq` at compute time. */
  computedAtSeq: number
  estimator: 'cl100k_base'
  model: ContextInspectModel
  layers: ContextLayerTokens[]
  items: ContextItem[]
  /** Sum of the reported layers; never includes `wy-user`. */
  totalTokens: number
  calibration?: ContextInspectCalibration
}

export type SessionContextInspectResult = ContextInspection

export interface SessionMethods {
  'session.context.inspect': RpcMethod<SessionContextInspectParams, ContextInspection>
}
