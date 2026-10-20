import type { JsonSchema } from '../jsonrpc.mts'
// ─── activity.snapshot ───────────────────────────────────────────────────────
// One atomic read-only projection of current Foreman activity for the Pet
// desktop. The response carries only the spec whitelist: bounded display
// fields, never prompts, action params, schemas, task input/output/error,
// journal data, or execution raw results.

export type {
  ActivitySnapshotParams,
  ActivitySnapshotTask,
  ActivitySnapshotNodeState,
  ActivitySnapshotTaskStatus,
  ActivitySnapshotGraphState,
  ActivitySnapshotTerminalReason,
  ActivitySnapshotNode,
  ActivitySnapshotTaskgraph,
  ActivitySnapshotV1,
} from '@wrenyard/protocol/activity'

const trackedTaskgraphIdsSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  maxItems: 128,
} as const satisfies JsonSchema

export const activitySnapshotParamsSchema = {
  type: 'object',
  properties: {
    tracked_taskgraph_ids: trackedTaskgraphIdsSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const activitySnapshotNodeStateSchema = {
  type: 'string',
  enum: ['planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled'],
} as const satisfies JsonSchema

const activitySnapshotGraphStateSchema = {
  type: 'string',
  enum: ['created', 'running', 'paused', 'done', 'cancelled'],
} as const satisfies JsonSchema

const activitySnapshotTaskCategorySchema = {
  type: 'object',
  required: ['id', 'display_label'],
  properties: {
    id: { type: 'string', minLength: 1 },
    display_label: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const activitySnapshotNodeSchema = {
  type: 'object',
  required: ['node_id', 'state'],
  properties: {
    node_id: { type: 'string', minLength: 1 },
    state: activitySnapshotNodeStateSchema,
    task_run_id: { type: 'string', minLength: 1 },
    task_status: {
      type: 'string',
      enum: ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'],
    },
    task_id: { type: 'string', minLength: 1 },
    task_category: activitySnapshotTaskCategorySchema,
    display_label: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    requested_agent_runtime: { type: 'string', minLength: 1 },
    resolved_profile: { type: 'string', minLength: 1 },
    tool_call_count: { type: 'integer', minimum: 0 },
    tps: { type: 'number', minimum: 0, maximum: 1_000_000 },
    summary: { type: 'string', minLength: 1 },
    runtime_ms: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const activitySnapshotTaskSchema = {
  type: 'object',
  required: ['task_run_id', 'status', 'created_at', 'updated_at'],
  properties: {
    task_run_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['queued', 'running'] },
    task_id: { type: 'string', minLength: 1 },
    task_label: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    worktree: { type: 'boolean' },
    requested_agent_runtime: { type: 'string', minLength: 1 },
    resolved_profile: { type: 'string', minLength: 1 },
    created_at: { type: 'string', format: 'date-time' },
    started_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    queuePosition: { type: 'integer', minimum: 1 },
    taskgraph_id: { type: 'string', minLength: 1 },
    node_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const activitySnapshotTaskgraphSchema = {
  type: 'object',
  required: [
    'taskgraph_id',
    'state',
    'on_node_failure',
    'cancel_requested',
    'structure_revision',
    'latest_seq',
    'node_counts',
    'active',
    'nodes',
  ],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    state: activitySnapshotGraphStateSchema,
    title: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    on_node_failure: { type: 'string', enum: ['pause', 'cancel'] },
    cancel_requested: { type: 'boolean' },
    structure_revision: { type: 'integer', minimum: 0 },
    latest_seq: { type: 'integer', minimum: 0 },
    terminal_reason: {
      type: 'string',
      enum: ['success', 'node_failed', 'cancelled'],
    },
    node_counts: {
      type: 'object',
      required: ['planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled'],
      properties: {
        planned: { type: 'integer', minimum: 0 },
        running: { type: 'integer', minimum: 0 },
        waiting: { type: 'integer', minimum: 0 },
        done: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        interrupted: { type: 'integer', minimum: 0 },
        cancelled: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    active: {
      type: 'object',
      required: ['running', 'waiting'],
      properties: {
        running: { type: 'array', items: { type: 'string', minLength: 1 } },
        waiting: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      additionalProperties: false,
    },
    nodes: {
      type: 'array',
      items: activitySnapshotNodeSchema,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const activitySnapshotResultSchema = {
  type: 'object',
  required: ['schema_version', 'sampled_at', 'tasks', 'taskgraphs'],
  properties: {
    schema_version: { const: 'foreman.activity.snapshot.v1' },
    sampled_at: { type: 'string', format: 'date-time' },
    tasks: { type: 'array', items: activitySnapshotTaskSchema },
    taskgraphs: { type: 'array', items: activitySnapshotTaskgraphSchema },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
