import { REASONING_EFFORTS } from '@wrenyard/providers/catalog'
import { taskRunStatusValues } from '@wrenyard/protocol/task'
import type { JsonSchema } from '../jsonrpc.mts'
import { taskResolvedDispatchSchema, taskUsageSchema } from '../task-run-metadata.mts'

export {
  taskRunStatusValues,
} from '@wrenyard/protocol/task'
export type {
  TaskDefinitionDescribeParams,
  TaskDefinitionDescribeResult,
  TaskDefinitionDetail,
  TaskDefinitionListParams,
  TaskDefinitionListResult,
  TaskDefinitionLoadFailed,
  TaskDefinitionSummary,
  TaskDispatchRequirements,
  TaskInheritanceChainEntry,
  TaskInputRequired,
  TaskInputValidationFailed,
  TaskResolutionFailure,
  TaskResolutionFailureCode,
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestRow,
  TaskRoutingTestTask,
  TaskRoutingTestTasksParams,
  TaskRoutingTestTasksResult,
  TaskRunAccepted,
  TaskRunCancelParams,
  TaskRunCancelResult,
  TaskRunCreateParams,
  TaskRunCreateResult,
  TaskRunEventItem,
  TaskRunEventsParams,
  TaskRunEventsResult,
  TaskRunListParams,
  TaskRunListResult,
  TaskRunOutputParams,
  TaskRunOutputResult,
  TaskRunStatus,
  TaskRunStatusParams,
  TaskRunStatusResult,
  TaskRunWaitParams,
  TaskRunWaitResult,
  TaskSettingsAutomaticDispatch,
  TaskSettingsAutomaticPatch,
  TaskSettingsAutomaticSelection,
  TaskSettingsBuiltinMetadata,
  TaskSettingsCapability,
  TaskSettingsEffective,
  TaskSettingsEffectiveAutomatic,
  TaskSettingsInstructionSegment,
  TaskSettingsInstructionTemplate,
  TaskSettingsIntelligence,
  TaskSettingsLayer,
  TaskSettingsLoadError,
  TaskSettingsPatch,
  TaskSettingsReasoningEffort,
  TaskSettingsResolvedDispatch,
  TaskSettingsRuntimeTriple,
  TaskSettingsRoutingWeights,
  TaskSettingsSaveParams,
  TaskSettingsSaveResult,
  TaskSettingsSnapshotParams,
  TaskSettingsSnapshotResult,
  TaskSettingsSourcedValue,
  TaskSettingsSourceLayer,
  TaskSettingsTaskRow,
  TaskSettingsValidationIssue,
} from '@wrenyard/protocol/task'

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

