/**
 * Session context inspection and auxiliary route preview wire DTOs.
 */
import type { ReasoningEffort } from '@wrenyard/models'

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
  | 'thinking'
  | 'reply'
  | 'doc'
  | 'search'
  | 'memory'
  | 'files'
  | 'action-result'
  | 'ws-update'
  | 'interrupt'
  | 'error'

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
  spanId: string
  model: string
  /** The call's `estimatedInputTokens`. */
  estimated: number
  /** The call's `usage.input` (including cached input). */
  actual: number
}

/** Persisted session-file image counts for the inspected model. */
export interface ContextInspectFiles {
  /** Images eligible for the inspected model (prepared preview, not degraded). */
  images: number
  /** Images omitted: degraded, unprepared, or invisible to the inspected model. */
  omitted: number
}

/** Result of `session.context.inspect`. */
export interface ContextInspection {
  /** Latest ledger `seq` at compute time. */
  computedAtSeq: number
  estimator: 'o200k_base'
  model: ContextInspectModel
  layers: ContextLayerTokens[]
  items: ContextItem[]
  /** Sum of the reported layers; never includes `wy-user`. */
  totalTokens: number
  calibration?: ContextInspectCalibration
  /** Persisted session-file image counts, when the timeline carries any. */
  files?: ContextInspectFiles
}

export type SessionContextInspectResult = ContextInspection

/** Params of `session.routes.preview`. */
export interface SessionRoutesPreviewParams {
  /** Omitted means a new session; the preview is session-independent. */
  sessionId?: string
}

/**
 * One auxiliary role's rank-1 route preview. A role the selector cannot serve
 * carries `error` and no model; the model facts are the catalog display name and
 * window.
 */
export interface SessionRoutesPreviewRole {
  /** Auxiliary conversation role, in the fixed order the preview lists them. */
  role: 'reply' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'schedule' | 'search' | 'memory-search' | 'title' | 'status' | 'suggestion' | 'task-output'
  model?: string
  modelName?: string
  contextWindow?: number
  /** Reasoning effort the rank-1 route would be called at; absent on error. */
  reasoningEffort?: ReasoningEffort
  error?: string
}

/** Result of `session.routes.preview`. */
export interface SessionRoutesPreviewResult {
  roles: SessionRoutesPreviewRole[]
}
