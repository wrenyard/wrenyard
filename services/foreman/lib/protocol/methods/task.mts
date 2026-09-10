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
  intelligenceMin?: 'low' | 'mid' | 'high' | 'premium'
  intelligenceMax?: 'low' | 'mid' | 'high' | 'premium'
  intelligenceExpected?: 'low' | 'mid' | 'high' | 'premium'
  maxOutputUsdPerMillion?: number
  requiredCapabilities?: readonly ('text' | 'image')[]
  excludeModelIds?: readonly string[]
  excludeProfileIds?: readonly string[]
  excludeClientIds?: readonly string[]
  excludeProviderIds?: readonly string[]
  /** Hidden dispatch requirement: the dispatched plan must admit native web
   *  search. Enforced as a hard gate; never surfaced in any search settings UI. */
  requiresWebSearch?: boolean
}

export interface TaskDefinitionSummary {
  name: string
  /** Authoritative human-readable task label parsed from the definition;
   *  consumers fall back to the exact task `name`. */
  displayName?: string
  source: string
  project?: string
  description?: string
  category?: {
    id: string
    displayLabel: string
  }
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
    intelligenceMin: { enum: ['low', 'mid', 'high', 'premium'] },
    intelligenceMax: { enum: ['low', 'mid', 'high', 'premium'] },
    intelligenceExpected: { enum: ['low', 'mid', 'high', 'premium'] },
    maxOutputUsdPerMillion: { type: 'number', exclusiveMinimum: 0 },
    requiredCapabilities: { type: 'array', items: { enum: ['text', 'image'] } },
    excludeModelIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProfileIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeClientIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProviderIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresWebSearch: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskDefinitionSummarySchema = {
  type: 'object',
  required: ['name', 'source'],
  properties: {
    name: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    category: taskCategorySchema,
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
    displayName: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    category: taskCategorySchema,
    profile: { type: 'string' },
    input_schema: {},
    output_schema: {},
    /** Same four-tier dispatch contract as the summary schema: definition output
     *  is strictly current and rejects the legacy `frontier` alias. */
    dispatch: taskDispatchRequirementsSchema,
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

export type TaskSettingsIntelligence = 'low' | 'mid' | 'high' | 'premium'
export type TaskSettingsCapability = 'text' | 'image'

/** Source layer that supplied an effective settings field; higher index wins. */
export type TaskSettingsSourceLayer =
  | 'system'
  | 'builtin'
  | 'user_global'
  | 'user_task'
  | 'invocation'

/** One exact resolved runtime triple used only where automatic selection or
 *  resolved provider readiness genuinely needs client/provider/model. Never a
 *  user selection: explicit mode stores a structural reference instead, and
 *  execution resolves it to a canonical run target. */
export interface TaskSettingsRuntimeTriple {
  client: string
  provider: string
  model: string
}

/**
 * Structural explicit selection stored by Task settings. Explicit mode either
 * names a runtime alias (resolved through the runtime-alias protocol) or an
 * inline exact run target. A resolved client/provider/model triple is never
 * stored or copied back as the selection.
 */
export type TaskSettingsExplicitReference =
  | { kind: 'alias'; name: string }
  | { kind: 'target'; target: string }

/** JSON-safe snake_case automatic dispatch fields mirroring TaskDispatchRequirements. */
export interface TaskSettingsAutomaticDispatch {
  expected_tps?: number
  minimum_tps?: number
  intelligence_min?: TaskSettingsIntelligence
  intelligence_max?: TaskSettingsIntelligence
  intelligence_expected?: TaskSettingsIntelligence
  max_output_usd_per_million?: number
  required_capabilities?: readonly TaskSettingsCapability[]
  exclude_model_ids?: readonly string[]
  exclude_profile_ids?: readonly string[]
  exclude_client_ids?: readonly string[]
  exclude_provider_ids?: readonly string[]
  /** Hidden web search requirement; mirrors TaskDispatchRequirements.requiresWebSearch. Not a UI control. */
  requires_web_search?: boolean
}

export type TaskSettingsAutomaticPatch = {
  [K in keyof TaskSettingsAutomaticDispatch]?: TaskSettingsAutomaticDispatch[K] | null
}

/** JSON-safe view of one editable settings layer (user global, user per-task, or invocation). */
export interface TaskSettingsLayer {
  mode?: TaskSettingsMode
  explicit_runtime?: TaskSettingsExplicitReference | null
  timeout_ms?: number | null
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null
  /** Global-only auto reference-price ceiling (finite USD per million output
   *  tokens >= 0); null clears it. Never valid inside `automatic`. */
  max_auto_output_usd_per_million?: number | null
}

/** Field-level save patch. `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  mode?: TaskSettingsMode | null
  explicit_runtime?: TaskSettingsExplicitReference | null
  timeout_ms?: number | null
  automatic?: TaskSettingsAutomaticPatch | null
  /** Global-only: set (>= 0) or clear (null) the auto reference-price ceiling. */
  max_auto_output_usd_per_million?: number | null
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
  intelligence_expected: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>
  max_output_usd_per_million: TaskSettingsSourcedValue<number | null>
  required_capabilities: TaskSettingsSourcedValue<TaskSettingsCapability[] | null>
  exclude_model_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_profile_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_client_ids: TaskSettingsSourcedValue<string[] | null>
  exclude_provider_ids: TaskSettingsSourcedValue<string[] | null>
  /** Hidden web search requirement; sourced from the same dispatch merge. Not a UI control. */
  requires_web_search?: TaskSettingsSourcedValue<boolean | null>
}

export interface TaskSettingsEffective {
  mode: TaskSettingsSourcedValue<TaskSettingsMode>
  explicit_runtime: TaskSettingsSourcedValue<TaskSettingsExplicitReference | null>
  timeout_ms: TaskSettingsSourcedValue<number | null>
  automatic: TaskSettingsEffectiveAutomatic
  /** Global-only auto ceiling; sourced exclusively from the user_global layer. */
  max_auto_output_usd_per_million: TaskSettingsSourcedValue<number | null>
}

/** Wire-owned closed resolution-failure code. Mirrors the structurally
 *  compatible core value without importing core modules into the protocol. */
export type TaskResolutionFailureCode =
  | 'no_available_provider'
  | 'price_limit'
  | 'intelligence_requirement'
  | 'speed_requirement'
  | 'quota_unavailable'
  | 'quota_insufficient'

/** Wire-owned closed resolution-failure detail carried on a validation issue. */
export interface TaskResolutionFailure {
  code: TaskResolutionFailureCode
  message: string
}

export interface TaskSettingsValidationIssue {
  code: string
  message: string
  field?: string
  resolutionFailure?: TaskResolutionFailure
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

/** One ordered, non-executing preview segment of a builtin prompt template. */
export type TaskSettingsInstructionSegment =
  /** Static instruction text carried verbatim; renderers escape before display. */
  | { kind: 'text'; source: string; text: string }
  /** A non-executed function instruction or the input-dependent prompt body. */
  | { kind: 'placeholder'; source: string; label: string }

/** Ordered safe preview of the builtin prompt template; never executes config. */
export type TaskSettingsInstructionTemplate = TaskSettingsInstructionSegment[]

export interface TaskSettingsBuiltinMetadata {
  identity: string
  name: string
  source: string
  description?: string
  project?: string
  /** Read-only builtin prompt template kind. The builtin prompt/required docs
   *  are never editable. */
  prompt_template: 'dynamic' | 'fixed'
  /** Ordered non-executing preview segments of the builtin prompt template. */
  instruction_template: TaskSettingsInstructionTemplate
  timeout_ms: number | null
  /** Read-only builtin automatic dispatch defaults. */
  dispatch: TaskSettingsAutomaticDispatch
}

/** Task-settings-resolved dispatch augmented with additive authoritative
 *  Catalog display labels. Canonical ids and every existing wire field are
 *  kept; the display labels are optional and always travel as a pair. */
export type TaskSettingsResolvedDispatch = TaskResolvedDispatch & {
  /** Authoritative Catalog provider display label; paired with `model_display_name`. */
  provider_display_name?: string
  /** Authoritative unified Catalog model display label; paired with `provider_display_name`. */
  model_display_name?: string
}

export interface TaskSettingsExplicitRow {
  /** Stored structural selection: a runtime alias or an inline exact run target.
   *  Never a copied resolved client/provider/model triple. */
  reference: TaskSettingsExplicitReference
  /** Canonical exact run target (for example `openai/gpt-5.6-sol:codex`) when
   *  `reference` resolves; null when it cannot resolve without fallback. */
  resolved_target: string | null
  /** Exact resolved dispatch of the canonical target; null while unresolved. */
  resolved: TaskSettingsResolvedDispatch | null
  /** Non-billable live readiness of the resolved exact runtime. */
  readiness: TaskSettingsRuntimeReadiness | null
}

/**
 * Safe automatic-mode preview selection attached to an automatic row. The
 * resolved dispatch carries the optional privacy-safe auto_routing decision;
 * no raw quota/account/domain/credential/provider-error fields are exposed.
 */
export interface TaskSettingsAutomaticSelection {
  /** Canonical exact run target of the selected automatic dispatch. */
  exact_runtime: string
  /** Exact resolved automatic dispatch including the safe auto_routing decision
   *  and the additive authoritative Catalog display labels. */
  resolved: TaskSettingsResolvedDispatch
  /** Safe human-readable reason for the automatic selection. */
  reason: string
}

export interface TaskSettingsTaskRow {
  /** Stable identity: `builtin:<name>` or `project:<project>:<name>`. */
  identity: string
  name: string
  /** Authoritative display label; falls back to the exact task `name`. */
  display_name: string
  project?: string
  /** Authoritative project display label on project rows; falls back to the exact project id. */
  project_display_name?: string
  builtin: TaskSettingsBuiltinMetadata
  /** Persisted per-task user layer for this identity. */
  user_task: TaskSettingsLayer
  effective: TaskSettingsEffective
  /** Present when the effective mode is `explicit`; exposes the stored
   *  structural reference and its exact resolution. */
  explicit?: TaskSettingsExplicitRow
  /** Present when the effective mode is `automatic` and a selection resolved;
   *  exposes the selected automatic dispatch and safe reason. */
  automatic_selection?: TaskSettingsAutomaticSelection
  issues: TaskSettingsValidationIssue[]
}

export interface TaskSettingsSnapshotParams {
  project?: string
  task_id?: string
}

/** One registry task definition load error surfaced out-of-band from executable
 *  settings rows (strict schema failures and duplicate definitions). Errors never
 *  double as executable settings rows. */
export interface TaskSettingsLoadError {
  /** Authoritative path to the definition file that failed to load. */
  source_path: string
  /** Stable raw filename (basename) of the offending definition file. */
  file_name: string
  /** Human-readable load error message. */
  message: string
  /** Registered project id owning the file's directory, when resolvable;
   *  absent when the file is outside any registered project. */
  project?: string
  /** Authoritative `.fmproj` display label for `project`, when known. */
  project_display_name?: string
}

export interface TaskSettingsSnapshotResult {
  config_path: string
  revision: string
  project?: string
  /** Persisted user-global settings layer. */
  user_global: TaskSettingsLayer
  /** Authoritative runtime aliases `[{name,target}]` for the explicit-mode
   *  combobox suggestions (mirrors the runtime-alias protocol snapshot). */
  aliases: Array<{ name: string; target: string }>
  rows: TaskSettingsTaskRow[]
  /** Optional registry task definition load errors (strict schema failures and
   *  duplicate definitions), surfaced separately from executable settings rows.
   *  Absent when the snapshot has no load errors. */
  load_errors?: TaskSettingsLoadError[]
}

export interface TaskSettingsSaveParams {
  scope: 'global' | 'task'
  task_id?: string
  project?: string
  expected_revision: string
  patch: TaskSettingsPatch
}

export type TaskSettingsSaveResult = TaskSettingsSnapshotResult

// ─── task.settings.routingTest ───────────────────────────────────────────────

export interface TaskRoutingTestParams {
  task_id: string
}

/** Actual normalized ranking weights used by the automatic scorer, in the
 *  order price/speed/quota/intelligence. */
export interface TaskRoutingTestRankingWeights {
  price: number
  speed: number
  quota: number
  intelligence: number
}

/** Pipeline stage counts recorded for one routing test, in evaluation order. */
export interface TaskRoutingTestStageCounts {
  /** Exact choices the static resolver admitted. */
  eligible: number
  /** Choices dropped by a determinate hard-blocked provider (quota gate). */
  quota_blocked: number
  /** Choices dropped by the live readiness probe. */
  readiness_rejected: number
  /** Distinct candidates surviving client-variant collapse. */
  collapsed: number
  /** Collapsed candidates that produced a truthful scored input. */
  scored: number
  /** Scored candidates with a final ranking position. */
  ranked: number
  /** Candidates rejected by a real Catalog gate or unscorable evidence. */
  excluded: number
}

/** One ranked candidate row, exposing the exact factors that produced the
 *  weighted total score. */
export interface TaskRoutingTestCandidateRow {
  exact_runtime: string
  rank: number
  intelligence_shortfall: number
  reference_output_usd_per_million: number
  routing_output_usd_per_million: number
  effective_tps: number
  quota_tier: 'healthy' | 'unknown' | 'strained'
  quota_coverage_complete: boolean
  quota_headroom_trusted: boolean
  supply_class: 'confirmed_free' | 'standard'
  price_factor: number
  speed_factor: number
  quota_factor: number
  intelligence_factor: number
  score: number
  notes: string[]
}

/** Gate at which a candidate was excluded from the final ranking. */
export type TaskRoutingTestExclusionStage =
  | 'quota_blocked'
  | 'readiness_rejected'
  | 'not_scorable'
  | 'catalog_excluded'

/** One excluded candidate plus the closed failure code its recording gate
 *  maps to. Skipped candidates never contribute a score. */
export interface TaskRoutingTestExclusion {
  exact_runtime: string
  stage: TaskRoutingTestExclusionStage
  code: TaskResolutionFailureCode
  detail?: string
}

export interface TaskRoutingTestSelection {
  exact_runtime: string
  resolved: TaskSettingsResolvedDispatch
  reason: string
}

/** Explicit summary of the initial static eligibility gate when
 *  `resolver.eligible` exposes no per-candidate detail. */
export interface TaskRoutingTestStaticEligibility {
  code: TaskResolutionFailureCode
  message: string
  eligible_candidate_count: number
}

export interface TaskRoutingTestResult {
  task_id: string
  /** Effective automatic dispatch requirements after all layer merges. */
  effective_requirements: TaskSettingsAutomaticDispatch
  effective_output_cap_usd_per_million: number | null
  timeout_ms: number
  /** Immutable quota snapshot bound to this evaluation; null when no snapshot. */
  snapshot_id: string | null
  now_ms: number
  checked_at: string
  ranking_weights: TaskRoutingTestRankingWeights
  /** Truthful statement of the actual ordering rule (shortfall before score). */
  ordering: string
  stages: TaskRoutingTestStageCounts
  candidates: TaskRoutingTestCandidateRow[]
  exclusions: TaskRoutingTestExclusion[]
  selection: TaskRoutingTestSelection | null
  failure: TaskResolutionFailure | null
  static_eligibility: TaskRoutingTestStaticEligibility | null
}

// ─── task.settings schemas ───────────────────────────────────────────────────

const taskSettingsModeSchema = {
  enum: ['automatic', 'explicit'],
} as const satisfies JsonSchema

const taskSettingsIntelligenceSchema = {
  enum: ['low', 'mid', 'high', 'premium'],
} as const satisfies JsonSchema

const taskSettingsCapabilitySchema = {
  enum: ['text', 'image'],
} as const satisfies JsonSchema

const taskSettingsSourceLayerSchema = {
  enum: ['system', 'builtin', 'user_global', 'user_task', 'invocation'],
} as const satisfies JsonSchema

const taskSettingsAliasReferenceSchema = {
  type: 'object',
  required: ['kind', 'name'],
  properties: {
    kind: { const: 'alias' },
    name: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsTargetReferenceSchema = {
  type: 'object',
  required: ['kind', 'target'],
  properties: {
    kind: { const: 'target' },
    target: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskSettingsExplicitReferenceSchema = {
  anyOf: [taskSettingsAliasReferenceSchema, taskSettingsTargetReferenceSchema],
} as const satisfies JsonSchema

const taskSettingsNullableExplicitReferenceSchema = {
  anyOf: [taskSettingsExplicitReferenceSchema, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsAliasEntrySchema = {
  type: 'object',
  required: ['name', 'target'],
  properties: {
    name: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskSettingsAutomaticDispatchSchema = {
  type: 'object',
  properties: {
    expected_tps: { type: 'number', exclusiveMinimum: 0 },
    minimum_tps: { type: 'number', exclusiveMinimum: 0 },
    intelligence_min: taskSettingsIntelligenceSchema,
    intelligence_max: taskSettingsIntelligenceSchema,
    intelligence_expected: taskSettingsIntelligenceSchema,
    max_output_usd_per_million: { type: 'number', exclusiveMinimum: 0 },
    required_capabilities: { type: 'array', items: taskSettingsCapabilitySchema },
    exclude_model_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_profile_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_client_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_provider_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    requires_web_search: { type: 'boolean' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsNullableAutomaticSchema = {
  anyOf: [taskSettingsAutomaticDispatchSchema, { type: 'null' }],
} as const satisfies JsonSchema

/** Strict (four-tier, no `frontier`) automatic dispatch patch schema. */
const taskSettingsAutomaticPatchSchema = {
  type: 'object',
  properties: {
    expected_tps: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    minimum_tps: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    intelligence_min: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    intelligence_max: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    intelligence_expected: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    max_output_usd_per_million: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    required_capabilities: { anyOf: [{ type: 'array', items: taskSettingsCapabilitySchema }, { type: 'null' }] },
    requires_web_search: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    exclude_model_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_profile_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_client_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
    exclude_provider_ids: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsNullableNumberSchema = {
  anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsNullableNonNegativeNumberSchema = {
  anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
} as const satisfies JsonSchema

export const taskSettingsLayerSchema = {
  type: 'object',
  properties: {
    mode: taskSettingsModeSchema,
    explicit_runtime: taskSettingsNullableExplicitReferenceSchema,
    timeout_ms: taskSettingsNullableNumberSchema,
    automatic: taskSettingsNullableAutomaticSchema,
    max_auto_output_usd_per_million: taskSettingsNullableNonNegativeNumberSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsLayerInputSchema = {
  type: 'object',
  properties: {
    mode: taskSettingsModeSchema,
    explicit_runtime: taskSettingsNullableExplicitReferenceSchema,
    timeout_ms: taskSettingsNullableNumberSchema,
    automatic: taskSettingsNullableAutomaticSchema,
    max_auto_output_usd_per_million: taskSettingsNullableNonNegativeNumberSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsPatchSchema = {
  type: 'object',
  properties: {
    mode: { anyOf: [taskSettingsModeSchema, { type: 'null' }] },
    explicit_runtime: taskSettingsNullableExplicitReferenceSchema,
    timeout_ms: taskSettingsNullableNumberSchema,
    automatic: { anyOf: [taskSettingsAutomaticPatchSchema, { type: 'null' }] },
    max_auto_output_usd_per_million: taskSettingsNullableNonNegativeNumberSchema,
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

const taskSettingsSourcedExplicitReferenceSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableExplicitReferenceSchema,
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

const taskSettingsSourcedNullableNonNegativeNumberSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableNonNegativeNumberSchema,
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

const taskSettingsSourcedBooleanSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
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
    'intelligence_expected',
    'max_output_usd_per_million',
    'required_capabilities',
    'exclude_model_ids',
    'exclude_profile_ids',
    'exclude_client_ids',
    'exclude_provider_ids',
  ],
  properties: {
    expected_tps: taskSettingsSourcedNullableNumberSchema,
    minimum_tps: taskSettingsSourcedNullableNumberSchema,
    intelligence_min: taskSettingsSourcedIntelligenceSchema,
    intelligence_max: taskSettingsSourcedIntelligenceSchema,
    intelligence_expected: taskSettingsSourcedIntelligenceSchema,
    max_output_usd_per_million: taskSettingsSourcedNullableNumberSchema,
    required_capabilities: taskSettingsSourcedCapabilityArraySchema,
    exclude_model_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_profile_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_client_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_provider_ids: taskSettingsSourcedNullableStringArraySchema,
    requires_web_search: taskSettingsSourcedBooleanSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsEffectiveSchema = {
  type: 'object',
  required: ['mode', 'explicit_runtime', 'timeout_ms', 'automatic'],
  properties: {
    mode: taskSettingsSourcedModeSchema,
    explicit_runtime: taskSettingsSourcedExplicitReferenceSchema,
    timeout_ms: taskSettingsSourcedNullableNumberSchema,
    automatic: taskSettingsEffectiveAutomaticSchema,
    max_auto_output_usd_per_million: taskSettingsSourcedNullableNonNegativeNumberSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

/** Closed additive safe resolution-failure detail carried on a validation
 *  issue; no raw diagnostics, quotas, or numeric internals are exposed. */
const taskSettingsResolutionFailureSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: {
      enum: [
        'no_available_provider',
        'price_limit',
        'intelligence_requirement',
        'speed_requirement',
        'quota_unavailable',
        'quota_insufficient',
      ],
    },
    message: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsValidationIssueSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    field: { type: 'string', minLength: 1 },
    resolutionFailure: taskSettingsResolutionFailureSchema,
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

const taskSettingsInstructionTextSegmentSchema = {
  type: 'object',
  required: ['kind', 'source', 'text'],
  properties: {
    kind: { const: 'text' },
    source: { type: 'string', minLength: 1 },
    text: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsInstructionPlaceholderSegmentSchema = {
  type: 'object',
  required: ['kind', 'source', 'label'],
  properties: {
    kind: { const: 'placeholder' },
    source: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsInstructionSegmentSchema = {
  oneOf: [
    taskSettingsInstructionTextSegmentSchema,
    taskSettingsInstructionPlaceholderSegmentSchema,
  ],
} as const satisfies JsonSchema

const taskSettingsBuiltinMetadataSchema = {
  type: 'object',
  required: [
    'identity',
    'name',
    'source',
    'prompt_template',
    'instruction_template',
    'timeout_ms',
    'dispatch',
  ],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    project: { type: 'string', minLength: 1 },
    prompt_template: { enum: ['dynamic', 'fixed'] },
    instruction_template: { type: 'array', items: taskSettingsInstructionSegmentSchema },
    timeout_ms: { anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] },
    dispatch: taskSettingsAutomaticDispatchSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

/** Backward-compatible resolved-dispatch wire schema extended with the additive
 *  Catalog display labels (all original fields and shape are kept). */
const taskSettingsResolvedDispatchSchema = {
  ...taskResolvedDispatchSchema,
  properties: {
    ...taskResolvedDispatchSchema.properties,
    provider_display_name: { type: 'string', minLength: 1 },
    model_display_name: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const taskSettingsExplicitRowSchema = {
  type: 'object',
  required: ['reference', 'resolved_target', 'resolved', 'readiness'],
  properties: {
    reference: taskSettingsExplicitReferenceSchema,
    resolved_target: nullableStringSchema,
    resolved: {
      anyOf: [taskSettingsResolvedDispatchSchema, { type: 'null' }],
    },
    readiness: {
      anyOf: [taskSettingsRuntimeReadinessSchema, { type: 'null' }],
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

/** Resolved dispatch wire schema extended with the additive safe auto_routing
 *  decision and the additive Catalog display labels (backward compatible: all
 *  original fields and shape are kept). */
const taskSettingsAutomaticResolvedDispatchSchema = {
  ...taskResolvedDispatchSchema,
  properties: {
    ...taskResolvedDispatchSchema.properties,
    provider_display_name: { type: 'string', minLength: 1 },
    model_display_name: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

const taskSettingsAutomaticSelectionSchema = {
  type: 'object',
  required: ['exact_runtime', 'resolved', 'reason'],
  properties: {
    exact_runtime: { type: 'string', minLength: 1 },
    resolved: taskSettingsAutomaticResolvedDispatchSchema,
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsTaskRowSchema = {
  type: 'object',
  required: ['identity', 'name', 'display_name', 'builtin', 'user_task', 'effective', 'issues'],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    project_display_name: { type: 'string', minLength: 1 },
    builtin: taskSettingsBuiltinMetadataSchema,
    user_task: taskSettingsLayerSchema,
    effective: taskSettingsEffectiveSchema,
    explicit: taskSettingsExplicitRowSchema,
    automatic_selection: taskSettingsAutomaticSelectionSchema,
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
  required: ['config_path', 'revision', 'user_global', 'aliases', 'rows'],
  properties: {
    config_path: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    user_global: taskSettingsLayerSchema,
    aliases: { type: 'array', items: taskSettingsAliasEntrySchema },
    rows: { type: 'array', items: taskSettingsTaskRowSchema },
    load_errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source_path', 'file_name', 'message'],
        properties: {
          source_path: { type: 'string', minLength: 1 },
          file_name: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          project: { type: 'string', minLength: 1 },
          project_display_name: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
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

const taskRoutingTestFailureCodeSchema = {
  enum: [
    'no_available_provider',
    'price_limit',
    'intelligence_requirement',
    'speed_requirement',
    'quota_unavailable',
    'quota_insufficient',
  ],
} as const satisfies JsonSchema

const taskRoutingTestRankingWeightsSchema = {
  type: 'object',
  required: ['price', 'speed', 'quota', 'intelligence'],
  properties: {
    price: { type: 'number' },
    speed: { type: 'number' },
    quota: { type: 'number' },
    intelligence: { type: 'number' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestStageCountsSchema = {
  type: 'object',
  required: ['eligible', 'quota_blocked', 'readiness_rejected', 'collapsed', 'scored', 'ranked', 'excluded'],
  properties: {
    eligible: { type: 'integer', minimum: 0 },
    quota_blocked: { type: 'integer', minimum: 0 },
    readiness_rejected: { type: 'integer', minimum: 0 },
    collapsed: { type: 'integer', minimum: 0 },
    scored: { type: 'integer', minimum: 0 },
    ranked: { type: 'integer', minimum: 0 },
    excluded: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestCandidateRowSchema = {
  type: 'object',
  required: [
    'exact_runtime',
    'rank',
    'intelligence_shortfall',
    'reference_output_usd_per_million',
    'routing_output_usd_per_million',
    'effective_tps',
    'quota_tier',
    'quota_coverage_complete',
    'quota_headroom_trusted',
    'supply_class',
    'price_factor',
    'speed_factor',
    'quota_factor',
    'intelligence_factor',
    'score',
    'notes',
  ],
  properties: {
    exact_runtime: { type: 'string', minLength: 1 },
    rank: { type: 'integer', minimum: 1 },
    intelligence_shortfall: { type: 'number' },
    reference_output_usd_per_million: { type: 'number' },
    routing_output_usd_per_million: { type: 'number' },
    effective_tps: { type: 'number' },
    quota_tier: { enum: ['healthy', 'unknown', 'strained'] },
    quota_coverage_complete: { type: 'boolean' },
    quota_headroom_trusted: { type: 'boolean' },
    supply_class: { enum: ['confirmed_free', 'standard'] },
    price_factor: { type: 'number' },
    speed_factor: { type: 'number' },
    quota_factor: { type: 'number' },
    intelligence_factor: { type: 'number' },
    score: { type: 'number' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestExclusionSchema = {
  type: 'object',
  required: ['exact_runtime', 'stage', 'code'],
  properties: {
    exact_runtime: { type: 'string', minLength: 1 },
    stage: {
      enum: ['quota_blocked', 'readiness_rejected', 'not_scorable', 'catalog_excluded'],
    },
    code: taskRoutingTestFailureCodeSchema,
    detail: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestSelectionSchema = {
  type: 'object',
  required: ['exact_runtime', 'resolved', 'reason'],
  properties: {
    exact_runtime: { type: 'string', minLength: 1 },
    resolved: taskSettingsResolvedDispatchSchema,
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestStaticEligibilitySchema = {
  type: 'object',
  required: ['code', 'message', 'eligible_candidate_count'],
  properties: {
    code: taskRoutingTestFailureCodeSchema,
    message: { type: 'string', minLength: 1 },
    eligible_candidate_count: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRoutingTestParamsSchema = {
  type: 'object',
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRoutingTestResultSchema = {
  type: 'object',
  required: [
    'task_id',
    'effective_requirements',
    'effective_output_cap_usd_per_million',
    'timeout_ms',
    'snapshot_id',
    'now_ms',
    'checked_at',
    'ranking_weights',
    'ordering',
    'stages',
    'candidates',
    'exclusions',
    'selection',
    'failure',
    'static_eligibility',
  ],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    effective_requirements: taskSettingsAutomaticDispatchSchema,
    effective_output_cap_usd_per_million: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    timeout_ms: { type: 'number' },
    snapshot_id: nullableStringSchema,
    now_ms: { type: 'number' },
    checked_at: { type: 'string', minLength: 1 },
    ranking_weights: taskRoutingTestRankingWeightsSchema,
    ordering: { type: 'string', minLength: 1 },
    stages: taskRoutingTestStageCountsSchema,
    candidates: { type: 'array', items: taskRoutingTestCandidateRowSchema },
    exclusions: { type: 'array', items: taskRoutingTestExclusionSchema },
    selection: { anyOf: [taskRoutingTestSelectionSchema, { type: 'null' }] },
    failure: {
      anyOf: [
        {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: taskRoutingTestFailureCodeSchema,
            message: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    static_eligibility: {
      anyOf: [taskRoutingTestStaticEligibilitySchema, { type: 'null' }],
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskRunCreateParamsSchema = {
  type: 'object',
  required: ['task_id', 'project'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    worktree: { type: 'string', minLength: 1 },
    input: {},
    ctx: recordSchema,
    invocation_settings: taskSettingsLayerInputSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema
