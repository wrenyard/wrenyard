/**
 * Session feature wire DTOs: the read-only context inspection contract.
 *
 * Declared independently of any runtime package, exactly like the provider and
 * exec surfaces: the shapes are structural and describe what crosses the IPC
 * boundary, with no import from `@wrenyard/session` (or any other runtime
 * package). The daemon holds the runtime JSON schema that validates these.
 */
import type { ReasoningEffort } from '@wrenyard/models'
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
  | 'thinking'
  | 'reply'
  | 'doc'
  | 'doc-search'
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
  callId: string
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
  estimator: 'cl100k_base'
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

/** A user attachment crossing IPC. Exactly one of `path` / `dataUrl` is set. */
export interface AttachmentInput {
  path?: string
  name?: string
  dataUrl?: string
}

/** Metadata for one session file; never carries file bytes. */
export interface SessionFile {
  /** Canonical absolute public path of the original file. */
  path: string
  name: string
  kind: 'image' | 'file'
  mime: string
  bytes: number
  hash: string
  source: 'user' | 'task'
  description: string
  width?: number
  height?: number
  taskRunId?: string
  actionId?: string
  role?: string
  text?: string
  tokens?: number
  totalTokens?: number
  truncated?: boolean
  processedPath?: string
  processedMime?: string
  processedWidth?: number
  processedHeight?: number
  processedBytes?: number
}

/**
 * The unified public reasoning-effort ladder. Declared here as a plain string
 * union so the wire DTO stays independent of any runtime package; it mirrors
 * the exact vocabulary `@wrenyard/models` owns.
 */
export type SessionReasoningEffort = ReasoningEffort

/** Params of `session.send`, with the optional attachment batch. */
export interface SessionSendParams {
  sessionId: string
  text: string
  model: { provider: string; model: string; reasoningEffort: SessionReasoningEffort }
  attachments?: AttachmentInput[]
}

/** Params of `session.media.read`: one session file by its canonical path. */
export interface SessionMediaReadParams {
  sessionId: string
  /** The session file's canonical absolute path. */
  path: string
}

/**
 * Result of `session.media.read`: the reference's canonical path and MIME type.
 * `dataUrl` is present only when a bounded image preview was produced; a
 * non-image (or non-previewable) reference returns metadata only.
 */
export interface SessionMediaReadResult {
  path: string
  mime: string
  dataUrl?: string
}

/** Params of `session.delete`. */
export interface SessionDeleteParams {
  sessionId: string
}

/** Result of `session.delete`: empty on success. */
export type SessionDeleteResult = Record<string, never>

/** The gateway protocol a selectable main reasoning model runs through. */
export type SessionInferenceMode = 'openai_chat' | 'openai_responses'

/**
 * One selectable main-session model row: the shared supply DTO consumed by the
 * composer and the settings model pickers. `runtime` is the one inference mode
 * chosen for this row; the remaining facts mirror the provider catalog so the
 * picker can render descriptive tooltips and badges without re-resolving.
 */
export interface SessionModelEntry {
  /** Provider/model public id, exactly `provider/model`. */
  publicId: string
  provider: string
  providerDisplayName: string
  model: string
  displayName: string
  runtime: SessionInferenceMode
  /** Required non-empty route-owned reasoning levels this model can materialize. */
  reasoningEfforts: ReasoningEffort[]
  /** Quota provider id backing this model: the catalog `quotaProvider`, else `provider`. */
  quotaProvider?: string
  contextWindow?: number
  maxOutputTokens?: number
  free?: boolean
  effectiveTps?: number | null
  quotaAbundant?: boolean
}

export interface SessionMethods {
  'session.context.inspect': RpcMethod<SessionContextInspectParams, ContextInspection>
  'session.media.read': RpcMethod<SessionMediaReadParams, SessionMediaReadResult>
  'session.delete': RpcMethod<SessionDeleteParams, SessionDeleteResult>
}
