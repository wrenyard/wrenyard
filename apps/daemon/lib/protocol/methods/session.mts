import type { JsonSchema } from '../jsonrpc.mts'
import type {
  ConversationSnapshot,
  SessionBackendResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionSelectModelParams,
  SessionSelectModelResult,
  SessionSelectParams,
  SessionSelectResult,
  SessionSendParams,
  SessionSendResult,
  SessionSetWorkspaceParams,
  SessionSetWorkspaceResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionSummaryModelResult,
  SessionSummaryModelSetParams,
  SummarySettingsSnapshot,
  WorkspaceConfigurationSnapshot,
} from '@wrenyard/protocol/session'

// Wire DTOs are declared once in @wrenyard/protocol/session and re-exported
// here so every daemon import path keeps working. The runtime JSON schemas
// below stay daemon-owned: they are the only validation the daemon performs on
// session params/results.
export type {
  ConversationSnapshot,
  SessionBackendResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionSelectModelParams,
  SessionSelectModelResult,
  SessionSelectParams,
  SessionSelectResult,
  SessionSendParams,
  SessionSendResult,
  SessionSetWorkspaceParams,
  SessionSetWorkspaceResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionSummaryModelResult,
  SessionSummaryModelSetParams,
  SummarySettingsSnapshot,
  WorkspaceConfigurationSnapshot,
}

export type { SessionSummaryModelGetParams, SessionBackendParams } from '@wrenyard/protocol/session'

