import type { JsonSchema } from '../jsonrpc.mts'
import {
  ON_NODE_FAILURE_POLICIES,
  PATCH_ERROR_CODES,
  TASKGRAPH_EVENT_TYPES,
} from '@wrenyard/protocol/taskgraph'
import type { JsonObject } from '@wrenyard/protocol/common'

// Wire DTOs are declared once in @wrenyard/protocol/taskgraph and re-exported
// here so every existing daemon import path keeps working. The runtime JSON
// schemas below stay daemon-owned.
export type {
  EventRefs,
  EventSource,
  ExecutionError,
  GraphStateType,
  NodeId,
  NodeInput,
  NodeRunStateType,
  ObjectJsonSchema,
  OnNodeFailurePolicy,
  PatchError,
  PatchErrorCode,
  PatchOperation,
  SourceKind,
  TaskGraph,
  TaskGraphAction,
  TaskGraphActiveNodes,
  TaskGraphCreateParams,
  TaskGraphCreateResult,
  TaskGraphEvent,
  TaskGraphEventsParams,
  TaskGraphEventsResult,
  TaskGraphEventType,
  TaskGraphInspectParams,
  TaskGraphInspectResult,
  TaskGraphListParams,
  TaskGraphListResult,
  TaskGraphNode,
  TaskGraphNodeCounts,
  TaskGraphNodeInspectParams,
  TaskGraphNodeInspectResult,
  TaskGraphNodeRunInfo,
  TaskGraphPatch,
  TaskGraphPatchOperation,
  TaskGraphPatchOperationConfirm,
  TaskGraphPatchOperationRequest,
  TaskGraphPatchParams,
  TaskGraphPatchResult,
  TaskGraphPatchResultApplied,
  TaskGraphPatchResultPreview,
  TaskGraphPatchResultRejected,
  TaskGraphRunSummary,
  TaskGraphSignal,
  TaskGraphSignalParams,
  TaskGraphSignalResult,
  TaskGraphSlipNode,
  TaskGraphSlipParams,
  TaskGraphSlipResult,
  TaskGraphStatusParams,
  TaskGraphStatusResult,
  TaskGraphStatusResultCancelled,
  TaskGraphStatusResultDone,
  TaskGraphTemplateId,
  TaskGraphTerminalOutcome,
  TaskGraphWaitParams,
  TaskGraphWaitReason,
  TaskGraphWaitResult,
} from '@wrenyard/protocol/taskgraph'
export type { JsonObject } from '@wrenyard/protocol/common'

// ─── Local schema consts (inlined from core) ─────────────────────────────────

const GRAPH_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
} as const satisfies JsonSchema

const NODE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
} as const satisfies JsonSchema

const JSON_OBJECT_SCHEMA = {
  type: 'object',
  properties: {} as JsonObject,
  additionalProperties: true,
} as const satisfies JsonSchema

const GRAPH_STATE_SCHEMA = {
  type: 'string',
  enum: ['created', 'running', 'paused', 'done', 'cancelled'],
} as const satisfies JsonSchema

const NODE_RUN_STATE_SCHEMA = {
  type: 'string',
  enum: ['planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled'],
} as const satisfies JsonSchema

const EXECUTION_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'object' },
  },
  required: ['code', 'message'],
} as const satisfies JsonSchema

const PATCH_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: PATCH_ERROR_CODES },
    message: { type: 'string' },
    details: { type: 'object' },
  },
  required: ['code', 'message'],
} as const satisfies JsonSchema

const SIGNAL_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'start_graph' },
        input: { type: 'object' },
      },
      required: ['type', 'input'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'pause_graph' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'resume_graph' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'cancel_graph' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'resume_checkpoint' },
        node_id: { type: 'string' },
        output: { type: 'object' },
      },
      required: ['type', 'node_id', 'output'],
      additionalProperties: false,
    },
  ],
} as const satisfies JsonSchema

const EVENT_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['daemon', 'runner', 'action', 'client'] },
    id: { type: 'string' },
  },
  required: ['kind'],
} as const satisfies JsonSchema

const EVENT_REFS_SCHEMA = {
  type: 'object',
  properties: {
    node_id: { type: 'string' },
    task_run_id: { type: 'string' },
    patch_id: { type: 'string' },
  },
} as const satisfies JsonSchema

