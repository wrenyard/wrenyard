import type { ReasoningEffort } from '@wrenyard/models'
import type { RpcMethod } from '../common/methods.ts'
import type { AttachmentInput } from './attachments.ts'
import type {
  ContextInspection,
  SessionContextInspectParams,
  SessionRoutesPreviewParams,
  SessionRoutesPreviewResult,
} from './context.ts'
import type {
  SessionCreateParams,
  SessionCreateResult,
  SessionEventsParams,
  SessionEventsResult,
  SessionInterruptParams,
  SessionInterruptResult,
  SessionListParams,
  SessionListResult,
  SessionSendResult,
} from './types.ts'

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
  model: { provider: string; model: string; reasoningEffort: SessionReasoningEffort; fast?: boolean }
  attachments?: AttachmentInput[]
  /** Optional provenance of a bot-originated send; absent on ordinary sends. */
  sender?: { botId: string }
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

/** Params of `session.rename`: one session and its new manual title. */
export interface SessionRenameParams {
  sessionId: string
  title: string
}

/** Result of `session.rename`: empty on success. */
export type SessionRenameResult = Record<string, never>

/** Params of `session.title.regenerate`: the session whose title to generate again. */
export interface SessionTitleRegenerateParams {
  sessionId: string
}

/** Result of `session.title.regenerate`: the new manual title. */
export interface SessionTitleRegenerateResult {
  title: string
}

/**
 * Params of `session.updateMetadata`: one session and the list flags to change.
 * A field that is omitted keeps its prior value; at least one must be present.
 */
export interface SessionUpdateMetadataParams {
  sessionId: string
  archived?: boolean
  pinned?: boolean
}

/** Result of `session.updateMetadata`: empty on success. */
export type SessionUpdateMetadataResult = Record<string, never>

/**
 * Params of `session.prompt.suggest`: one session and the caller-owned request
 * id that correlates its cancel and lets a late result be dropped. The context
 * is read from the session itself — the renderer never supplies conversation
 * text.
 */
export interface SessionPromptSuggestParams {
  sessionId: string
  requestId: string
}

/** Result of `session.prompt.suggest`: one short suggestion, when there is one. */
export interface SessionPromptSuggestResult {
  suggestion?: string
}

/** Params of `session.prompt.cancel`: the request to abort. */
export interface SessionPromptCancelParams {
  sessionId: string
  requestId: string
}

/** Result of `session.prompt.cancel`: empty on success. */
export type SessionPromptCancelResult = Record<string, never>

/** The gateway protocol a selectable main reasoning model runs through. */
export type SessionInferenceMode = 'openai_chat' | 'openai_responses' | 'anthropic_messages'

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
  /** Input modalities supported by this model when declared. */
  capabilities?: readonly ('text' | 'image')[]
  /** Quota provider id backing this model: the catalog `quotaProvider`, else `provider`. */
  quotaProvider?: string
  contextWindow?: number
  maxOutputTokens?: number
  free?: boolean
  effectiveTps?: number | null
  /** Unified quota state of this offering; absent when no quota was assessed. */
  quotaState?: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted'
  /** How that state was obtained; absent when no quota was assessed. */
  quotaEvidence?: 'measured' | 'unknown_by_design' | 'not_obtained'
  /** Per-provider quota summary shown in the model picker group header. */
  providerQuotaSummary?: string
  /** True when a verified, distinct upstream Fast mode exists for this route. */
  supportsFast?: boolean
  /** Circuit state of this model's own route; absent while the route is healthy. */
  routeState?: 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'access_denied' | 'model_unavailable'
  /** Phase of the route: `open` while a fault blocks it. */
  routePhase?: 'closed' | 'open'
  /** When the route admits requests again (ISO 8601), while it is blocked. */
  routeUntil?: string
}

export interface SessionMethods {
  'session.list': RpcMethod<SessionListParams, SessionListResult>
  'session.create': RpcMethod<SessionCreateParams, SessionCreateResult>
  'session.send': RpcMethod<SessionSendParams, SessionSendResult>
  'session.interrupt': RpcMethod<SessionInterruptParams, SessionInterruptResult>
  'session.events': RpcMethod<SessionEventsParams, SessionEventsResult>
  'session.context.inspect': RpcMethod<SessionContextInspectParams, ContextInspection>
  'session.routes.preview': RpcMethod<SessionRoutesPreviewParams, SessionRoutesPreviewResult>
  'session.media.read': RpcMethod<SessionMediaReadParams, SessionMediaReadResult>
  'session.delete': RpcMethod<SessionDeleteParams, SessionDeleteResult>
  'session.rename': RpcMethod<SessionRenameParams, SessionRenameResult>
  'session.title.regenerate': RpcMethod<SessionTitleRegenerateParams, SessionTitleRegenerateResult>
  'session.updateMetadata': RpcMethod<SessionUpdateMetadataParams, SessionUpdateMetadataResult>
  'session.prompt.suggest': RpcMethod<SessionPromptSuggestParams, SessionPromptSuggestResult>
  'session.prompt.cancel': RpcMethod<SessionPromptCancelParams, SessionPromptCancelResult>
}