const workspaceConfigurationSchema = {
  type: 'object',
  required: ['status', 'source', 'configPath', 'readOnly'],
  properties: {
    status: { enum: ['configured', 'missing', 'invalid'] },
    source: { enum: ['environment', 'user-config', 'none'] },
    configPath: { type: 'string' },
    path: { type: 'string' },
    message: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRunSpeedSchema = {
  type: 'object',
  required: ['effectiveTps', 'source', 'sampleCount', 'expectedTpsMet'],
  properties: {
    effectiveTps: { type: 'number', minimum: 0 },
    source: { enum: ['local_31d', 'provider_override', 'catalog_default'] },
    sampleCount: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    expectedTpsMet: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    degradationReason: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRunUsageSchema = {
  type: 'object',
  required: ['completeness', 'attemptCount', 'usageEventCount', 'referenceCostComplete'],
  properties: {
    completeness: { enum: ['complete', 'partial', 'unavailable'] },
    attemptCount: { type: 'number', minimum: 0 },
    usageEventCount: { type: 'number', minimum: 0 },
    inputTokens: { type: 'number', minimum: 0 },
    cachedInputTokens: { type: 'number', minimum: 0 },
    cacheReadInputTokens: { type: 'number', minimum: 0 },
    cacheCreationInputTokens: { type: 'number', minimum: 0 },
    outputTokens: { type: 'number', minimum: 0 },
    totalTokens: { type: 'number', minimum: 0 },
    generationMs: { type: 'number', minimum: 0 },
    outputTps: { type: 'number', minimum: 0 },
    tpsContract: { const: 'tokenizer_v1' },
    referenceCostUsd: { type: 'number', minimum: 0 },
    referenceCostComplete: { type: 'boolean' },
    referenceCostBasis: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRunSchema = {
  type: 'object',
  required: ['taskRunId', 'taskId', 'usage'],
  properties: {
    taskRunId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    taskName: { type: 'string' },
    source: { enum: ['builtin', 'project', 'unknown'] },
    project: { type: 'string' },
    status: { enum: ['done', 'failed', 'cancelled', 'interrupted', 'running', 'queued'] },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    resolvedClient: { type: 'string' },
    resolvedProvider: { type: 'string' },
    resolvedProfile: { type: 'string' },
    resolvedModel: { type: 'string' },
    resolvedModelId: { type: 'string' },
    resolvedProviderDisplayName: { type: 'string' },
    resolvedModelDisplayName: { type: 'string' },
    speed: taskRunSpeedSchema,
    usage: taskRunUsageSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationSessionSchema = {
  type: 'object',
  required: ['id', 'title', 'updatedAt', 'running', 'blank'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    updatedAt: { type: 'number' },
    running: { type: 'boolean' },
    blank: { type: 'boolean' },
    agentPreset: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationModelSelectionSchema = {
  type: 'object',
  required: ['provider', 'catalogProvider', 'model', 'label', 'providerLabel', 'advertised', 'configured'],
  properties: {
    provider: { type: 'string' },
    catalogProvider: { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    providerLabel: { type: 'string' },
    advertised: { type: 'boolean' },
    configured: { type: 'boolean' },
    reasoningEffort: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationModelOptionSchema = {
  type: 'object',
  required: ['provider', 'catalogProvider', 'providerLabel', 'model', 'label'],
  properties: {
    provider: { type: 'string' },
    catalogProvider: { type: 'string' },
    providerLabel: { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    defaultReasoningEffort: { type: 'string' },
    reasoningEfforts: { type: 'array', items: { type: 'string' } },
    inputTypes: { type: 'array', uniqueItems: true, items: { enum: ['text', 'image'] } },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationModelGroupSchema = {
  type: 'object',
  required: ['provider', 'label', 'models'],
  properties: {
    provider: { type: 'string' },
    label: { type: 'string' },
    models: { type: 'array', items: conversationModelOptionSchema },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationModelsSchema = {
  type: 'object',
  required: ['status', 'groups'],
  properties: {
    status: { enum: ['idle', 'loading', 'ready', 'error'] },
    groups: { type: 'array', items: conversationModelGroupSchema },
    current: conversationModelSelectionSchema,
    routable: { type: 'boolean' },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationItemSchema = {
  type: 'object',
  required: ['id', 'kind', 'text', 'time'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { enum: ['user', 'assistant', 'tool'] },
    text: { type: 'string' },
    time: { type: 'number' },
    turnId: { type: 'string' },
    running: { type: 'boolean' },
    toolName: { type: 'string' },
    toolState: { enum: ['running', 'done', 'failed'] },
    toolResultText: { type: 'string' },
    taskRun: taskRunSchema,
    step: { type: 'number' },
    toolSummary: { type: 'string' },
    documentLinks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'path'],
        properties: {
          title: { type: 'string' },
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationTurnSchema = {
  type: 'object',
  required: ['id', 'startedAt', 'running', 'dispatchCount'],
  properties: {
    id: { type: 'string', minLength: 1 },
    startedAt: { type: 'number' },
    endedAt: { type: 'number' },
    running: { type: 'boolean' },
    finalItemId: { type: 'string' },
    progressItemId: { type: 'string' },
    pendingTaskCount: { type: 'number', minimum: 0 },
    dispatchCount: { type: 'number', minimum: 0 },
    inputTokens: { type: 'number', minimum: 0 },
    outputTokens: { type: 'number', minimum: 0 },
    outputTps: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const conversationSchema = {
  type: 'object',
  required: ['status', 'workspace', 'sessions', 'selectedRunning', 'models', 'hasMore', 'items'],
  properties: {
    status: { enum: ['ready', 'workspace-required', 'unavailable'] },
    workspace: workspaceConfigurationSchema,
    sessions: { type: 'array', items: conversationSessionSchema },
    selectedSessionId: { type: 'string' },
    selectedTitle: { type: 'string' },
    selectedRunning: { type: 'boolean' },
    models: conversationModelsSchema,
    hasMore: { type: 'boolean' },
    items: { type: 'array', items: conversationItemSchema },
    turns: { type: 'array', items: conversationTurnSchema },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const summaryModelOptionSchema = {
  type: 'object',
  required: ['canonicalModel', 'displayName', 'available'],
  properties: {
    canonicalModel: { type: 'string', minLength: 1 },
    publicId: { type: 'string' },
    displayName: { type: 'string' },
    providerLabel: { type: 'string' },
    available: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const summarySettingsSchema = {
  type: 'object',
  required: ['selectedCanonicalModel', 'options', 'unresolved'],
  properties: {
    selectedCanonicalModel: { type: 'string' },
    options: { type: 'array', items: summaryModelOptionSchema },
    unresolved: { type: 'boolean' },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSnapshotParamsSchema = {
  type: 'object',
  properties: {
    afterRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    waitMs: { type: 'number', minimum: 0, maximum: 1000 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSnapshotResultSchema = {
  type: 'object',
  required: ['conversation', 'revision'],
  properties: {
    conversation: conversationSchema,
    revision: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// Every action resolves with the same versioned snapshot envelope.
export const sessionSelectResultSchema = sessionSnapshotResultSchema
export const sessionCreateResultSchema = sessionSnapshotResultSchema
export const sessionSelectModelResultSchema = sessionSnapshotResultSchema
export const sessionSendResultSchema = sessionSnapshotResultSchema
export const sessionCancelResultSchema = sessionSnapshotResultSchema
export const sessionSetWorkspaceResultSchema = sessionSnapshotResultSchema

export const sessionSelectParamsSchema = {
  type: 'object',
  required: ['sessionId'],
  properties: {
    sessionId: { type: 'string', minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionCreateParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSelectModelParamsSchema = {
  type: 'object',
  required: ['provider', 'model'],
  properties: {
    provider: { type: 'string', minLength: 1, maxLength: 200 },
    model: { type: 'string', minLength: 1, maxLength: 512 },
    reasoningEffort: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSendParamsSchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4_000_000 },
    clientTimeZone: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionCancelParamsSchema = {
  type: 'object',
  properties: {
    turnId: { type: 'string', minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSetWorkspaceParamsSchema = {
  type: 'object',
  required: ['workspace'],
  properties: {
    workspace: workspaceConfigurationSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSummaryModelGetParamsSchema = sessionCreateParamsSchema

export const sessionSummaryModelSetParamsSchema = {
  type: 'object',
  required: ['canonicalModel'],
  properties: {
    canonicalModel: { type: 'string', minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionSummaryModelResultSchema = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: summarySettingsSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const sessionBackendParamsSchema = sessionCreateParamsSchema

export const sessionBackendResultSchema = {
  type: 'object',
  required: ['state'],
  properties: {
    state: { enum: ['starting', 'running', 'stopped', 'failed'] },
    pid: { type: 'number', minimum: 1 },
    version: { type: 'string' },
    message: { type: 'string', maxLength: 2000 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