const TASKGRAPH_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    event_id: { type: 'string' },
    taskgraph_id: { type: 'string' },
    seq: { type: 'integer', minimum: 0 },
    type: { type: 'string', enum: TASKGRAPH_EVENT_TYPES },
    occurred_at: { type: 'string', format: 'date-time' },
    structure_revision: { type: 'integer', minimum: 0 },
    source: EVENT_SOURCE_SCHEMA,
    refs: EVENT_REFS_SCHEMA,
    data: { type: 'object' },
  },
  required: [
    'event_id',
    'taskgraph_id',
    'seq',
    'type',
    'occurred_at',
    'structure_revision',
    'source',
    'data',
  ],
  additionalProperties: false,
} as const satisfies JsonSchema

const TASK_GRAPH_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['start', 'end', 'condition', 'convert', 'join', 'checkpoint', 'task', 'shell'] },
    params: JSON_OBJECT_SCHEMA,
  },
  required: ['type', 'params'],
  additionalProperties: false,
} as const satisfies JsonSchema

const NODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    source: { type: 'string' },
    optional: { type: 'boolean' },
  },
  required: ['name', 'source'],
  additionalProperties: false,
} as const satisfies JsonSchema

const OBJECT_JSON_SCHEMA_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'object' },
  },
  required: ['type'],
} as const satisfies JsonSchema

const TASK_GRAPH_NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: NODE_ID_SCHEMA,
    name: { type: 'string' },
    action: TASK_GRAPH_ACTION_SCHEMA,
    deps: { type: 'array', items: NODE_ID_SCHEMA },
    input: { type: 'array', items: NODE_INPUT_SCHEMA },
    input_schema: OBJECT_JSON_SCHEMA_SCHEMA,
    output_schema: OBJECT_JSON_SCHEMA_SCHEMA,
  },
  required: ['id', 'name', 'action', 'deps', 'input', 'input_schema', 'output_schema'],
  additionalProperties: false,
} as const satisfies JsonSchema

const PATCH_OPERATION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        op: { type: 'string', const: 'AddNode' },
        node: TASK_GRAPH_NODE_SCHEMA,
      },
      required: ['op', 'node'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        op: { type: 'string', const: 'RemoveNode' },
        id: NODE_ID_SCHEMA,
      },
      required: ['op', 'id'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        op: { type: 'string', const: 'ReplaceNode' },
        node: TASK_GRAPH_NODE_SCHEMA,
      },
      required: ['op', 'node'],
      additionalProperties: false,
    },
  ],
} as const satisfies JsonSchema

const TASK_GRAPH_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    base_revision: { type: 'integer', minimum: 0 },
    actor: { type: 'string' },
    reason: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    ops: { type: 'array', items: PATCH_OPERATION_SCHEMA },
  },
  required: ['base_revision', 'actor', 'reason', 'created_at', 'ops'],
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── Private helper schemas ───────────────────────────────────────────────────

const nodeCountsSchema = {
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
  additionalProperties: true,
} as const satisfies JsonSchema

