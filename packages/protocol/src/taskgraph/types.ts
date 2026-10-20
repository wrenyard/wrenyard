/**
 * TaskGraph feature wire DTOs: the `taskgraph.*` params/result surface plus the
 * shared graph/patch/event/signal shapes those payloads embed.
 *
 * Declared independently of any runtime package: the shapes are structural and
 * describe exactly what crosses the IPC boundary. The daemon holds the runtime
 * JSON schemas that validate these.
 */

export type TaskGraphTemplateId =
  | 'default'
  | 'parallel-explore'
  | 'parallel-edit'
  | 'change-test'
  | 'implement'
  | 'closeout'

// ─── Protocol-owned wire types ────────────────────────────────────────────────

import type { JsonObject } from '../common/json.ts'
export type NodeId = string
export type GraphStateType = 'created' | 'running' | 'paused' | 'done' | 'cancelled'
export type NodeRunStateType = 'planned' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'cancelled'

export interface TaskGraphAction {
  type: 'start' | 'end' | 'condition' | 'convert' | 'join' | 'checkpoint' | 'task' | 'shell'
  params: JsonObject
}

export interface NodeInput {
  name: string
  source: string
  optional?: boolean
}

export interface ObjectJsonSchema {
  type: 'object'
  properties?: Record<string, JsonObject>
  required?: string[]
  [key: string]: unknown
}

export interface TaskGraphNode {
  id: NodeId
  name: string
  action: TaskGraphAction
  deps: NodeId[]
  input: NodeInput[]
  input_schema: ObjectJsonSchema
  output_schema: ObjectJsonSchema
}

export interface TaskGraph {
  id: string
  revision: number
  tg_ctx?: JsonObject
  nodes: Record<NodeId, TaskGraphNode>
}

export type PatchOperation =
  | { op: 'AddNode'; node: TaskGraphNode }
  | { op: 'RemoveNode'; id: NodeId }
  | { op: 'ReplaceNode'; node: TaskGraphNode }

export interface TaskGraphPatch {
  base_revision: number
  actor: string
  reason: string
  created_at: string
  ops: PatchOperation[]
}

export interface ExecutionError {
  code: string
  message: string
  details?: JsonObject
}

export type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number]

export interface PatchError {
  code: PatchErrorCode
  message: string
  details?: JsonObject
}

export type TaskGraphSignal =
  | { type: 'start_graph'; input: JsonObject }
  | { type: 'pause_graph' }
  | { type: 'resume_graph' }
  | { type: 'cancel_graph' }
  | { type: 'resume_checkpoint'; node_id: NodeId; output: JsonObject }

export type SourceKind = 'daemon' | 'runner' | 'action' | 'client'

export interface EventSource {
  kind: SourceKind
  id?: string
}

export interface EventRefs {
  node_id?: NodeId
  task_run_id?: string
  patch_id?: string
}

export type TaskGraphEventType = (typeof TASKGRAPH_EVENT_TYPES)[number]

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

// ─── Enum arrays ──────────────────────────────────────────────────────────────

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
] as const

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
] as const

export const ON_NODE_FAILURE_POLICIES = ['pause', 'cancel'] as const

export type OnNodeFailurePolicy = (typeof ON_NODE_FAILURE_POLICIES)[number]

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

// ─── taskgraph.signal ─────────────────────────────────────────────────────────

export interface TaskGraphSignalParams {
  taskgraph_id: string
  signal: TaskGraphSignal
}

export interface TaskGraphSignalResult {
  accepted: true
}

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

// ─── taskgraph.inspect ────────────────────────────────────────────────────────

export interface TaskGraphInspectParams {
  taskgraph_id: string
}

export interface TaskGraphInspectResult {
  graph: TaskGraph
}

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
  /** TPS: output tokens divided by recorded execution time, including tools and waits. */
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
