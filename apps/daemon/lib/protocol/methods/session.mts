import { REASONING_EFFORTS } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'

// The session wire DTOs are declared once in `@wrenyard/protocol/session` and
// re-exported here so every existing daemon import path keeps working, exactly
// like the provider/exec wire types. The runtime JSON schemas stay
// daemon-owned. The session-file / attachment shapes are canonical public
// DTOs and are re-exported too, with no runtime import from the session
// package.
export type {
  SessionContextInspectParams,
  SessionContextInspectResult,
  ContextInspection,
  SessionRoutesPreviewParams,
  SessionRoutesPreviewRole,
  SessionRoutesPreviewResult,
  SessionPromptSuggestParams,
  SessionPromptSuggestResult,
  SessionPromptCancelParams,
  SessionPromptCancelResult,
  AttachmentInput,
  SessionFile,
  SessionListParams,
  SessionListResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionSendParams,
  SessionSendResult,
  SessionInterruptParams,
  SessionInterruptResult,
  SessionEventsParams,
  SessionEventsResult,
  SessionMediaReadParams,
  SessionMediaReadResult,
  SessionDeleteParams,
  SessionDeleteResult,
  SessionRenameParams,
  SessionRenameResult,
  SessionTitleRegenerateParams,
  SessionTitleRegenerateResult,
  SessionUpdateMetadataParams,
  SessionUpdateMetadataResult,
} from '@wrenyard/protocol/session'

const idSchema = { type: 'string', minLength: 1 } as const
// The unified public reasoning-effort enum; a send always names one level.
const reasoningEffortSchema = {
  type: 'string',
  enum: REASONING_EFFORTS,
} as const
const turnSchema = { type: 'integer', minimum: 1 } as const
const seqSchema = { type: 'integer', minimum: 0 } as const
const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema

/** One attachment entry: a readable absolute path or an inline data URL. */
const attachmentInputSchema = {
  type: 'object',
  anyOf: [{ required: ['path'] }, { required: ['dataUrl'] }],
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    name: { type: 'string', minLength: 1, maxLength: 512 },
    dataUrl: { type: 'string', minLength: 1, maxLength: 100_000_000 },
  },
} as const satisfies JsonSchema

export const sessionListParamsSchema = emptySchema
export const sessionCreateParamsSchema = emptySchema
export const sessionInterruptResultSchema = emptySchema
export const sessionListResultSchema = {
  type: 'object', required: ['sessions'], additionalProperties: false,
  properties: { sessions: { type: 'array', items: { type: 'object' } } },
} as const satisfies JsonSchema
export const sessionCreateResultSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionSendParamsSchema = {
  type: 'object', required: ['sessionId', 'text', 'model'], additionalProperties: false,
  properties: {
    sessionId: idSchema,
    text: { type: 'string' },
    model: {
      type: 'object', anyOf: [{ required: ['provider', 'model', 'reasoningEffort'] }, { required: ['auto'] }], additionalProperties: false,
      properties: { provider: idSchema, model: idSchema, reasoningEffort: reasoningEffortSchema, fast: { type: 'boolean' }, auto: { const: true } },
    },
    attachments: { type: 'array', maxItems: 128, items: attachmentInputSchema },
    sender: {
      type: 'object', required: ['botId'], additionalProperties: false,
      properties: { botId: idSchema },
    },
  },
} as const satisfies JsonSchema
export const sessionSendResultSchema = {
  type: 'object', required: ['turn'], additionalProperties: false,
  properties: { turn: turnSchema },
} as const satisfies JsonSchema
export const sessionInterruptParamsSchema = {
  type: 'object', required: ['sessionId', 'turn'], additionalProperties: false,
  properties: { sessionId: idSchema, turn: turnSchema },
} as const satisfies JsonSchema
export const sessionMediaReadParamsSchema = {
  type: 'object', required: ['sessionId', 'path'], additionalProperties: false,
  properties: { sessionId: idSchema, path: { type: 'string', minLength: 1, maxLength: 4096 } },
} as const satisfies JsonSchema
export const sessionMediaReadResultSchema = {
  type: 'object', required: ['path', 'mime'], additionalProperties: false,
  properties: {
    path: { type: 'string', maxLength: 4096 },
    mime: { type: 'string', minLength: 1 },
    dataUrl: { type: 'string' },
  },
} as const satisfies JsonSchema
export const sessionDeleteParamsSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionDeleteResultSchema = emptySchema
export const sessionRenameParamsSchema = {
  type: 'object', required: ['sessionId', 'title'], additionalProperties: false,
  properties: { sessionId: idSchema, title: { type: 'string', minLength: 1 } },
} as const satisfies JsonSchema
export const sessionRenameResultSchema = emptySchema
export const sessionTitleRegenerateParamsSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionTitleRegenerateResultSchema = {
  type: 'object', required: ['title'], additionalProperties: false,
  properties: { title: { type: 'string', minLength: 1 } },
} as const satisfies JsonSchema
export const sessionUpdateMetadataParamsSchema = {
  type: 'object', required: ['sessionId'], additionalProperties: false,
  anyOf: [{ required: ['archived'] }, { required: ['pinned'] }],
  properties: { sessionId: idSchema, archived: { type: 'boolean' }, pinned: { type: 'boolean' } },
} as const satisfies JsonSchema
export const sessionUpdateMetadataResultSchema = emptySchema
export const sessionEventsParamsSchema = {
  type: 'object', required: ['sessionId', 'afterSeq'], additionalProperties: false,
  properties: {
    sessionId: idSchema, afterSeq: seqSchema,
    // One page: 500 events unless the caller asks for more, 1000 at most.
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
    waitMs: { type: 'integer', minimum: 0, maximum: 1000 },
    live: { type: 'boolean' },
  },
} as const satisfies JsonSchema
export const sessionEventsResultSchema = {
  type: 'object', required: ['events', 'lastSeq'], additionalProperties: false,
  properties: {
    events: { type: 'array', items: { type: 'object' } }, lastSeq: seqSchema,
    live: { type: 'array', items: { type: 'object' } },
  },
} as const satisfies JsonSchema

