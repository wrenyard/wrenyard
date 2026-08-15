import type { GraphStateType, JsonObject, NodeId, NodeRunStateType, OnNodeFailurePolicy, TaskGraph, TaskGraphFailureCause, TaskGraphNode, TaskGraphPatch } from './model.mts';

// ─── Patch error codes ───────────────────────────────────────────────────────

export const PATCH_ERROR_CODES = [
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
] as const;

export type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number];

export interface PatchError {
  code: PatchErrorCode;
  message: string;
  details?: JsonObject;
}

// ─── Protocol error codes ─────────────────────────────────────────────────────

export const PROTOCOL_ERROR_CODES = [
  'TASKGRAPH_NOT_FOUND',
  'NODE_NOT_FOUND',
  'NOT_IMPLEMENTED',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

// ─── Execution error ──────────────────────────────────────────────────────────

export interface ExecutionError {
  code: string;
  message: string;
  details?: JsonObject;
}

// ─── Ignored-reason constants and type ────────────────────────────────────────

export const IGNORED_REASONS = [
  'START_INPUT_SCHEMA_MISMATCH',
  'GRAPH_ALREADY_STARTED',
  'GRAPH_NOT_PAUSED',
  'CHECKPOINT_NOT_WAITING',
  'CHECKPOINT_OUTPUT_SCHEMA_MISMATCH',
  'GRAPH_ALREADY_CANCELLED',
] as const;

export type IgnoredReason = (typeof IGNORED_REASONS)[number];

// ─── TaskGraphSignal ──────────────────────────────────────────────────────────

export type TaskGraphSignal =
  | { type: 'start_graph'; input: JsonObject }
  | { type: 'pause_graph' }
  | { type: 'resume_graph' }
  | { type: 'cancel_graph' }
  | { type: 'resume_checkpoint'; node_id: NodeId; output: JsonObject };

// ─── Event types ──────────────────────────────────────────────────────────────

export const TASKGRAPH_EVENT_TYPES = [
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
] as const;

export type TaskGraphEventType = (typeof TASKGRAPH_EVENT_TYPES)[number];

// ─── Source kind ──────────────────────────────────────────────────────────────

export const SOURCE_KINDS = ['daemon', 'runner', 'action', 'client'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface EventSource {
  kind: SourceKind;
  id?: string;
}

// ─── Event refs ───────────────────────────────────────────────────────────────

export interface EventRefs {
  node_id?: NodeId;
  task_run_id?: string;
  patch_id?: string;
}

// ─── TaskGraphEvent ───────────────────────────────────────────────────────────

export interface TaskGraphEvent {
  event_id: string;
  taskgraph_id: string;
  seq: number;
  type: TaskGraphEventType;
  occurred_at: string;
  structure_revision: number;
  source: EventSource;
  refs?: EventRefs;
  data: JsonObject;
}

// ─── Wire result types (shared with protocol layer) ───────────────────────────

export interface TaskGraphNodeCounts {
  planned: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
  interrupted: number;
  cancelled: number;
}

export interface TaskGraphActiveNodes {
  running: NodeId[];
  waiting: NodeId[];
}

export interface TaskGraphStatusResultDone {
  outcome: 'done';
  end_output?: JsonObject;
}

export interface TaskGraphStatusResultCancelled {
  outcome: 'cancelled';
  /** Structured termination evidence when the run cancelled after a node failure. */
  failure?: TaskGraphFailureCause;
}

export type TaskGraphTerminalOutcome = TaskGraphStatusResultDone | TaskGraphStatusResultCancelled;

export interface TaskGraphStatusResult {
  taskgraph_id: string;
  state: GraphStateType;
  cancel_requested?: true;
  /** Immutable create-time on-node-failure policy. Present on persisted runs. */
  on_node_failure?: OnNodeFailurePolicy;
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string;
  structure_revision: number;
  latest_seq: number;
  node_counts: TaskGraphNodeCounts;
  active: TaskGraphActiveNodes;
  terminal?: TaskGraphTerminalOutcome;
}

export interface TaskGraphEventsResult {
  events: TaskGraphEvent[];
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}

export interface TaskGraphNodeRunInfo {
  state: NodeRunStateType;
  error?: ExecutionError;
  task_run_id?: string;
}

export interface TaskGraphNodeInspectResult {
  structure_revision: number;
  node: TaskGraphNode;
  run: TaskGraphNodeRunInfo;
  output?: JsonObject;
}

export interface TaskGraphPatchResultPreview {
  type: 'preview';
  patch_id: string;
  graph: TaskGraph;
}

export interface TaskGraphPatchResultApplied {
  type: 'applied';
  revision: number;
}

export interface TaskGraphPatchResultRejected {
  type: 'rejected';
  errors: PatchError[];
}

export type TaskGraphPatchResult = TaskGraphPatchResultPreview | TaskGraphPatchResultApplied | TaskGraphPatchResultRejected;

// ─── Wire params types (used by service layer) ────────────────────────────────

export interface TaskGraphCreateParams {
  graph: {
    nodes: Record<string, TaskGraphNode>;
  };
  /** Optional authoritative project scope for this TaskGraph.
   *  When set, the runner will reject task dispatch to projects
   *  outside this scope. Existing non-FWA callers may omit it. */
  project?: string;
  /** Immutable bounded KV context inherited by every task node. */
  tg_ctx?: import('../task/context.mts').TaskContext;
  /** Optional create-time human-readable title. Immutable after creation,
   *  trimmed by the service layer, and not part of the graph structure. */
  title?: string;
  /** Immutable create-time on-node-failure policy. When omitted, defaults to
   *  'pause' (explicit/manual pause on node failure, existing behavior). */
  on_node_failure?: OnNodeFailurePolicy;
}

export interface TaskGraphCreateResult {
  taskgraph: {
    id: string;
    revision: number;
    status: 'created';
    created_at: string;
    /** Normalized create-time title when one was supplied. */
    title?: string;
  };
}

export interface TaskGraphStatusParams {
  taskgraph_id: string;
}

export interface TaskGraphEventsParams {
  taskgraph_id: string;
  after_seq?: number;
  limit?: number;
}

export interface TaskGraphNodeInspectParams {
  taskgraph_id: string;
  node_id: string;
}

export interface TaskGraphPatchOperationRequest {
  type: 'request_patch';
  patch: TaskGraphPatch;
}

export interface TaskGraphPatchOperationConfirm {
  type: 'confirm_patch';
  patch_id: string;
}

export type TaskGraphPatchOperation = TaskGraphPatchOperationRequest | TaskGraphPatchOperationConfirm;

export interface TaskGraphPatchParams {
  taskgraph_id: string;
  operation: TaskGraphPatchOperation;
}

export interface TaskGraphSignalParams {
  taskgraph_id: string;
  signal: TaskGraphSignal;
}

export interface TaskGraphSignalResult {
  accepted: true;
}

export interface TaskGraphInspectParams {
  taskgraph_id: string;
}

export interface TaskGraphInspectResult {
  graph: TaskGraph;
}

// ─── taskgraph.slip ───────────────────────────────────────────────────────────

export interface TaskGraphSlipParams {
  taskgraph_id: string;
  /** Task-node ids to project, in request order (unique, 1..256, each 1..128). */
  node_ids: NodeId[];
}

export interface TaskGraphSlipNode {
  node_id: NodeId;
  state: NodeRunStateType;
  /** Authoritative resolved task definition name (e.g. 'commit'); omitted when unresolved. */
  task_id?: string;
  /** Bounded category slug from the resolved task definition. */
  task_category?: string;
  /** Bounded single-line category display label (<=24 UTF-16 units). */
  display_label?: string;
  /** One-line description (<=280 UTF-16 units). */
  description?: string;
  /** Resolved requested agent runtime (<=128 UTF-16 units). */
  agent_runtime?: string;
  /** Durable per-task-run tool_call event count; omitted for legacy runs without a telemetry row. */
  tool_call_count?: number;
  /**
   * End-to-end effective agent-turn output speed (1000 * output_tokens /
   * agent_turn_ms over client-reported agent-turn/session wall time, which may
   * include tool execution and waiting). This is deliberately not provider
   * generation speed.
   */
  tps?: number;
  /** Resolved execution profile (<=128 UTF-16 units); omitted when absent or out of bound. */
  profile?: string;
  /** Folded task summary (<=280 UTF-16 units); surfaced only for done nodes. */
  summary?: string;
}

export interface TaskGraphSlipResult {
  schema_version: 'foreman.taskgraph.slip.v1';
  taskgraph_id: string;
  graph_state: GraphStateType;
  structure_revision: number;
  latest_seq: number;
  nodes: TaskGraphSlipNode[];
}

// ─── taskgraph.list ────────────────────────────────────────────────────────────

export interface TaskGraphListParams {
  /** Optional project filter. */
  project?: string;
  /** Optional state filter. When omitted, returns all states. Default handled by service/store. */
  states?: GraphStateType[];
  /** Maximum results. Default handled by service/store. */
  limit?: number;
}

export interface TaskGraphRunSummary {
  taskgraph_id: string;
  state: GraphStateType;
  cancel_requested?: true;
  /** Immutable create-time on-node-failure policy. Present on persisted runs. */
  on_node_failure?: OnNodeFailurePolicy;
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string;
  /** Structured termination evidence when the run cancelled after a node failure. */
  failure?: TaskGraphFailureCause;
  structure_revision: number;
  project?: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
}

export interface TaskGraphListResult {
  runs: TaskGraphRunSummary[];
}

// ─── taskgraph.wait ───────────────────────────────────────────────────────────

export interface TaskGraphWaitParams {
  taskgraph_id: string;
  /** Bounded wait window in milliseconds before returning reason 'timeout'. */
  timeout_ms?: number;
}

export type TaskGraphWaitReason =
  | 'done'
  | 'cancelled'
  | 'paused'
  | 'waiting'
  | 'timeout';

export interface TaskGraphWaitResult {
  taskgraph_id: string;
  state: GraphStateType;
  reason: TaskGraphWaitReason;
  /** Immutable create-time on-node-failure policy. Present on persisted runs. */
  on_node_failure?: OnNodeFailurePolicy;
  /** Immutable create-time title. Present on persisted runs with a title. */
  title?: string;
  structure_revision: number;
  latest_seq: number;
  node_counts: TaskGraphNodeCounts;
  active: TaskGraphActiveNodes;
  terminal?: TaskGraphTerminalOutcome;
  /** Node id of the active checkpoint when reason is 'waiting'. */
  checkpoint_node_id?: NodeId;
}

// ─── JSON Schema fragments (as-const) ─────────────────────────────────────────

export const PATCH_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: PATCH_ERROR_CODES },
    message: { type: 'string' },
    details: { type: 'object' },
  },
  required: ['code', 'message'],
} as const;

export const PROTOCOL_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: PROTOCOL_ERROR_CODES },
    message: { type: 'string' },
    details: { type: 'object' },
  },
  required: ['code', 'message'],
} as const;

export const EXECUTION_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'object' },
  },
  required: ['code', 'message'],
} as const;

export const SIGNAL_SCHEMA = {
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
} as const;

export const EVENT_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: SOURCE_KINDS },
    id: { type: 'string' },
  },
  required: ['kind'],
} as const;

export const EVENT_REFS_SCHEMA = {
  type: 'object',
  properties: {
    node_id: { type: 'string' },
    task_run_id: { type: 'string' },
    patch_id: { type: 'string' },
  },
} as const;

export const TASKGRAPH_EVENT_SCHEMA = {
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
} as const;
