import type { JsonSchema } from '../jsonrpc.mts'

type TaskGraphTemplateId =
  | 'default'
  | 'parallel-explore'
  | 'parallel-edit'
  | 'change-test'
  | 'implement'
  | 'closeout'

// ─── Protocol-owned wire types ────────────────────────────────────────────────

type JsonObject = { [key: string]: unknown }
type NodeId = string
type GraphStateType = 'created' | 'running' | 'paused' | 'done' | 'cancelled'
type NodeRunStateType = 'planned' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'cancelled'

interface TaskGraphAction {
  type: 'start' | 'end' | 'condition' | 'convert' | 'join' | 'checkpoint' | 'task' | 'llm' | 'shell'
  params: JsonObject
}

interface NodeInput {
  name: string
  source: string
  optional?: boolean
}

interface ObjectJsonSchema {
  type: 'object'
  properties?: Record<string, JsonObject>
  required?: string[]
  [key: string]: unknown
}

interface TaskGraphNode {
  id: NodeId
  name: string
  action: TaskGraphAction
  deps: NodeId[]
  input: NodeInput[]
  input_schema: ObjectJsonSchema
  output_schema: ObjectJsonSchema
}

interface TaskGraph {
  id: string
  revision: number
  tg_ctx?: JsonObject
  nodes: Record<NodeId, TaskGraphNode>
}

type PatchOperation =
  | { op: 'AddNode'; node: TaskGraphNode }
  | { op: 'RemoveNode'; id: NodeId }
  | { op: 'ReplaceNode'; node: TaskGraphNode }

interface TaskGraphPatch {
  base_revision: number
  actor: string
  reason: string
  created_at: string
  ops: PatchOperation[]
}

interface ExecutionError {
  code: string
  message: string
  details?: JsonObject
}

type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number]

interface PatchError {
  code: PatchErrorCode
  message: string
  details?: JsonObject
}

type TaskGraphSignal =
  | { type: 'start_graph'; input: JsonObject }
  | { type: 'pause_graph' }
  | { type: 'resume_graph' }
  | { type: 'cancel_graph' }
  | { type: 'resume_checkpoint'; node_id: NodeId; output: JsonObject }

type SourceKind = 'daemon' | 'runner' | 'action' | 'client'

interface EventSource {
  kind: SourceKind
  id?: string
}

interface EventRefs {
  node_id?: NodeId
  task_run_id?: string
  patch_id?: string
}

type TaskGraphEventType = (typeof TASKGRAPH_EVENT_TYPES)[number]

export interface TaskGraphEvent {
  event_id: string
  taskgraph_id: string
  seq: number
  type: TaskGraphEventType
  occurred_at: string
  structure_revision: number
  source: EventSource
  refs?: EventRefs
  data: JsonObject
}

// ─── Local enum arrays (inlined from core) ───────────────────────────────────

const PATCH_ERROR_CODES = [
  'STALE_BASE',
  'PATCH_NOT_FOUND',
  'DUP_ID',
  'FROZEN_NODE',
  'MAP_PATH_UNKNOWN',
  'MAP_TYPE_MISMATCH',
  'INPUT_INCOMPLETE',
  'MAP_NOT_IN_DEPS',
  'CYCLE',
  'DANGLING_DEP',
  'SCHEMA_INVALID',
  'SCHEMA_REQUIRED',
] as const

const TASKGRAPH_EVENT_TYPES = [
  'taskgraph.created',
  'taskgraph.started',
  'taskgraph.paused',
  'taskgraph.resumed',
  'taskgraph.done',
  'taskgraph.cancelled',
  'taskgraph.node.started',
  'taskgraph.node.completed',
  'taskgraph.node.failed',
  'taskgraph.node.interrupted',
  'taskgraph.node.cancelled',
  'taskgraph.checkpoint.entered',
  'taskgraph.checkpoint.resumed',
  'taskgraph.patch.applied',
  'taskgraph.signal.received',
  'taskgraph.signal.ignored',
] as const

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
    type: { type: 'string', enum: ['start', 'end', 'condition', 'convert', 'join', 'checkpoint', 'task', 'llm', 'shell'] },
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

const ON_NODE_FAILURE_POLICIES = ['pause', 'cancel'] as const

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

export interface TaskGraphCreateParams {
  /** Named create-time topology. Full IR is not accepted on create. */
  template: TaskGraphTemplateId
  project?: string
  /** Immutable bounded KV context inherited by every task node. */
  tg_ctx?: JsonObject
  /** Optional create-time human-readable title. Immutable after creation and
   *  not part of the graph structure. */
  title?: string
  /** Immutable create-time on-node-failure policy. When omitted, defaults to 'pause'. */
  on_node_failure?: 'pause' | 'cancel'
}

export interface TaskGraphCreateResult {
  taskgraph: {
    id: string
    revision: number
    status: 'created'
    created_at: string
    /** Normalized create-time title when one was supplied. */
    title?: string
  }
}

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

export interface TaskGraphPatchOperationRequest {
  type: 'request_patch'
  patch: TaskGraphPatch
}

export interface TaskGraphPatchOperationConfirm {
  type: 'confirm_patch'
  patch_id: string
}

export type TaskGraphPatchOperation = TaskGraphPatchOperationRequest | TaskGraphPatchOperationConfirm

export interface TaskGraphPatchParams {
  taskgraph_id: string
  operation: TaskGraphPatchOperation
}

export interface TaskGraphPatchResultPreview {
  type: 'preview'
  patch_id: string
  graph: TaskGraph
}

export interface TaskGraphPatchResultApplied {
  type: 'applied'
  revision: number
}