const contextLayerIdSchema = {
  type: 'string',
  enum: ['wy-system', 'wy-global', 'wy-role', 'wy-workspace', 'wy-ctx', 'wy-info'],
} as const

export const sessionContextInspectParamsSchema = {
  type: 'object', required: ['model'], additionalProperties: false,
  properties: { sessionId: idSchema, model: idSchema },
} as const satisfies JsonSchema
export const sessionContextInspectResultSchema = {
  type: 'object',
  required: ['computedAtSeq', 'estimator', 'model', 'layers', 'items', 'totalTokens'],
  additionalProperties: false,
  properties: {
    computedAtSeq: seqSchema,
    estimator: { type: 'string', enum: ['o200k_base'] },
    model: {
      type: 'object', required: ['publicId'], additionalProperties: false,
      properties: {
        publicId: idSchema,
        contextWindow: { type: 'integer', minimum: 1 },
        maxOutputTokens: { type: 'integer', minimum: 1 },
      },
    },
    layers: {
      type: 'array', items: {
        type: 'object', required: ['id', 'tokens'], additionalProperties: false,
        properties: { id: contextLayerIdSchema, tokens: { type: 'integer', minimum: 0 } },
      },
    },
    items: {
      type: 'array', items: {
        type: 'object', required: ['seq', 'turn', 'kind', 'label', 'tokens'], additionalProperties: false,
        properties: {
          seq: seqSchema,
          turn: seqSchema,
          step: { type: 'integer', minimum: 0 },
          kind: {
            type: 'string',
            enum: [
              'user', 'assistant', 'thinking', 'reply', 'doc', 'search', 'memory',
              'files', 'action-result', 'ws-update', 'interrupt', 'error',
            ],
          },
          label: { type: 'string' },
          tokens: { type: 'integer', minimum: 0 },
        },
      },
    },
    totalTokens: { type: 'integer', minimum: 0 },
    calibration: {
      type: 'object', required: ['spanId', 'model', 'estimated', 'actual'], additionalProperties: false,
      properties: {
        spanId: idSchema,
        model: idSchema,
        estimated: { type: 'integer', minimum: 0 },
        actual: { type: 'integer', minimum: 0 },
      },
    },
    files: {
      type: 'object', required: ['images', 'omitted'], additionalProperties: false,
      properties: {
        images: { type: 'integer', minimum: 0 },
        omitted: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const satisfies JsonSchema

const auxiliaryRouteRoleSchema = {
  type: 'string',
  enum: ['reply', 'dispatch', 'document', 'todo', 'vcs', 'project', 'schedule', 'search', 'memory-search', 'title', 'status', 'suggestion'],
} as const

export const sessionRoutesPreviewParamsSchema = {
  type: 'object', additionalProperties: false,
  properties: { sessionId: idSchema },
} as const satisfies JsonSchema
export const sessionRoutesPreviewResultSchema = {
  type: 'object', required: ['roles'], additionalProperties: false,
  properties: {
    roles: {
      type: 'array', items: {
        type: 'object', required: ['role'], additionalProperties: false,
        properties: {
          role: auxiliaryRouteRoleSchema,
          model: { type: 'string', minLength: 1 },
          modelName: { type: 'string', minLength: 1 },
          contextWindow: { type: 'integer', minimum: 1 },
          reasoningEffort: reasoningEffortSchema,
          error: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const satisfies JsonSchema

export const sessionPromptSuggestParamsSchema = {
  type: 'object', required: ['sessionId', 'requestId'], additionalProperties: false,
  properties: { sessionId: idSchema, requestId: idSchema },
} as const satisfies JsonSchema
export const sessionPromptSuggestResultSchema = {
  type: 'object', additionalProperties: false,
  properties: { suggestion: { type: 'string', minLength: 1 } },
} as const satisfies JsonSchema
export const sessionPromptCancelParamsSchema = {
  type: 'object', required: ['sessionId', 'requestId'], additionalProperties: false,
  properties: { sessionId: idSchema, requestId: idSchema },
} as const satisfies JsonSchema
export const sessionPromptCancelResultSchema = emptySchema