const taskInheritanceChainEntrySchema = {
  type: 'object',
  required: ['source', 'path'],
  properties: {
    source: { enum: ['builtin', 'project'] },
    project: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskDispatchRequirementsSchema = {
  type: 'object',
  properties: {
    expectedTps: { type: 'number', exclusiveMinimum: 0 },
    minimumTps: { type: 'number', exclusiveMinimum: 0 },
    intelligenceMin: { enum: ['low', 'mid', 'high', 'premium'] },
    intelligenceExpected: { enum: ['low', 'mid', 'high', 'premium'] },
    maxOutputUsdPerMillion: { type: 'number', exclusiveMinimum: 0 },
    requiredCapabilities: { type: 'array', items: { enum: ['text', 'image'] } },
    excludeModelIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProfileIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeClientIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    excludeProviderIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresWebSearch: { type: 'boolean' },
    fast: { type: 'boolean' },
    expectedReasoningEffort: { enum: REASONING_EFFORTS },
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
    structuredRetryTimeoutMs: { type: 'number' },
    scheduling: { enum: ['active', 'legacy'] },
    dispatch: taskDispatchRequirementsSchema,
    inheritanceChain: { type: 'array', items: taskInheritanceChainEntrySchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskDefinitionDetailSchema = {
  type: 'object',
  required: ['name', 'source', 'path'],
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
    structuredRetryTimeoutMs: { type: 'number' },
    scheduling: { enum: ['active', 'legacy'] },
    inheritanceChain: { type: 'array', items: taskInheritanceChainEntrySchema },
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
    task_name: { type: 'string' },
    status: { enum: taskRunStatusValues },
    created_at: { type: 'string' },
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
    task_name: { type: 'string' },
    status: { enum: taskRunStatusValues },
    created_at: { type: 'string' },
    started_at: { type: 'string' },
    summary: { type: 'string' },
    resolved: taskResolvedDispatchSchema,
    recorded: {
      type: 'object',
      required: ['provider', 'model'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      additionalProperties: false,
    },
    usage: taskUsageSchema,
    error: nullableStringSchema,
    failure_category: { type: 'string' },
    suggestion: { type: 'string' },
    error_message: { type: 'string' },
    has_output: { type: 'boolean' },
    facts: { type: 'object' },
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
    task_name: { type: 'string' },
    status: { enum: taskRunStatusValues },
    summary: { type: 'string' },
    resolved: taskResolvedDispatchSchema,
    usage: taskUsageSchema,
    output: {},
    error: nullableStringSchema,
    failure_category: { type: 'string' },
    suggestion: { type: 'string' },
    error_message: { type: 'string' },
    facts: { type: 'object' },
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

// ─── task.settings schemas ───────────────────────────────────────────────────

const taskSettingsIntelligenceSchema = {
  enum: ['low', 'mid', 'high', 'premium'],
} as const satisfies JsonSchema

const taskSettingsCapabilitySchema = {
  enum: ['text', 'image'],
} as const satisfies JsonSchema

const taskSettingsReasoningEffortSchema = {
  enum: REASONING_EFFORTS,
} as const satisfies JsonSchema

const taskSettingsSourceLayerSchema = {
  enum: ['system', 'builtin', 'user_global', 'user_task', 'invocation'],
} as const satisfies JsonSchema

export const taskSettingsAutomaticDispatchSchema = {
  type: 'object',
  properties: {
    expected_tps: { type: 'number', exclusiveMinimum: 0 },
    minimum_tps: { type: 'number', exclusiveMinimum: 0 },
    intelligence_min: taskSettingsIntelligenceSchema,
    intelligence_expected: taskSettingsIntelligenceSchema,
    max_output_usd_per_million: { type: 'number', exclusiveMinimum: 0 },
    required_capabilities: { type: 'array', items: taskSettingsCapabilitySchema },
    exclude_model_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_profile_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_client_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclude_provider_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    requires_web_search: { type: 'boolean' },
    fast: { type: 'boolean' },
    expected_reasoning_effort: { enum: REASONING_EFFORTS },
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
    intelligence_expected: { anyOf: [taskSettingsIntelligenceSchema, { type: 'null' }] },
    max_output_usd_per_million: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    required_capabilities: { anyOf: [{ type: 'array', items: taskSettingsCapabilitySchema }, { type: 'null' }] },
    requires_web_search: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    fast: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    expected_reasoning_effort: { anyOf: [{ enum: REASONING_EFFORTS }, { type: 'null' }] },
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

const taskSettingsRunTimeLimitMinutesSchema = {
  anyOf: [{ type: 'integer', minimum: 5, maximum: 600 }, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsNullableNonNegativeNumberSchema = {
  anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsRoutingWeightsSchema = {
  type: 'object',
  required: ['price', 'speed', 'quota', 'intelligence'],
  properties: {
    price: { type: 'number', minimum: 0, maximum: 1 },
    speed: { type: 'number', minimum: 0, maximum: 1 },
    quota: { type: 'number', minimum: 0, maximum: 1 },
    intelligence: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsNullableRoutingWeightsSchema = {
  anyOf: [taskSettingsRoutingWeightsSchema, { type: 'null' }],
} as const satisfies JsonSchema

const taskSettingsHealthErrorRateThresholdSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
} as const satisfies JsonSchema

const taskSettingsNullableHealthErrorRateThresholdSchema = {
  anyOf: [taskSettingsHealthErrorRateThresholdSchema, { type: 'null' }],
} as const satisfies JsonSchema

export const taskSettingsLayerSchema = {
  type: 'object',
  properties: {
    run_time_limit_minutes: taskSettingsRunTimeLimitMinutesSchema,
    automatic: taskSettingsNullableAutomaticSchema,
    routing_weights: taskSettingsNullableRoutingWeightsSchema,
    health_error_rate_threshold: taskSettingsNullableHealthErrorRateThresholdSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsLayerInputSchema = {
  type: 'object',
  properties: {
    automatic: taskSettingsNullableAutomaticSchema,
    routing_weights: taskSettingsNullableRoutingWeightsSchema,
    health_error_rate_threshold: taskSettingsNullableHealthErrorRateThresholdSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskSettingsPatchSchema = {
  type: 'object',
  properties: {
    run_time_limit_minutes: taskSettingsRunTimeLimitMinutesSchema,
    automatic: { anyOf: [taskSettingsAutomaticPatchSchema, { type: 'null' }] },
    routing_weights: taskSettingsNullableRoutingWeightsSchema,
    health_error_rate_threshold: taskSettingsNullableHealthErrorRateThresholdSchema,
  },
  additionalProperties: true,
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

const taskSettingsSourcedReasoningEffortSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: { anyOf: [taskSettingsReasoningEffortSchema, { type: 'null' }] },
    source: taskSettingsSourceLayerSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskSettingsSourcedNullableRoutingWeightsSchema = {
  type: 'object',
  required: ['value', 'source'],
  properties: {
    value: taskSettingsNullableRoutingWeightsSchema,
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
    intelligence_expected: taskSettingsSourcedIntelligenceSchema,
    max_output_usd_per_million: taskSettingsSourcedNullableNumberSchema,
    required_capabilities: taskSettingsSourcedCapabilityArraySchema,
    exclude_model_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_profile_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_client_ids: taskSettingsSourcedNullableStringArraySchema,
    exclude_provider_ids: taskSettingsSourcedNullableStringArraySchema,
    requires_web_search: taskSettingsSourcedBooleanSchema,
    expected_reasoning_effort: taskSettingsSourcedReasoningEffortSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskSettingsEffectiveSchema = {
  type: 'object',
  required: ['run_time_limit_minutes', 'automatic'],
  properties: {
    run_time_limit_minutes: {
      type: 'object',
      required: ['value', 'source'],
      properties: {
        value: taskSettingsRunTimeLimitMinutesSchema,
        source: taskSettingsSourceLayerSchema,
      },
      additionalProperties: false,
    },
    automatic: taskSettingsEffectiveAutomaticSchema,
    routing_weights: taskSettingsSourcedNullableRoutingWeightsSchema,
    health_error_rate_threshold: {
      type: 'object',
      required: ['value', 'source'],
      properties: {
        value: taskSettingsHealthErrorRateThresholdSchema,
        source: taskSettingsSourceLayerSchema,
      },
      additionalProperties: false,
    },
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
        'context_window',
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
  required: ['identity', 'name', 'display_name', 'user_task', 'effective', 'issues'],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    project_display_name: { type: 'string', minLength: 1 },
    builtin: taskSettingsBuiltinMetadataSchema,
    user_task: taskSettingsLayerSchema,
    effective: taskSettingsEffectiveSchema,
    automatic_selection: taskSettingsAutomaticSelectionSchema,
    inheritanceChain: { type: 'array', items: taskInheritanceChainEntrySchema },
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

const taskRoutingTestRowSchema = {
  type: 'object',
  required: [
    'provider',
    'provider_name',
    'model',
    'model_name',
    'effective_tps',
    'price_score',
    'speed_score',
    'quota_score',
    'intelligence_score',
    'score',
    'rank',
    'reason',
  ],
  properties: {
    provider: { type: 'string', minLength: 1 },
    provider_name: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    model_name: { type: 'string', minLength: 1 },
    effective_tps: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    first_token_ms: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    price_score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    speed_score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    quota_score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    intelligence_score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    rank: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    reason: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRoutingTestParamsSchema = {
  type: 'object',
  required: ['automatic'],
  properties: {
    automatic: taskSettingsAutomaticDispatchSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRoutingTestResultSchema = {
  type: 'object',
  required: ['rows'],
  properties: {
    rows: { type: 'array', items: taskRoutingTestRowSchema },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const taskRoutingTestTaskSchema = {
  type: 'object',
  required: ['identity', 'name', 'display_name', 'automatic'],
  properties: {
    identity: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    automatic: taskSettingsAutomaticDispatchSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRoutingTestTasksParamsSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskRoutingTestTasksResultSchema = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: { type: 'array', items: taskRoutingTestTaskSchema },
  },
  additionalProperties: false,
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
  additionalProperties: false,
} as const satisfies JsonSchema