export interface TaskGraphPatchResultRejected {
  type: 'rejected'
  errors: PatchError[]
}

export type TaskGraphPatchResult = TaskGraphPatchResultPreview | TaskGraphPatchResultApplied | TaskGraphPatchResultRejected

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

export interface TaskGraphNodeCounts {
  planned: number
  running: number
  waiting: number
  done: number
  failed: number
  interrupted: number
  cancelled: number
}

export interface TaskGraphActiveNodes {
  running: NodeId[]
  waiting: NodeId[]
}

export interface TaskGraphStatusParams {
  taskgraph_id: string
}

export interface TaskGraphStatusResultDone {
  outcome: 'done'
  end_output?: JsonObject
}

export interface TaskGraphStatusResultCancelled {
  outcome: 'cancelled'
  /** Structured termination evidence when the run cancelled after a node failure. */
  failure?: {
    kind: 'node_failed' | 'recovery_failed'
    node_id: string
    task_run_id?: string
    error: ExecutionError
    event_id?: string
  }
}

export type TaskGraphTerminalOutcome = TaskGraphStatusResultDone | TaskGraphStatusResultCancelled

export interface TaskGraphStatusResult {
  taskgraph_id: string
  state: GraphStateType
  cancel_requested?: true
  on_node_failure?: 'pause' | 'cancel'
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string
  structure_revision: number
  latest_seq: number
  node_counts: TaskGraphNodeCounts
  active: TaskGraphActiveNodes
  terminal?: TaskGraphTerminalOutcome
}

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

export interface TaskGraphEventsParams {
  taskgraph_id: string
  after_seq?: number
  limit?: number
}

export interface TaskGraphEventsResult {
  events: TaskGraphEvent[]
  next_seq: number
  latest_seq: number
  has_more: boolean
}

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

export interface TaskGraphSignalParams {
  taskgraph_id: string
  signal: TaskGraphSignal
}

export interface TaskGraphSignalResult {
  accepted: true
}

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

export interface TaskGraphNodeRunInfo {
  state: NodeRunStateType
  error?: ExecutionError
  task_run_id?: string
}

export interface TaskGraphNodeInspectParams {
  taskgraph_id: string
  node_id: string
}

export interface TaskGraphNodeInspectResult {
  structure_revision: number
  node: TaskGraphNode
  run: TaskGraphNodeRunInfo
  output?: JsonObject
}

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

export interface TaskGraphInspectParams {
  taskgraph_id: string
}

export interface TaskGraphInspectResult {
  graph: TaskGraph
}

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

export interface TaskGraphListParams {
  limit?: number
  project?: string
  states?: GraphStateType[]
}

export interface TaskGraphRunSummary {
  taskgraph_id: string
  state: GraphStateType
  cancel_requested?: true
  on_node_failure?: 'pause' | 'cancel'
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string
  failure?: {
    kind: 'node_failed' | 'recovery_failed'
    node_id: string
    task_run_id?: string
    error: ExecutionError
    event_id?: string
  }
  structure_revision: number
  project?: string
  created_at: string
  updated_at: string
  ended_at?: string
}

export interface TaskGraphListResult {
  runs: TaskGraphRunSummary[]
}

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

export interface TaskGraphSlipParams {
  taskgraph_id: string
  /** Task-node ids to project, in request order. Unique, 1..256, each 1..128. */
  node_ids: string[]
}

export interface TaskGraphSlipNode {
  node_id: string
  state: NodeRunStateType
  /** Authoritative resolved task definition name (e.g. 'commit'); omitted when unresolved. */
  task_id?: string
  /** Bounded category slug from the resolved task definition. */
  task_category?: string
  /** Bounded single-line category display label (<=24 UTF-16 units). */
  display_label?: string
  /** One-line description (<=280 UTF-16 units). */
  description?: string
  /** Resolved requested agent runtime (<=128 UTF-16 units). */
  agent_runtime?: string
  /** Durable per-task-run tool_call event count; omitted for legacy runs without a telemetry row. */
  tool_call_count?: number
  /**
   * End-to-end effective agent-turn output speed (1000 * output_tokens /
   * agent_turn_ms over client-reported agent-turn/session wall time, which may
   * include tool execution and waiting). This is deliberately not provider
   * generation speed.
   */
  tps?: number
  /** Resolved execution profile (<=128 UTF-16 units); omitted when absent or out of bound. */
  profile?: string
  /** Folded task summary (<=280 UTF-16 units); surfaced only for done nodes. */
  summary?: string
}

export interface TaskGraphSlipResult {
  schema_version: 'foreman.taskgraph.slip.v1'
  taskgraph_id: string
  graph_state: GraphStateType
  structure_revision: number
  latest_seq: number
  nodes: TaskGraphSlipNode[]
}

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

export interface TaskGraphWaitParams {
  taskgraph_id: string
  /** Bounded wait window in milliseconds before returning reason 'timeout'. */
  timeout_ms?: number
}

export type TaskGraphWaitReason =
  | 'done'
  | 'cancelled'
  | 'paused'
  | 'waiting'
  | 'timeout'

export interface TaskGraphWaitResult {
  taskgraph_id: string
  state: GraphStateType
  /** Why the wait returned: terminal outcome, pause, active waiting checkpoint, or timeout. */
  reason: TaskGraphWaitReason
  on_node_failure?: 'pause' | 'cancel'
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string
  structure_revision: number
  latest_seq: number
  node_counts: TaskGraphNodeCounts
  active: TaskGraphActiveNodes
  terminal?: TaskGraphTerminalOutcome
  /** Node id of the active checkpoint when reason is 'waiting'. */
  checkpoint_node_id?: NodeId
}

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
