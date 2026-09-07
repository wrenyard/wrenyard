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
  timeoutScope?: 'agent_attempt'
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
    timeoutScope: { enum: ['agent_attempt'] },
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
    timeoutScope: { enum: ['agent_attempt'] },
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

export const taskRunCreateParamsSchema = {
  type: 'object',
  required: ['task_id', 'project'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    worktree: { type: 'string', minLength: 1 },
    input: {},
    ctx: recordSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

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

// ─── task.settings.snapshot / task.settings.save ─────────────────────────────

export interface TaskSettingsSnapshotParams {
  project?: string
}

/**
 * One exact runtime the human Tasks page may select. Same resolved
 * client/provider/model/model_id/mode/protocol/speed/intelligence/
 * reference_pricing fields as a task.run resolved dispatch, plus its exact
 * pinned runtime string. Policy aliases (forge/fast/general/ultra) are never
 * eligible choices.
 */
export type TaskSettingsEligibleChoice = TaskResolvedDispatch & { exactAgentRuntime: string }

export interface TaskSettingsTaskRow {
  /** Bare task name — also the machine-global preference key. */
  task_id: string
  project: string
  /** Read-only task definition source. */
  source: string
  /** Read-only permission metadata. */
  permission?: 'readonly' | 'edit' | 'yolo'
  /** Read-only input schema metadata. */
  input_schema?: unknown
  /** Read-only output schema metadata. */
  output_schema?: unknown
  /** Read-only dispatch contract metadata. */
  dispatch?: TaskDispatchRequirements
  declared_agent_runtime: string | null
  machine_preference: string | null
  /** Current selection. `source: 'machine'` means a preference is set; otherwise 'automatic'. */
  selection: {
    agent_runtime: string | null
    source: 'automatic' | 'machine'
  }
  eligible: TaskSettingsEligibleChoice[]
}

export interface TaskSettingsSnapshotResult {
  /** Actual authoritative config file the daemon reads and writes. */
  config_path: string
  /** Deterministic content revision for CAS save. */
  revision: string
  /** Preferences are machine-global, never per-project. */
  scope: 'machine_global'
  keyed_by: 'bare_task_name'
  project?: string
  tasks: TaskSettingsTaskRow[]
}

export interface TaskSettingsSaveParams {
  task_id: string
  project?: string
  /** Exact eligible agentRuntime, or null to reset to the machine default. */
  agent_runtime: string | null
  expected_revision: string
}

export type TaskSettingsSaveResult = TaskSettingsSnapshotResult

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

const taskSettingsTaskRowSchema = {
  type: 'object',
  required: [
    'task_id',
    'project',
    'source',
    'declared_agent_runtime',
    'machine_preference',
    'selection',
    'eligible',
  ],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string' },
    source: { type: 'string', minLength: 1 },
    permission: { enum: ['readonly', 'edit', 'yolo'] },
    input_schema: {},
    output_schema: {},
    dispatch: { type: 'object', additionalProperties: true },
    declared_agent_runtime: nullableStringSchema,
    machine_preference: nullableStringSchema,
    selection: {
      type: 'object',
      required: ['agent_runtime', 'source'],
      properties: {
        agent_runtime: nullableStringSchema,
        source: { enum: ['automatic', 'machine'] },
      },
      additionalProperties: false,
    },
    eligible: {
      type: 'array',
      items: taskSettingsEligibleChoiceSchema,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSnapshotParamsSchema = {
  type: 'object',
  properties: {
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSnapshotResultSchema = {
  type: 'object',
  required: ['config_path', 'revision', 'scope', 'keyed_by', 'tasks'],
  properties: {
    config_path: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    scope: { const: 'machine_global' },
    keyed_by: { const: 'bare_task_name' },
    project: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      items: taskSettingsTaskRowSchema,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSaveParamsSchema = {
  type: 'object',
  required: ['task_id', 'agent_runtime', 'expected_revision'],
  properties: {
    task_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    agent_runtime: nullableStringSchema,
    expected_revision: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsSaveResultSchema = taskSettingsSnapshotResultSchema
