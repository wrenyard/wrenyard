// ─── JSON-safe type aliases ──────────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ─── Identifier aliases ───────────────────────────────────────────────────────

export type GraphId = string;
export type NodeId = string;
export type SourceExpr = string;

// ─── JSON Schema contract (object-top-level) ──────────────────────────────────

export interface ObjectJsonSchema {
  type: 'object';
  properties?: Record<string, JsonObject>;
  required?: string[];
  additionalProperties?: boolean | JsonObject;
  [key: string]: JsonValue | undefined;
}

// ─── Action types ─────────────────────────────────────────────────────────────

export const ACTION_TYPES = [
  'start',
  'end',
  'condition',
  'convert',
  'join',
  'checkpoint',
  'task',
  'llm',
  'shell',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

// ─── Graph states ─────────────────────────────────────────────────────────────

export const GRAPH_STATES = [
  'created',
  'running',
  'paused',
  'done',
  'cancelled',
] as const;

export type GraphStateType = (typeof GRAPH_STATES)[number];

// ─── Node run states ──────────────────────────────────────────────────────────

export const NODE_RUN_STATES = [
  'planned',
  'running',
  'waiting',
  'done',
  'failed',
  'interrupted',
  'cancelled',
] as const;

export type NodeRunStateType = (typeof NODE_RUN_STATES)[number];

// ─── Run failure policy and termination cause ─────────────────────────────────

export const ON_NODE_FAILURE_POLICIES = ['pause', 'cancel'] as const;

export type OnNodeFailurePolicy = (typeof ON_NODE_FAILURE_POLICIES)[number];

export const FAILURE_CAUSE_KINDS = ['node_failed', 'recovery_failed'] as const;

export type TaskGraphFailureCauseKind = (typeof FAILURE_CAUSE_KINDS)[number];

/** Immutable error snapshot carried by a persisted run failure. */
export interface TaskGraphFailureError {
  code: string;
  message: string;
  details?: JsonObject;
}

/** Structured termination evidence persisted when a cancel-policy run cancels. */
export interface TaskGraphFailureCause {
  kind: TaskGraphFailureCauseKind;
  node_id: NodeId;
  task_run_id?: string;
  error: TaskGraphFailureError;
  /** Identity of the taskgraph.node.failed journal event when available. */
  event_id?: string;
}

export const ON_NODE_FAILURE_POLICY_SCHEMA = {
  type: 'string',
  enum: ON_NODE_FAILURE_POLICIES,
} as const;

export const FAILURE_CAUSE_KIND_SCHEMA = {
  type: 'string',
  enum: FAILURE_CAUSE_KINDS,
} as const;

// ─── Core model types ─────────────────────────────────────────────────────────

export interface TaskGraphAction {
  type: ActionType;
  params: JsonObject;
}

export type {
  ConditionComparisonOp,
  ConditionPresenceOp,
  ConditionPredicate,
  ConditionCase,
  ConditionParams,
} from './condition.mts';

export interface NodeInput {
  name: string;
  source: SourceExpr;
  optional?: boolean;
}

export interface TaskGraphNode {
  id: NodeId;
  name: string;
  action: TaskGraphAction;
  deps: NodeId[];
  input: NodeInput[];
  input_schema: ObjectJsonSchema;
  output_schema: ObjectJsonSchema;
}

export interface TaskGraph {
  id: GraphId;
  revision: number;
  /** Immutable bounded KV context inherited by every task node. */
  tg_ctx?: import('../task/context.mts').TaskContext;
  nodes: Record<NodeId, TaskGraphNode>;
}

// ─── Patch types ──────────────────────────────────────────────────────────────

export type PatchOperation =
  | { op: 'AddNode'; node: TaskGraphNode }
  | { op: 'RemoveNode'; id: NodeId }
  | { op: 'ReplaceNode'; node: TaskGraphNode };

export interface TaskGraphPatch {
  base_revision: number;
  actor: string;
  reason: string;
  created_at: string;
  ops: PatchOperation[];
}

// ─── JSON Schema fragments (as-const) ─────────────────────────────────────────

export const ACTION_TYPE_SCHEMA = {
  type: 'string',
  enum: ACTION_TYPES,
} as const;

export const GRAPH_STATE_SCHEMA = {
  type: 'string',
  enum: GRAPH_STATES,
} as const;

export const NODE_RUN_STATE_SCHEMA = {
  type: 'string',
  enum: NODE_RUN_STATES,
} as const;

export const GRAPH_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
} as const;

export const NODE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
} as const;

export const TASKGRAPH_FAILURE_CAUSE_SCHEMA = {
  type: 'object',
  required: ['kind', 'node_id', 'error'],
  properties: {
    kind: FAILURE_CAUSE_KIND_SCHEMA,
    node_id: NODE_ID_SCHEMA,
    task_run_id: { type: 'string' },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object' },
      },
      additionalProperties: false,
    },
    event_id: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const JSON_OBJECT_SCHEMA = {
  type: 'object',
  properties: {} as JsonObject,
  additionalProperties: true,
} as const;

export const OBJECT_JSON_SCHEMA_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'object' },
  },
  required: ['type'],
} as const;

export const TASK_GRAPH_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: ACTION_TYPE_SCHEMA,
    params: JSON_OBJECT_SCHEMA,
  },
  required: ['type', 'params'],
  additionalProperties: false,
} as const;

export const NODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    source: { type: 'string' },
    optional: { type: 'boolean' },
  },
  required: ['name', 'source'],
  additionalProperties: false,
} as const;

export const TASK_GRAPH_NODE_SCHEMA = {
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
} as const;

export const TASK_GRAPH_SCHEMA = {
  type: 'object',
  properties: {
    id: GRAPH_ID_SCHEMA,
    revision: { type: 'integer', minimum: 0 },
    tg_ctx: JSON_OBJECT_SCHEMA,
    nodes: {
      type: 'object',
      additionalProperties: TASK_GRAPH_NODE_SCHEMA,
    },
  },
  required: ['id', 'revision', 'nodes'],
  additionalProperties: false,
} as const;

export const PATCH_OPERATION_SCHEMA = {
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
} as const;

export const TASK_GRAPH_PATCH_SCHEMA = {
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
} as const;
