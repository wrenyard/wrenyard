/**
 * Session feature wire DTOs: the read-only context inspection and auxiliary
 * route preview contracts.
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
  role: 'reply' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'schedule' | 'search' | 'memory-search' | 'title' | 'status' | 'suggestion'
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

// ─── Attachment reference links ─────────────────────────────────────────────

/**
 * The reserved host of every attachment reference URL. It is a fixed
 * `.invalid` name (RFC 2606), so it can never resolve; the desktop renderer
 * recognizes it and never opens it externally.
 */
export const ATTACHMENT_REF_HOST = 'wrenyard.invalid';

/** The fixed path prefix under {@link ATTACHMENT_REF_HOST}. */
const ATTACHMENT_REF_PREFIX = '/attachments/';

/**
 * The exact, fully anchored shape of one attachment reference URL. Only this
 * shape is a reference: no filesystem-path heuristic on the query value is
 * ever applied.
 */
const ATTACHMENT_REF_PATTERN = /^https:\/\/wrenyard\.invalid\/attachments\/([^/?#]+)\?path=([^#]*)$/u;

/** The scheme-and-authority head of a URL, for the reserved-host judgement. */
const URL_AUTHORITY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u;

/**
 * One attachment reference identity. Both fields participate: the same
 * canonical path with a different hash, or the same hash with a different
 * path, is a different reference.
 */
export interface AttachmentRef {
  /** Canonical absolute public path of the session file. */
  path: string;
  /** The session file's content hash. */
  hash: string;
}

/**
 * The RFC 3986 sub-delimiters that `encodeURIComponent` leaves literal but a
 * Markdown link destination cannot carry: an unbalanced `)` in a filename
 * would otherwise close the `[label](url)` link early.
 */
const ATTACHMENT_REF_SUB_DELIMITERS = /[!'()*]/gu

/**
 * Encode one attachment reference component (hash or path) so the resulting URL
 * survives Markdown link parsing byte-for-byte. {@link parseAttachmentRefUrl}
 * decodes it back to the exact original value.
 */
function encodeAttachmentRefComponent(value: string): string {
  return encodeURIComponent(value).replace(
    ATTACHMENT_REF_SUB_DELIMITERS,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

/**
 * Build the stable, model-opaque HTTPS reference URL of one session file:
 * `https://wrenyard.invalid/attachments/<hash>?path=<canonicalPath>`. The
 * canonical path is URI-encoded verbatim, so Windows separators, Unicode and
 * spaces survive unchanged, and RFC 3986 sub-delimiters are escaped so the URL
 * stays a valid Markdown link destination. The same path and hash always
 * reproduce the same URL, and only {@link SessionFile} metadata is read.
 */
export function attachmentRefUrl(file: Pick<SessionFile, 'path' | 'hash'>): string {
  const hash = encodeAttachmentRefComponent(file.hash)
  const path = encodeAttachmentRefComponent(file.path)
  return `https://${ATTACHMENT_REF_HOST}${ATTACHMENT_REF_PREFIX}${hash}?path=${path}`
}

/**
 * Parse one attachment reference URL by exact match. Returns the identity, or
 * `undefined` for anything that is not exactly this contract's shape. A
 * malformed escape or an empty path / hash is not a reference.
 */
export function parseAttachmentRefUrl(url: string): AttachmentRef | undefined {
  const match = ATTACHMENT_REF_PATTERN.exec(url);
  if (match === null) return undefined;
  try {
    const hash = decodeURIComponent(match[1]!);
    const path = decodeURIComponent(match[2]!);
    return hash === '' || path === '' ? undefined : { path, hash };
  } catch {
    return undefined;
  }
}

/**
 * True when a URL addresses the reserved attachment host, whatever the rest of
 * its shape. The renderer uses this to degrade an unknown or malformed
 * reference instead of opening it externally.
 */
export function isAttachmentRefHost(url: string): boolean {
  const match = URL_AUTHORITY_PATTERN.exec(url);
  if (match === null) return false;
  const authority = match[1]!;
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/u, '');
  return host.toLowerCase() === ATTACHMENT_REF_HOST;
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
  model: { provider: string; model: string; reasoningEffort: SessionReasoningEffort; fast?: boolean }
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
