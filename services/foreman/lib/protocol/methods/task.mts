import type { JsonRecord, JsonSchema } from '../jsonrpc.mts'
import {
  type TaskResolvedDispatch,
  type TaskUsage,
  taskResolvedDispatchSchema,
  taskUsageSchema,
} from '../task-run-metadata.mts'

const recordSchema = {
  type: 'object',
  additionalProperties: true,
} as const satisfies JsonSchema
const nullableStringSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'null' },
  ],
} as const satisfies JsonSchema

export const taskRunStatusValues = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type TaskRunStatus = typeof taskRunStatusValues[number]

export interface TaskDispatchRequirements {
  expectedTps?: number
  minimumTps?: number
  intelligenceMin?: 'low' | 'mid' | 'high' | 'frontier' | 'premium'
  intelligenceMax?: 'low' | 'mid' | 'high' | 'frontier' | 'premium'
  maxOutputUsdPerMillion?: number
  requiredCapabilities?: readonly ('text' | 'image')[]
  excludeModelIds?: readonly string[]
  excludeProfileIds?: readonly string[]
  excludeClientIds?: readonly string[]
  excludeProviderIds?: readonly string[]
  preferredRuntime?: {
    client: string
    provider: string
    model: string
  }
}

export interface TaskDefinitionSummary {
  name: string
  source: string
  project?: string
  description?: string
  category?: {
    id: string
    displayLabel: string
  }
  agentRuntime?: string
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: 'task_execution'
  scheduling?: 'active' | 'legacy'
  dispatch?: TaskDispatchRequirements
}

export interface TaskDefinitionDetail extends TaskDefinitionSummary {
  path: string
  profile?: string
  input_schema?: unknown
  output_schema?: unknown
  structured?: boolean
  input_example?: JsonRecord
  gates?: {
    pre?: Array<{ id: string; description?: string }>
    post?: Array<{ id: string; description?: string }>
  }
  permission: 'readonly' | 'edit' | 'yolo'
}

export interface TaskDefinitionListParams {
  project?: string
}

export type TaskDefinitionListResult = TaskDefinitionSummary[]

export interface TaskDefinitionDescribeParams {
  task_id: string
  project?: string
}

export type TaskDefinitionDescribeResult = TaskDefinitionDetail

export interface TaskRunCreateParams {
  task_id: string
  project: string
  worktree?: string
  input?: unknown
  /** Bounded JSON-safe KV context inherited by this task run. */
  ctx?: JsonRecord
  /** Optional one-shot invocation settings layer for this run only. Sits at the
   *  top of the field precedence chain (system < builtin < user global < user
   *  per-task < invocation) and is never persisted. */
  invocation_settings?: TaskSettingsLayer
}

export interface TaskRunAccepted {
  id: string
  task_run_id: string
  hint: string
}

export interface TaskInputRequired {
  error_type: 'input_required'
  task: string
  schema?: unknown
  input_example?: unknown
  hint: string
}

export interface TaskInputValidationFailed {
  error_type: 'input_validation_failed'
  task: string
  schema?: unknown
  errors: string[]
  hint: string
}

export interface TaskDefinitionLoadFailed {
  error_type: 'definition_load_failed'
  task: string
  load_error: string
  last_good_available: true
}

export type TaskRunCreateResult =
  | TaskRunAccepted
  | TaskInputRequired
  | TaskInputValidationFailed
  | TaskDefinitionLoadFailed

export interface TaskRunListParams {}

export interface TaskRunListResult {
  tasks: string[]
  count: number
}

export interface TaskRunStatusParams {
  task_run_id: string
}

export interface TaskRunStatusResult {
  task_run_id: string
  task_id: string
  status: TaskRunStatus
  summary?: string
  resolved?: TaskResolvedDispatch
  usage: TaskUsage
  error?: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  has_output?: boolean
  pid?: number
  _meta?: JsonRecord
}

export interface TaskRunOutputParams {
  task_run_id: string
}