const taskGraphRefSchema = {
  type: 'object',
  required: ['id', 'revision', 'nodes'],
  properties: {
    id: GRAPH_ID_SCHEMA,
    revision: { type: 'integer', minimum: 0 },
    tg_ctx: JSON_OBJECT_SCHEMA,
    nodes: {
      type: 'object',
      additionalProperties: TASK_GRAPH_NODE_SCHEMA,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const ON_NODE_FAILURE_POLICY_SCHEMA = {
  type: 'string',
  enum: ON_NODE_FAILURE_POLICIES,
} as const satisfies JsonSchema

const TASKGRAPH_FAILURE_CAUSE_SCHEMA = {
  type: 'object',
  required: ['kind', 'node_id', 'error'],
  properties: {
    kind: { type: 'string', enum: ['node_failed', 'recovery_failed'] },
    node_id: NODE_ID_SCHEMA,
    task_run_id: { type: 'string', minLength: 1 },
    error: EXECUTION_ERROR_SCHEMA,
    event_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── taskgraph.create ─────────────────────────────────────────────────────────

export const taskgraphCreateParamsSchema = {
  type: 'object',
  required: ['template'],
  properties: {
    template: {
      type: 'string',
      enum: [
        'default',
        'parallel-explore',
        'parallel-edit',
        'change-test',
        'implement',
        'closeout',
      ],
    },
    project: { type: 'string', minLength: 1 },
    tg_ctx: JSON_OBJECT_SCHEMA,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    on_node_failure: ON_NODE_FAILURE_POLICY_SCHEMA,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskgraphCreateResultSchema = {
  type: 'object',
  required: ['taskgraph'],
  properties: {
    taskgraph: {
      type: 'object',
      required: ['id', 'revision', 'status', 'created_at'],
      properties: {
        id: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        status: { const: 'created' },
        created_at: { type: 'string', format: 'date-time' },
        title: { type: 'string', minLength: 1, maxLength: 120 },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.patch ──────────────────────────────────────────────────────────

const taskgraphPatchOperationSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'patch'],
      properties: {
        type: { const: 'request_patch' },
        patch: TASK_GRAPH_PATCH_SCHEMA,
      },
      additionalProperties: true,
    },
    {
      type: 'object',
      required: ['type', 'patch_id'],
      properties: {
        type: { const: 'confirm_patch' },
        patch_id: { type: 'string', minLength: 1 },
      },
      additionalProperties: true,
    },
  ],
} as const satisfies JsonSchema

export const taskgraphPatchParamsSchema = {
  type: 'object',
  required: ['taskgraph_id', 'operation'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    operation: taskgraphPatchOperationSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphPatchResultPreviewSchema = {
  type: 'object',
  required: ['type', 'patch_id', 'graph'],
  properties: {
    type: { const: 'preview' },
    patch_id: { type: 'string', minLength: 1 },
    graph: taskGraphRefSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphPatchResultAppliedSchema = {
  type: 'object',
  required: ['type', 'revision'],
  properties: {
    type: { const: 'applied' },
    revision: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphPatchResultRejectedSchema = {
  type: 'object',
  required: ['type', 'errors'],
  properties: {
    type: { const: 'rejected' },
    errors: { type: 'array', items: PATCH_ERROR_SCHEMA },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphPatchResultSchema = {
  oneOf: [
    taskgraphPatchResultPreviewSchema,
    taskgraphPatchResultAppliedSchema,
    taskgraphPatchResultRejectedSchema,
  ],
} as const satisfies JsonSchema

// ─── taskgraph.status ─────────────────────────────────────────────────────────

export const taskgraphStatusParamsSchema = {
  type: 'object',
  required: ['taskgraph_id'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphTerminalOutcomeDoneSchema = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: { const: 'done' },
    end_output: JSON_OBJECT_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphTerminalOutcomeCancelledSchema = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: { const: 'cancelled' },
    failure: TASKGRAPH_FAILURE_CAUSE_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskgraphTerminalOutcomeSchema = {
  oneOf: [
    taskgraphTerminalOutcomeDoneSchema,
    taskgraphTerminalOutcomeCancelledSchema,
  ],
} as const satisfies JsonSchema

const taskgraphActiveNodesSchema = {
  type: 'object',
  required: ['running', 'waiting'],
  properties: {
    running: { type: 'array', items: NODE_ID_SCHEMA },
    waiting: { type: 'array', items: NODE_ID_SCHEMA },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphStatusResultSchema = {
  type: 'object',
  required: ['taskgraph_id', 'state', 'structure_revision', 'latest_seq', 'node_counts', 'active'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    state: GRAPH_STATE_SCHEMA,
    cancel_requested: { const: true },
    on_node_failure: ON_NODE_FAILURE_POLICY_SCHEMA,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    structure_revision: { type: 'integer', minimum: 0 },
    latest_seq: { type: 'integer', minimum: 0 },
    node_counts: nodeCountsSchema,
    active: taskgraphActiveNodesSchema,
    terminal: taskgraphTerminalOutcomeSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.events ─────────────────────────────────────────────────────────

export const taskgraphEventsParamsSchema = {
  type: 'object',
  required: ['taskgraph_id'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    after_seq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphEventsResultSchema = {
  type: 'object',
  required: ['events', 'next_seq', 'latest_seq', 'has_more'],
  properties: {
    events: { type: 'array', items: TASKGRAPH_EVENT_SCHEMA },
    next_seq: { type: 'integer', minimum: 0 },
    latest_seq: { type: 'integer', minimum: 0 },
    has_more: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.signal ─────────────────────────────────────────────────────────

export const taskgraphSignalParamsSchema = {
  type: 'object',
  required: ['taskgraph_id', 'signal'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    signal: SIGNAL_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphSignalResultSchema = {
  type: 'object',
  required: ['accepted'],
  properties: {
    accepted: { const: true },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.node.inspect ───────────────────────────────────────────────────

const nodeRunInfoSchema = {
  type: 'object',
  required: ['state'],
  properties: {
    state: NODE_RUN_STATE_SCHEMA,
    error: EXECUTION_ERROR_SCHEMA,
    task_run_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphNodeInspectParamsSchema = {
  type: 'object',
  required: ['taskgraph_id', 'node_id'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    node_id: NODE_ID_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphNodeInspectResultSchema = {
  type: 'object',
  required: ['structure_revision', 'node', 'run'],
  properties: {
    structure_revision: { type: 'integer', minimum: 0 },
    node: TASK_GRAPH_NODE_SCHEMA,
    run: nodeRunInfoSchema,
    output: JSON_OBJECT_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.inspect ────────────────────────────────────────────────────────

export const taskgraphInspectParamsSchema = {
  type: 'object',
  required: ['taskgraph_id'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphInspectResultSchema = {
  type: 'object',
  required: ['graph'],
  properties: {
    graph: taskGraphRefSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.list ───────────────────────────────────────────────────────────

const taskGraphRunSummarySchema = {
  type: 'object',
  required: ['taskgraph_id', 'state', 'structure_revision', 'created_at', 'updated_at'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    state: GRAPH_STATE_SCHEMA,
    cancel_requested: { const: true },
    on_node_failure: ON_NODE_FAILURE_POLICY_SCHEMA,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    failure: TASKGRAPH_FAILURE_CAUSE_SCHEMA,
    structure_revision: { type: 'integer', minimum: 0 },
    project: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    ended_at: { type: 'string', format: 'date-time' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphListParamsSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    project: { type: 'string', minLength: 1 },
    states: {
      type: 'array',
      items: GRAPH_STATE_SCHEMA,
      minItems: 1,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphListResultSchema = {
  type: 'object',
  required: ['runs'],
  properties: {
    runs: {
      type: 'array',
      items: taskGraphRunSummarySchema,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.slip ──────────────────────────────────────────────────────────

const taskgraphSlipNodeIdsSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 128 },
  minItems: 1,
  maxItems: 256,
  uniqueItems: true,
} as const satisfies JsonSchema

export const taskgraphSlipParamsSchema = {
  type: 'object',
  required: ['taskgraph_id', 'node_ids'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    node_ids: taskgraphSlipNodeIdsSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const taskGraphSlipNodeSchema = {
  type: 'object',
  required: ['node_id', 'state'],
  properties: {
    node_id: NODE_ID_SCHEMA,
    state: NODE_RUN_STATE_SCHEMA,
    task_id: { type: 'string', minLength: 1, maxLength: 128 },
    task_category: { type: 'string', minLength: 1, maxLength: 32 },
    display_label: { type: 'string', minLength: 1, maxLength: 24 },
    description: { type: 'string', minLength: 1, maxLength: 280 },
    agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
    tool_call_count: { type: 'integer', minimum: 0 },
    tps: { type: 'number', minimum: 0, maximum: 1_000_000 },
    profile: { type: 'string', minLength: 1, maxLength: 128 },
    summary: { type: 'string', minLength: 1, maxLength: 280 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskgraphSlipResultSchema = {
  type: 'object',
  required: [
    'schema_version',
    'taskgraph_id',
    'graph_state',
    'structure_revision',
    'latest_seq',
    'nodes',
  ],
  properties: {
    schema_version: { const: 'foreman.taskgraph.slip.v1' },
    taskgraph_id: { type: 'string', minLength: 1 },
    graph_state: GRAPH_STATE_SCHEMA,
    structure_revision: { type: 'integer', minimum: 0 },
    latest_seq: { type: 'integer', minimum: 0 },
    nodes: { type: 'array', items: taskGraphSlipNodeSchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── taskgraph.wait ───────────────────────────────────────────────────────────

  | 'done'
  | 'cancelled'
  | 'paused'
  | 'waiting'
  | 'timeout'

export const taskgraphWaitParamsSchema = {
  type: 'object',
  required: ['taskgraph_id'],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    timeout_ms: { type: 'integer', minimum: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const taskgraphWaitResultSchema = {
  type: 'object',
  required: [
    'taskgraph_id',
    'state',
    'reason',
    'structure_revision',
    'latest_seq',
    'node_counts',
    'active',
  ],
  properties: {
    taskgraph_id: { type: 'string', minLength: 1 },
    state: GRAPH_STATE_SCHEMA,
    reason: {
      type: 'string',
      enum: ['done', 'cancelled', 'paused', 'waiting', 'timeout'],
    },
    on_node_failure: ON_NODE_FAILURE_POLICY_SCHEMA,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    structure_revision: { type: 'integer', minimum: 0 },
    latest_seq: { type: 'integer', minimum: 0 },
    node_counts: nodeCountsSchema,
    active: taskgraphActiveNodesSchema,
    terminal: taskgraphTerminalOutcomeSchema,
    checkpoint_node_id: NODE_ID_SCHEMA,
  },
  additionalProperties: true,
} as const satisfies JsonSchema