export interface TaskRunOutputResult {
  task_run_id: string
  task_id: string
  status: TaskRunStatus
  summary?: string
  resolved?: TaskResolvedDispatch
  usage: TaskUsage
  output: unknown
  error?: string | null
  failure_category?: string
  suggestion?: string
  error_message?: string
  pid?: number
  _meta?: JsonRecord
}

export interface TaskRunWaitParams {
  task_run_id: string
  /**
   * Optional explicit wait deadline (ms). When omitted, task.run.wait waits for
   * the authoritative task terminal with no task-duration deadline. Terminal is
   * defined as done/failed/cancelled/interrupted; a nonterminal result is never
   * returned even when an execution reports terminal first.
   */
  timeout_ms?: number
}

/** Reuses the authoritative complete task run output returned by task.run.output. */
export type TaskRunWaitResult = TaskRunOutputResult

export interface TaskRunCancelParams {
  task_run_id: string
}

export interface TaskRunCancelResult {
  ok: boolean
  task_run_id: string
  status?: TaskRunStatus | string
  message?: string
}

const gateSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
    description: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskCategorySchema = {
  type: 'object',
  required: ['id', 'displayLabel'],
  properties: {
    id: { type: 'string', minLength: 1 },
    displayLabel: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskDispatchRequirementsSchema = {
  type: 'object',
  properties: {
    expectedTps: { type: 'number', exclusiveMinimum: 0 },
    minimumTps: { type: 'number', exclusiveMinimum: 0 },
    intelligenceMin: { enum: ['low', 'mid', 'high', 'frontier', 'premium'] },
    intelligenceMax: { enum: ['low', 'mid', 'high', 'frontier', 'premium'] },
    maxOutputUsdPerMillion: { type: 'number', exclusiveMinimum: 0 },
    requiredCapabilities: { type: 'array', items: { enum: ['text', 'image'] } },
    excludeModelIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProfileIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeClientIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProviderIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    preferredRuntime: {
      type: 'object',
      required: ['client', 'provider', 'model'],
      properties: {
        client: { type: 'string', minLength: 1 },
        provider: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskDefinitionSummarySchema = {
  type: 'object',
  required: ['name', 'source'],
  properties: {
    name: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    category: taskCategorySchema,
    agentRuntime: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'number' },
    effectiveTimeoutMs: { type: 'number' },
    structuredRetryTimeoutMs: { type: 'number' },
    timeoutScope: { enum: ['task_execution'] },
    scheduling: { enum: ['active', 'legacy'] },
    dispatch: taskDispatchRequirementsSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionDetailSchema = {
  type: 'object',
  required: ['name', 'source', 'path', 'permission'],
  properties: {
    name: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    category: taskCategorySchema,
    profile: { type: 'string' },
    input_schema: {},
    output_schema: {},
    structured: { type: 'boolean' },
    input_example: recordSchema,
    gates: {
      type: 'object',
      properties: {
        pre: { type: 'array', items: gateSchema },
        post: { type: 'array', items: gateSchema },
      },
      additionalProperties: true,
    },
    permission: { enum: ['readonly', 'edit', 'yolo'] },
    timeoutMs: { type: 'number' },
    effectiveTimeoutMs: { type: 'number' },
    structuredRetryTimeoutMs: { type: 'number' },
    timeoutScope: { enum: ['task_execution'] },
    scheduling: { enum: ['active', 'legacy'] },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionListParamsSchema = {
  type: 'object',
  properties: {
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionListResultSchema = {
  type: 'array',
  items: taskDefinitionSummarySchema,
} as const satisfies JsonSchema

export const taskDefinitionDescribeParamsSchema = {
  type: 'object',
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionDescribeResultSchema = taskDefinitionDetailSchema

export const taskRunAcceptedSchema = {
  type: 'object',
  required: ['id', 'task_run_id', 'hint'],
  properties: {
    id: { type: 'string', minLength: 1 },
    task_run_id: { type: 'string', minLength: 1 },
    hint: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskInputRequiredSchema = {
  type: 'object',
  required: ['error_type', 'task', 'hint'],
  properties: {
    error_type: { const: 'input_required' },
    task: { type: 'string', minLength: 1 },
    schema: {},
    input_example: {},
    hint: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskInputValidationFailedSchema = {
  type: 'object',
  required: ['error_type', 'task', 'errors', 'hint'],
  properties: {
    error_type: { const: 'input_validation_failed' },
    task: { type: 'string', minLength: 1 },
    schema: {},
    errors: { type: 'array', items: { type: 'string' } },
    hint: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionLoadFailedSchema = {
  type: 'object',
  required: ['error_type', 'task', 'load_error', 'last_good_available'],
  properties: {
    error_type: { const: 'definition_load_failed' },
    task: { type: 'string', minLength: 1 },
    load_error: { type: 'string', minLength: 1 },
    last_good_available: { const: true },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunCreateResultSchema = {
  oneOf: [
    taskRunAcceptedSchema,
    taskInputRequiredSchema,
    taskInputValidationFailedSchema,
    taskDefinitionLoadFailedSchema,
  ],
} as const satisfies JsonSchema

export const taskRunListParamsSchema = {
  type: 'object',
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunListResultSchema = {
  type: 'object',
  required: ['tasks', 'count'],
  properties: {
    tasks: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunStatusParamsSchema = {
  type: 'object',
  required: ['task_run_id'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunStatusResultSchema = {
  type: 'object',
  required: ['task_run_id', 'task_id', 'status', 'usage'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    task_id: { type: 'string', minLength: 1 },
    status: { enum: taskRunStatusValues },
    summary: { type: 'string' },
    resolved: taskResolvedDispatchSchema,
    usage: taskUsageSchema,
    error: nullableStringSchema,
    failure_category: { type: 'string' },
    suggestion: { type: 'string' },
    error_message: { type: 'string' },
    has_output: { type: 'boolean' },
    pid: { type: 'number' },
    _meta: recordSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunOutputParamsSchema = taskRunStatusParamsSchema

export const taskRunOutputResultSchema = {
  type: 'object',
  required: ['task_run_id', 'task_id', 'status', 'output', 'usage'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    task_id: { type: 'string', minLength: 1 },
    status: { enum: taskRunStatusValues },
    summary: { type: 'string' },
    resolved: taskResolvedDispatchSchema,
    usage: taskUsageSchema,
    output: {},
    error: nullableStringSchema,
    failure_category: { type: 'string' },
    suggestion: { type: 'string' },
    error_message: { type: 'string' },
    pid: { type: 'number' },
    _meta: recordSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunCancelParamsSchema = taskRunStatusParamsSchema

export const taskRunCancelResultSchema = {
  type: 'object',
  required: ['ok', 'task_run_id'],
  properties: {
    ok: { type: 'boolean' },
    task_run_id: { type: 'string', minLength: 1 },
    status: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunWaitParamsSchema = {
  type: 'object',
  required: ['task_run_id'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    timeout_ms: { type: 'number', minimum: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunWaitResultSchema = taskRunOutputResultSchema

// ─── task.run.events ──────────────────────────────────────────────────────────

export interface TaskRunEventsParams {
  task_run_id: string
  after_seq?: number
  limit?: number
}

export interface TaskRunEventItem {
  seq: number
  type: string
  timestamp: string
  data: Record<string, unknown>
  status?: string
  exit_code?: number
  is_error?: boolean
}

export interface TaskRunEventsResult {
  task_run_id: string
  events: TaskRunEventItem[]
  next_seq: number
  has_more: boolean
}

const taskRunEventItemSchema = {
  type: 'object',
  required: ['seq', 'type', 'timestamp', 'data'],
  properties: {
    seq: { type: 'integer', minimum: 0 },
    type: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      additionalProperties: true,
    },
    status: { type: 'string' },
    exit_code: { type: 'integer' },
    is_error: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRunEventsParamsSchema = {
  type: 'object',
  required: ['task_run_id'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    after_seq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunEventsResultSchema = {
  type: 'object',
  required: ['task_run_id', 'events', 'next_seq', 'has_more'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    events: {
      type: 'array',
      items: taskRunEventItemSchema,
    },
    next_seq: { type: 'integer', minimum: 0 },
    has_more: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── task.settings.snapshot / task.settings.save / task.run invocation ───────

export type TaskSettingsMode = 'automatic' | 'explicit'

export type TaskSettingsIntelligence = 'low' | 'mid' | 'high' | 'frontier' | 'premium'
export type TaskSettingsCapability = 'text' | 'image'

/** Source layer that supplied an effective settings field; higher index wins. */
export type TaskSettingsSourceLayer =
  | 'system'
  | 'builtin'
  | 'user_global'
  | 'user_task'
  | 'invocation'

/** One exact runtime pin (client/provider/model) usable only in explicit mode. */
export interface TaskSettingsExplicitRuntime {
  client: string
  provider: string
  model: string
}

/**
 * One exact resolved runtime candidate the Tasks surface may pick for explicit
 * mode. Same resolved dispatch fields as a task.run resolved dispatch plus the
 * exact pinned runtime string. Policy aliases (forge/fast/general/ultra) are
 * never eligible choices.
 */
export type TaskSettingsEligibleChoice = TaskResolvedDispatch & { exactAgentRuntime: string }

/** JSON-safe snake_case automatic dispatch fields mirroring TaskDispatchRequirements. */
export interface TaskSettingsAutomaticDispatch {
  expected_tps?: number
  minimum_tps?: number
  intelligence_min?: TaskSettingsIntelligence
  intelligence_max?: TaskSettingsIntelligence
  max_output_usd_per_million?: number
  required_capabilities?: readonly TaskSettingsCapability[]
  exclude_model_ids?: readonly string[]
  exclude_profile_ids?: readonly string[]
  exclude_client_ids?: readonly string[]
  exclude_provider_ids?: readonly string[]
  preferred_runtime?: TaskSettingsExplicitRuntime
}

export type TaskSettingsAutomaticPatch = {
  [K in keyof TaskSettingsAutomaticDispatch]?: TaskSettingsAutomaticDispatch[K] | null
}

/** JSON-safe view of one editable settings layer (user global, user per-task, or invocation). */
export interface TaskSettingsLayer {
  mode?: TaskSettingsMode
  explicit_runtime?: TaskSettingsExplicitRuntime | null
  timeout_ms?: number | null
  additional_instructions?: string | null
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null
}

/** Field-level save patch. `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  mode?: TaskSettingsMode | null
  explicit_runtime?: TaskSettingsExplicitRuntime | null
  timeout_ms?: number | null
  additional_instructions?: string | null
  automatic?: TaskSettingsAutomaticPatch | null
}

/** An effective value plus the layer it came from. */
export interface TaskSettingsSourcedValue<T> {
  value: T
  source: TaskSettingsSourceLayer
}

export interface TaskSettingsEffectiveAutomatic {
  expected_tps: TaskSettingsSourcedValue<number | null>
  minimum_tps: TaskSettingsSourcedValue<number | null>
  intelligence_min: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>
  intelligence_max: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>
  max_output_usd_per_million: TaskSettingsSourcedValue<number | null>
  required_capabilities: TaskSettingsSourcedValue<TaskSettingsCapability[] | null>
  exclude_model_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_profile_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_client_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_provider_ids: TaskSettingsSourcedValue<string[] | null>
  preferred_runtime: TaskSettingsSourcedValue<TaskSettingsExplicitRuntime | null>
}

export interface TaskSettingsEffective {
  mode: TaskSettingsSourcedValue<TaskSettingsMode>
  explicit_runtime: TaskSettingsSourcedValue<TaskSettingsExplicitRuntime | null>
  timeout_ms: TaskSettingsSourcedValue<number | null>
  additional_instructions: TaskSettingsSourcedValue<string | null>
  automatic: TaskSettingsEffectiveAutomatic
}

export interface TaskSettingsValidationIssue {
  code: string
  message: string
  field?: string
}

export interface TaskSettingsRuntimeReadiness {
  /** Exact runtime identity `client/provider/model`. */
  runtime: string
  client: string
  provider: string
  model: string
  daemon: 'accepting' | 'unavailable' | 'unknown'
  provider_credential: 'available' | 'missing' | 'unknown'
  provider_live: 'available' | 'unavailable' | 'unknown'
  quota: 'available' | 'unavailable' | 'unknown'
  available: boolean
  issues: TaskSettingsValidationIssue[]
}

export interface TaskSettingsBuiltinMetadata {
  identity: string
  name: string
  source: string
  description?: string
  project?: string
  /** Read-only builtin prompt template kind. The builtin prompt/required docs are
   *  never editable; customization happens only through plain
   *  `additional_instructions`. */
  prompt_template: 'dynamic' | 'fixed'
  /** Read-only builtin runtime declaration (definition agentRuntime/profile). */
  declared_runtime: string | null
  timeout_ms: number | null
  /** Read-only builtin automatic dispatch defaults. */
  dispatch: TaskSettingsAutomaticDispatch
}

export interface TaskSettingsExplicitRow {
  /** Effective explicit runtime selection. */
  runtime: TaskSettingsExplicitRuntime
  /** Exact candidate runtimes currently resolvable for this task (picker input). */
  choices: TaskSettingsEligibleChoice[]
  /** Exact resolution of `runtime`; null when it cannot resolve without fallback. */
  resolved: TaskSettingsEligibleChoice | null
  /** Non-billable live readiness of the resolved exact runtime. */
  readiness: TaskSettingsRuntimeReadiness | null
}

export interface TaskSettingsTaskRow {
  /** Stable identity: `builtin:<name>` or `project:<project>:<name>`. */
  identity: string
  name: string
  project?: string
  builtin: TaskSettingsBuiltinMetadata
  /** Persisted per-task user layer for this identity. */
  user_task: TaskSettingsLayer
  effective: TaskSettingsEffective
  /**
   * Authoritative list of exact existing runtimes currently resolvable for
   * selecting explicit mode. Present regardless of the effective mode so an
   * automatic row can offer the explicit-mode picker without fabricating a
   * selected explicit runtime.
   */
  runtime_choices: TaskSettingsEligibleChoice[]
  explicit?: TaskSettingsExplicitRow
  issues: TaskSettingsValidationIssue[]
}

export interface TaskSettingsSnapshotParams {
  project?: string
  task_id?: string
}

export interface TaskSettingsSnapshotResult {
  config_path: string
  revision: string
  project?: string
  /** Persisted user-global settings layer. */
  user_global: TaskSettingsLayer
  rows: TaskSettingsTaskRow[]
}

export interface TaskSettingsSaveParams {
  scope: 'global' | 'task'
  task_id?: string
  project?: string
  expected_revision: string
  patch: TaskSettingsPatch
}

export type TaskSettingsSaveResult = TaskSettingsSnapshotResult

// ─── task.settings schemas ───────────────────────────────────────────────────

const taskSettingsModeSchema = {
  enum: ['automatic', 'explicit'],
} as const satisfies JsonSchema

const taskSettingsIntelligenceSchema = {
  enum: ['low', 'mid', 'high', 'frontier', 'premium'],
} as const satisfies JsonSchema

const taskSettingsCapabilitySchema = {
  enum: ['text', 'image'],
} as const satisfies JsonSchema

const taskSettingsSourceLayerSchema = {
  enum: ['system', 'builtin', 'user_global', 'user_task', 'invocation'],
} as const satisfies JsonSchema

export const taskSettingsExplicitRuntimeSchema = {
  type: 'object',
  required: ['client', 'provider', 'model'],
  properties: {
    client: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsNullableExplicitRuntimeSchema = {
  anyOf: [taskSettingsExplicitRuntimeSchema, { type: 'null' }],
} as const satisfies JsonSchema

export const taskSettingsAutomaticDispatchSchema = {
  type: 'object',
  properties: {
    expected_tps: { type: 'number', exclusiveMinimum: 0 },
    minimum_tps: { type: 'number', exclusiveMinimum: 0 },
    intelligence_min: taskSettingsIntelligenceSchema,
    intelligence_max: taskSettingsIntelligenceSchema,
    max_output_usd_per_million: { type: 'number', exclusiveMinimum: 0 },
    required_capabilities: { type: 'array', items: taskSettingsCapabilitySchema },
    exclude_model_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_profile_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_client_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_provider_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    preferred_runtime: taskSettingsExplicitRuntimeSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsNullableAutomaticSchema = {
  anyOf: [taskSettingsAutomaticDispatchSchema, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsAutomaticPatchSchema = {
  type: 'object',
  properties: {
    expected_tps: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    minimum_tps: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    intelligence_min: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    intelligence_max: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    max_output_usd_per_million: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    required_capabilities: { anyOf: [{ type: 'array', items: taskSettingsCapabilitySchema }, { type: 'null' }] },
    exclude_model_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_profile_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_client_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_provider_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    preferred_runtime: { anyOf: [taskSettingsExplicitRuntimeSchema, { type: 'null' }] },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsNullableNumberSchema = {
  anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }],
} as const satisfies JsonSchema

export const taskSettingsLayerSchema = {
  type: 'object',
  properties: {
    mode: taskSettingsModeSchema,
    explicit_runtime: taskSettingsNullableExplicitRuntimeSchema,
    timeout_ms: taskSettingsNullableNumberSchema,
    additional_instructions: nullableStringSchema,
    automatic: taskSettingsNullableAutomaticSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsPatchSchema = {
  type: 'object',
  properties: {
    mode: { anyOf: [taskSettingsModeSchema, { type: 'null' }] },
    explicit_runtime: taskSettingsNullableExplicitRuntimeSchema,
    timeout_ms: taskSettingsNullableNumberSchema,
    additional_instructions: nullableStringSchema,
    automatic: { anyOf: [taskSettingsAutomaticPatchSchema, { type: 'null' }] },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsSourcedModeSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsModeSchema,
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedExplicitRuntimeSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableExplicitRuntimeSchema,
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedNullableNumberSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableNumberSchema,
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedNullableStringSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: nullableStringSchema,
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedNullableStringArraySchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: {
      anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }],
    },
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedCapabilityArraySchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: {
      anyOf: [{ type: 'array', items: taskSettingsCapabilitySchema }, { type: 'null' }],
    },
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedIntelligenceSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedExplicitRuntimeValueSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableExplicitRuntimeSchema,
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsEffectiveAutomaticSchema = {
  type: 'object',
  required: [
    'expected_tps',
    'minimum_tps',
    'intelligence_min',
    'intelligence_max',
    'max_output_usd_per_million',
    'required_capabilities',
    'exclude_model_ids',
    'exclude_profile_ids',
    'exclude_client_ids',
    'exclude_provider_ids',
    'preferred_runtime',
  ],
  properties: {
    expected_tps: taskSettingsSourcedNullableNumberSchema,
    minimum_tps: taskSettingsSourcedNullableNumberSchema,
    intelligence_min: taskSettingsSourcedIntelligenceSchema,
    intelligence_max: taskSettingsSourcedIntelligenceSchema,
    max_output_usd_per_million: taskSettingsSourcedNullableNumberSchema,
    required_capabilities: taskSettingsSourcedCapabilityArraySchema,
    exclude_model_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_profile_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_client_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_provider_ids: taskSettingsSourcedNullableStringArraySchema,
    preferred_runtime: taskSettingsSourcedExplicitRuntimeValueSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsEffectiveSchema = {
  type: 'object',
  required: ['mode', 'explicit_runtime', 'timeout_ms', 'additional_instructions', 'automatic'],
  properties: {
    mode: taskSettingsSourcedModeSchema,
    explicit_runtime: taskSettingsSourcedExplicitRuntimeSchema,
    timeout_ms: taskSettingsSourcedNullableNumberSchema,
    additional_instructions: taskSettingsSourcedNullableStringSchema,
    automatic: taskSettingsEffectiveAutomaticSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsEligibleChoiceSchema = {
  type: 'object',
  required: [
    'exactAgentRuntime',
    'client',
    'provider',
    'model',
    'model_id',
    'mode',
    'speed',
    'intelligence',
    'reference_pricing',
  ],
  properties: {
    exactAgentRuntime: { type: 'string', minLength: 1 },
    requested_agent_runtime: { type: 'string' },
    profile: { type: 'string', minLength: 1 },
    client: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    model_id: { type: 'string', minLength: 1 },
    mode: { enum: ['native', 'gateway'] },
    protocol: { type: 'string', minLength: 1 },
    speed: { type: 'object', additionalProperties: true },
    intelligence: { type: 'string', minLength: 1 },
    reference_pricing: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsValidationIssueSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    field: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsDaemonStatusSchema = {
  enum: ['accepting', 'unavailable', 'unknown'],
} as const satisfies JsonSchema

const taskSettingsProviderStatusSchema = {
  enum: ['available', 'missing', 'unavailable', 'unknown'],
} as const satisfies JsonSchema

const taskSettingsRuntimeReadinessSchema = {
  type: 'object',
  required: [
    'runtime',
    'client',
    'provider',
    'model',
    'daemon',
    'provider_credential',
    'provider_live',
    'quota',
    'available',
    'issues',
  ],
  properties: {
    runtime: { type: 'string', minLength: 1 },
    client: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    daemon: taskSettingsDaemonStatusSchema,
    provider_credential: taskSettingsProviderStatusSchema,
    provider_live: taskSettingsProviderStatusSchema,
    quota: taskSettingsProviderStatusSchema,
    available: { type: 'boolean' },
    issues: { type: 'array', items: taskSettingsValidationIssueSchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsBuiltinMetadataSchema = {
  type: 'object',
  required: ['identity', 'name', 'source', 'prompt_template', 'declared_runtime', 'timeout_ms', 'dispatch'],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    project: { type: 'string', minLength: 1 },
    prompt_template: { enum: ['dynamic', 'fixed'] },
    declared_runtime: nullableStringSchema,
    timeout_ms: { anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] },
    dispatch: taskSettingsAutomaticDispatchSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsExplicitRowSchema = {
  type: 'object',
  required: ['runtime', 'choices', 'resolved', 'readiness'],
  properties: {
    runtime: taskSettingsExplicitRuntimeSchema,
    choices: { type: 'array', items: taskSettingsEligibleChoiceSchema },
    resolved: {
      anyOf: [taskSettingsEligibleChoiceSchema, { type: 'null' }],
    },
    readiness: {
      anyOf: [taskSettingsRuntimeReadinessSchema, { type: 'null' }],
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsTaskRowSchema = {
  type: 'object',
  required: ['identity', 'name', 'builtin', 'user_task', 'effective', 'runtime_choices', 'issues'],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    builtin: taskSettingsBuiltinMetadataSchema,
    user_task: taskSettingsLayerSchema,
    effective: taskSettingsEffectiveSchema,
    runtime_choices: { type: 'array', items: taskSettingsEligibleChoiceSchema },
    explicit: taskSettingsExplicitRowSchema,
    issues: { type: 'array', items: taskSettingsValidationIssueSchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSnapshotParamsSchema = {
  type: 'object',
  properties: {
    project: { type: 'string', minLength: 1 },
    task_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSnapshotResultSchema = {
  type: 'object',
  required: ['config_path', 'revision', 'user_global', 'rows'],
  properties: {
    config_path: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    user_global: taskSettingsLayerSchema,
    rows: { type: 'array', items: taskSettingsTaskRowSchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSaveParamsSchema = {
  type: 'object',
  required: ['scope', 'expected_revision', 'patch'],
  properties: {
    scope: { enum: ['global', 'task'] },
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    expected_revision: { type: 'string', minLength: 1 },
    patch: taskSettingsPatchSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSaveResultSchema = taskSettingsSnapshotResultSchema

export const taskRunCreateParamsSchema = {
  type: 'object',
  required: ['task_id', 'project'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    worktree: { type: 'string', minLength: 1 },
    input: {},
    ctx: recordSchema,
    invocation_settings: taskSettingsLayerSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema
