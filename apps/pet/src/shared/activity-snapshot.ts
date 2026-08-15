// ── Foreman activity.snapshot v1 — strict client projection ─────────
// Single-source read-only projection for Pet presence/status. The daemon
// returns one atomic snapshot of active direct + TaskGraph task runs,
// non-terminal graphs plus tracked terminal graphs, node dynamic state and
// safe telemetry. This module strictly normalizes that response fail-closed:
// any malformed required field rejects the WHOLE round so the caller keeps
// its previous complete presence. Display strings go through the central
// bounded primitive; raw params, schemas, prompts, outputs and transcripts
// never cross this boundary.

import { normalizeServerDisplayString, type ServerDisplayPolicy } from './taskgraph';

export const ACTIVITY_SNAPSHOT_SCHEMA_VERSION = 'foreman.activity.snapshot.v1';

export type ActivityTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type ActivityTaskGraphState = 'created' | 'running' | 'paused' | 'done' | 'cancelled';
export type ActivityNodeState = 'planned' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export type ActivityTerminalReason = 'success' | 'node_failed' | 'cancelled';
export type ActivityNodeFailureMode = 'pause' | 'cancel';

// Pre-normalization cardinality bounds. Oversized responses fail closed in
// O(1) before any untrusted element is mapped or normalized.
export const MAX_ACTIVITY_TASKS = 512;
export const MAX_ACTIVITY_TASKGRAPHS = 128;
export const MAX_ACTIVITY_NODES_PER_GRAPH = 1024;
export const MAX_TRACKED_TASKGRAPH_IDS = 128;

// ── Normalized wire projection (foreman.activity.snapshot.v1) ────────
export interface ActivitySnapshotTask {
  task_run_id: string;
  status: 'queued' | 'running';
  task_id?: string;
  task_label?: string;
  project?: string;
  worktree?: boolean;
  requested_agent_runtime?: string;
  resolved_profile?: string;
  created_at: string;
  updated_at: string;
  taskgraph_id?: string;
  node_id?: string;
}

export interface ActivitySnapshotNode {
  node_id: string;
  state: ActivityNodeState;
  task_run_id?: string;
  /** Foreman task definition name (e.g. commit/forge-deploy/investigate),
   * distinct from the runtime instance id task_run_id. Optional; the tip's
   * 任务 ID row shows exactly this value and omits the row when absent. */
  task_id?: string;
  task_status?: ActivityTaskStatus;
  task_category?: { id: string; display_label?: string };
  display_label?: string;
  description?: string;
  requested_agent_runtime?: string;
  resolved_profile?: string;
  tool_call_count?: number;
  /** Trusted elapsed runtime in milliseconds for the node's task run.
   * Optional; a missing or invalid value is omitted fail-closed so a
   * malformed telemetry field can never reject the whole round. */
  runtime_ms?: number;
  tps?: number;
  summary?: string;
}

export interface ActivitySnapshotTaskGraph {
  taskgraph_id: string;
  state: ActivityTaskGraphState;
  title?: string;
  project?: string;
  on_node_failure: ActivityNodeFailureMode;
  cancel_requested: boolean;
  structure_revision: number;
  latest_seq: number;
  terminal_reason?: ActivityTerminalReason;
  node_counts: {
    planned: number;
    running: number;
    waiting: number;
    done: number;
    failed: number;
    interrupted: number;
    cancelled: number;
  };
  active: { running: string[]; waiting: string[] };
  nodes: ActivitySnapshotNode[];
}

export interface ActivitySnapshotV1 {
  schema_version: typeof ACTIVITY_SNAPSHOT_SCHEMA_VERSION;
  sampled_at: string;
  tasks: ActivitySnapshotTask[];
  taskgraphs: ActivitySnapshotTaskGraph[];
}

// ── Derived client presence (camelCase, main→consumer) ──────────────
export interface ActivityTaskPresence {
  taskRunId: string;
  status: 'queued' | 'running';
  taskId?: string;
  taskLabel?: string;
  project?: string;
  worktree?: boolean;
  resolvedProfile?: string;
  taskgraphId?: string;
  nodeId?: string;
}

export interface ActivityNodePresence {
  nodeId: string;
  state: ActivityNodeState;
  taskRunId?: string;
  taskId?: string;
  taskStatus?: ActivityTaskStatus;
  taskCategoryId?: string;
  taskCategoryLabel?: string;
  displayLabel?: string;
  description?: string;
  requestedAgentRuntime?: string;
  resolvedProfile?: string;
  toolCallCount?: number;
  runtimeMs?: number;
  tps?: number;
  summary?: string;
}

export interface ActivityTaskGraphPresence {
  taskgraphId: string;
  state: ActivityTaskGraphState;
  title?: string;
  project?: string;
  structureRevision: number;
  latestSeq: number;
  terminalReason?: ActivityTerminalReason;
  nodeCounts: ActivitySnapshotTaskGraph['node_counts'];
  active: { running: string[]; waiting: string[] };
  nodes: ActivityNodePresence[];
}

export interface ActivityPresence {
  sampledAt: string;
  stale: boolean;
  tasks: ActivityTaskPresence[];
  taskgraphs: ActivityTaskGraphPresence[];
}

// ── Display string policies (all through the central primitive) ──────
const ACTIVITY_LABEL_POLICY: ServerDisplayPolicy = { maxCodeUnits: 120, singleLine: true, whitespace: 'trim' };
const ACTIVITY_SLIP_LABEL_POLICY: ServerDisplayPolicy = { maxCodeUnits: 24, singleLine: true, whitespace: 'trim' };
const ACTIVITY_SLUG_POLICY: ServerDisplayPolicy = { maxCodeUnits: 32, singleLine: true, whitespace: 'trim' };
const ACTIVITY_TEXT_POLICY: ServerDisplayPolicy = { maxCodeUnits: 280, singleLine: true, whitespace: 'trim' };
const ACTIVITY_IDENT_POLICY: ServerDisplayPolicy = { maxCodeUnits: 128, singleLine: true, whitespace: 'trim' };

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']);
const VALID_TASK_RUN_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);
const VALID_GRAPH_STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'done', 'cancelled']);
const VALID_NODE_STATES: ReadonlySet<string> = new Set(['planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled']);
const VALID_TERMINAL_REASONS: ReadonlySet<string> = new Set(['success', 'node_failed', 'cancelled']);
const VALID_NODE_FAILURE_MODES: ReadonlySet<string> = new Set(['pause', 'cancel']);

// ── Strict assertion helpers ─────────────────────────────────────────
function assertRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`ActivitySnapshot: expected object at ${path}, got ${typeof v}`);
  }
  return v as Record<string, unknown>;
}

function assertString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`ActivitySnapshot: expected nonempty string at ${path}, got ${typeof v}`);
  }
  return v;
}

function assertOptionalString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return assertString(v, path);
}

function assertBoolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`ActivitySnapshot: expected boolean at ${path}, got ${typeof v}`);
  }
  return v;
}

// Nonnegative safe integer identity/count: negative, fractional, NaN/
// Infinity and unsafe integers are rejected outright — never coerced.
function assertNonnegSafeInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`ActivitySnapshot: expected nonnegative safe integer at ${path}, got ${typeof v}`);
  }
  return v;
}

function assertEnum<T extends string>(v: unknown, path: string, allowed: ReadonlySet<string>): T {
  const s = assertString(v, path);
  if (!allowed.has(s)) {
    throw new Error(`ActivitySnapshot: invalid value "${s}" at ${path}`);
  }
  return s as T;
}

function normalizeOptionalDisplay(v: unknown, policy: ServerDisplayPolicy): string | undefined {
  if (v === undefined || v === null) return undefined;
  return normalizeServerDisplayString(v, policy);
}

// Task category slug: canonical lowercase slug grammar on top of the
// central single-line trim policy.
function normalizeCategorySlug(v: unknown): string | undefined {
  const label = normalizeServerDisplayString(v, ACTIVITY_SLUG_POLICY);
  if (label === undefined) return undefined;
  return /^[a-z][a-z0-9-]{0,31}$/.test(label) ? label : undefined;
}

function normalizeTps(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v < 0 || v > 1_000_000) return undefined;
  return v;
}

// Optional nonnegative safe integer (ms elapsed etc.): missing or invalid
// values — negative, fractional, NaN/Infinity, unsafe integers, non-numbers —
// are omitted fail-closed, never coerced and never reject the whole round.
function normalizeOptionalNonnegSafeInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return undefined;
  return v;
}

// ── Task / node / graph normalization ────────────────────────────────
export function normalizeActivitySnapshotTask(v: unknown, path: string): ActivitySnapshotTask {
  const r = assertRecord(v, path);
  const result: ActivitySnapshotTask = {
    task_run_id: assertString(r.task_run_id, `${path}.task_run_id`),
    status: assertEnum<'queued' | 'running'>(r.status, `${path}.status`, VALID_TASK_RUN_STATUSES),
    created_at: assertString(r.created_at, `${path}.created_at`),
    updated_at: assertString(r.updated_at, `${path}.updated_at`),
  };
  const taskId = assertOptionalString(r.task_id, `${path}.task_id`);
  if (taskId !== undefined) result.task_id = taskId;
  const taskLabel = normalizeOptionalDisplay(r.task_label, ACTIVITY_LABEL_POLICY);
  if (taskLabel !== undefined) result.task_label = taskLabel;
  const project = normalizeOptionalDisplay(r.project, ACTIVITY_LABEL_POLICY);
  if (project !== undefined) result.project = project;
  if (r.worktree !== undefined && r.worktree !== null) {
    result.worktree = assertBoolean(r.worktree, `${path}.worktree`);
  }
  const agentRuntime = normalizeOptionalDisplay(r.requested_agent_runtime, ACTIVITY_IDENT_POLICY);
  if (agentRuntime !== undefined) result.requested_agent_runtime = agentRuntime;
  const profile = normalizeOptionalDisplay(r.resolved_profile, ACTIVITY_IDENT_POLICY);
  if (profile !== undefined) result.resolved_profile = profile;
  const taskgraphId = assertOptionalString(r.taskgraph_id, `${path}.taskgraph_id`);
  if (taskgraphId !== undefined) result.taskgraph_id = taskgraphId;
  const nodeId = assertOptionalString(r.node_id, `${path}.node_id`);
  if (nodeId !== undefined) result.node_id = nodeId;
  return result;
}

export function normalizeActivitySnapshotNode(v: unknown, path: string): ActivitySnapshotNode {
  const r = assertRecord(v, path);
  const result: ActivitySnapshotNode = {
    node_id: assertString(r.node_id, `${path}.node_id`),
    state: assertEnum<ActivityNodeState>(r.state, `${path}.state`, VALID_NODE_STATES),
  };
  const taskRunId = assertOptionalString(r.task_run_id, `${path}.task_run_id`);
  if (taskRunId !== undefined) result.task_run_id = taskRunId;
  const taskId = normalizeOptionalDisplay(r.task_id, ACTIVITY_IDENT_POLICY);
  if (taskId !== undefined) result.task_id = taskId;
  const taskStatus = r.task_status === undefined || r.task_status === null
    ? undefined
    : assertEnum<ActivityTaskStatus>(r.task_status, `${path}.task_status`, VALID_TASK_STATUSES);
  if (taskStatus !== undefined) result.task_status = taskStatus;

  if (r.task_category !== undefined && r.task_category !== null) {
    const cat = assertRecord(r.task_category, `${path}.task_category`);
    const id = normalizeCategorySlug(cat.id);
    if (id !== undefined) {
      const label = normalizeOptionalDisplay(cat.display_label, ACTIVITY_SLIP_LABEL_POLICY);
      result.task_category = label !== undefined ? { id, display_label: label } : { id };
    }
  }
  const displayLabel = normalizeOptionalDisplay(r.display_label, ACTIVITY_SLIP_LABEL_POLICY);
  if (displayLabel !== undefined) result.display_label = displayLabel;
  const description = normalizeOptionalDisplay(r.description, ACTIVITY_TEXT_POLICY);
  if (description !== undefined) result.description = description;
  const agentRuntime = normalizeOptionalDisplay(r.requested_agent_runtime, ACTIVITY_IDENT_POLICY);
  if (agentRuntime !== undefined) result.requested_agent_runtime = agentRuntime;
  const profile = normalizeOptionalDisplay(r.resolved_profile, ACTIVITY_IDENT_POLICY);
  if (profile !== undefined) result.resolved_profile = profile;
  if (r.tool_call_count !== undefined && r.tool_call_count !== null) {
    result.tool_call_count = assertNonnegSafeInt(r.tool_call_count, `${path}.tool_call_count`);
  }
  const runtimeMs = normalizeOptionalNonnegSafeInt(r.runtime_ms);
  if (runtimeMs !== undefined) result.runtime_ms = runtimeMs;
  const tps = normalizeTps(r.tps);
  if (tps !== undefined) result.tps = tps;
  const summary = normalizeOptionalDisplay(r.summary, ACTIVITY_TEXT_POLICY);
  if (summary !== undefined) result.summary = summary;
  return result;
}

export function normalizeActivitySnapshotTaskGraph(v: unknown, path: string): ActivitySnapshotTaskGraph {
  const r = assertRecord(v, path);
  const nc = assertRecord(r.node_counts, `${path}.node_counts`);
  const active = assertRecord(r.active, `${path}.active`);
  const activeRunning = active.running;
  const activeWaiting = active.waiting;
  if (!Array.isArray(activeRunning)) throw new Error(`ActivitySnapshot: expected array at ${path}.active.running`);
  if (!Array.isArray(activeWaiting)) throw new Error(`ActivitySnapshot: expected array at ${path}.active.waiting`);
  const rawNodes = r.nodes;
  if (!Array.isArray(rawNodes)) throw new Error(`ActivitySnapshot: expected array at ${path}.nodes`);
  // O(1) cardinality guard before any element normalization.
  if (rawNodes.length > MAX_ACTIVITY_NODES_PER_GRAPH) {
    throw new Error(`ActivitySnapshot: nodes cardinality exceeds ${MAX_ACTIVITY_NODES_PER_GRAPH} at ${path}.nodes`);
  }

  const result: ActivitySnapshotTaskGraph = {
    taskgraph_id: assertString(r.taskgraph_id, `${path}.taskgraph_id`),
    state: assertEnum<ActivityTaskGraphState>(r.state, `${path}.state`, VALID_GRAPH_STATES),
    on_node_failure: assertEnum<ActivityNodeFailureMode>(r.on_node_failure, `${path}.on_node_failure`, VALID_NODE_FAILURE_MODES),
    cancel_requested: assertBoolean(r.cancel_requested, `${path}.cancel_requested`),
    structure_revision: assertNonnegSafeInt(r.structure_revision, `${path}.structure_revision`),
    latest_seq: assertNonnegSafeInt(r.latest_seq, `${path}.latest_seq`),
    node_counts: {
      planned: assertNonnegSafeInt(nc.planned, `${path}.node_counts.planned`),
      running: assertNonnegSafeInt(nc.running, `${path}.node_counts.running`),
      waiting: assertNonnegSafeInt(nc.waiting, `${path}.node_counts.waiting`),
      done: assertNonnegSafeInt(nc.done, `${path}.node_counts.done`),
      failed: assertNonnegSafeInt(nc.failed, `${path}.node_counts.failed`),
      interrupted: assertNonnegSafeInt(nc.interrupted, `${path}.node_counts.interrupted`),
      cancelled: assertNonnegSafeInt(nc.cancelled, `${path}.node_counts.cancelled`),
    },
    active: {
      running: activeRunning.map((item, i) => assertString(item, `${path}.active.running[${i}]`)),
      waiting: activeWaiting.map((item, i) => assertString(item, `${path}.active.waiting[${i}]`)),
    },
    nodes: rawNodes.map((item, i) => normalizeActivitySnapshotNode(item, `${path}.nodes[${i}]`)),
  };
  const title = normalizeOptionalDisplay(r.title, ACTIVITY_LABEL_POLICY);
  if (title !== undefined) result.title = title;
  const project = normalizeOptionalDisplay(r.project, ACTIVITY_LABEL_POLICY);
  if (project !== undefined) result.project = project;
  const terminalReason = r.terminal_reason === undefined || r.terminal_reason === null
    ? undefined
    : assertEnum<ActivityTerminalReason>(r.terminal_reason, `${path}.terminal_reason`, VALID_TERMINAL_REASONS);
  if (terminalReason !== undefined) result.terminal_reason = terminalReason;
  return result;
}

/**
 * Strict fail-closed normalizer for the foreman.activity.snapshot.v1 wire
 * response. Any malformed required field throws, so the caller discards the
 * whole round and keeps its previous complete presence — partial state is
 * never published. Cardinality bounds are enforced before normalization.
 */
export function normalizeActivitySnapshotV1(raw: unknown): ActivitySnapshotV1 {
  const r = assertRecord(raw, 'activity.snapshot');
  const schemaVersion = assertString(r.schema_version, 'schema_version');
  if (schemaVersion !== ACTIVITY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `ActivitySnapshot: schema_version mismatch: expected ${ACTIVITY_SNAPSHOT_SCHEMA_VERSION}, got ${schemaVersion}`,
    );
  }
  const rawTasks = r.tasks;
  const rawGraphs = r.taskgraphs;
  if (!Array.isArray(rawTasks)) throw new Error('ActivitySnapshot: tasks must be an array');
  if (!Array.isArray(rawGraphs)) throw new Error('ActivitySnapshot: taskgraphs must be an array');
  if (rawTasks.length > MAX_ACTIVITY_TASKS) {
    throw new Error(`ActivitySnapshot: tasks cardinality exceeds ${MAX_ACTIVITY_TASKS}`);
  }
  if (rawGraphs.length > MAX_ACTIVITY_TASKGRAPHS) {
    throw new Error(`ActivitySnapshot: taskgraphs cardinality exceeds ${MAX_ACTIVITY_TASKGRAPHS}`);
  }

  return {
    schema_version: ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: assertString(r.sampled_at, 'sampled_at'),
    tasks: rawTasks.map((item, i) => normalizeActivitySnapshotTask(item, `tasks[${i}]`)),
    taskgraphs: rawGraphs.map((item, i) => normalizeActivitySnapshotTaskGraph(item, `taskgraphs[${i}]`)),
  };
}

/**
 * Derive the camelCase client presence from a strictly normalized snapshot.
 * Only queued/running task runs appear in `tasks`; taskgraph presence carries
 * every node with its dynamic state and safe telemetry. `stale` is supplied
 * by the caller (false for a fresh round, true when re-emitting a previous
 * complete snapshot after a failed round).
 */
export function deriveActivityPresence(snapshot: ActivitySnapshotV1, stale: boolean): ActivityPresence {
  const tasks: ActivityTaskPresence[] = snapshot.tasks.map((task) => ({
    taskRunId: task.task_run_id,
    status: task.status,
    ...(task.task_id !== undefined ? { taskId: task.task_id } : {}),
    ...(task.task_label !== undefined ? { taskLabel: task.task_label } : {}),
    ...(task.project !== undefined ? { project: task.project } : {}),
    ...(task.worktree !== undefined ? { worktree: task.worktree } : {}),
    ...(task.resolved_profile !== undefined ? { resolvedProfile: task.resolved_profile } : {}),
    ...(task.taskgraph_id !== undefined ? { taskgraphId: task.taskgraph_id } : {}),
    ...(task.node_id !== undefined ? { nodeId: task.node_id } : {}),
  }));

  const taskgraphs: ActivityTaskGraphPresence[] = snapshot.taskgraphs.map((graph) => {
    const presence: ActivityTaskGraphPresence = {
      taskgraphId: graph.taskgraph_id,
      state: graph.state,
      structureRevision: graph.structure_revision,
      latestSeq: graph.latest_seq,
      nodeCounts: graph.node_counts,
      active: graph.active,
      nodes: graph.nodes.map((node) => {
        const n: ActivityNodePresence = {
          nodeId: node.node_id,
          state: node.state,
        };
        if (node.task_run_id !== undefined) n.taskRunId = node.task_run_id;
        if (node.task_id !== undefined) n.taskId = node.task_id;
        if (node.task_status !== undefined) n.taskStatus = node.task_status;
        if (node.task_category !== undefined) {
          n.taskCategoryId = node.task_category.id;
          if (node.task_category.display_label !== undefined) n.taskCategoryLabel = node.task_category.display_label;
        }
        if (node.display_label !== undefined) n.displayLabel = node.display_label;
        if (node.description !== undefined) n.description = node.description;
        if (node.requested_agent_runtime !== undefined) n.requestedAgentRuntime = node.requested_agent_runtime;
        if (node.resolved_profile !== undefined) n.resolvedProfile = node.resolved_profile;
        if (node.tool_call_count !== undefined) n.toolCallCount = node.tool_call_count;
        if (node.runtime_ms !== undefined) n.runtimeMs = node.runtime_ms;
        if (node.tps !== undefined) n.tps = node.tps;
        if (node.summary !== undefined) n.summary = node.summary;
        return n;
      }),
    };
    if (graph.title !== undefined) presence.title = graph.title;
    if (graph.project !== undefined) presence.project = graph.project;
    if (graph.terminal_reason !== undefined) presence.terminalReason = graph.terminal_reason;
    return presence;
  });

  return {
    sampledAt: snapshot.sampled_at,
    stale,
    tasks,
    taskgraphs,
  };
}

/**
 * Deduplicate + bound tracked terminal graph ids for the poller request.
 * Pet only tracks graphs it still holds so the daemon returns each terminal
 * graph at most once while Pet is alive.
 */
export function normalizeTrackedTaskgraphIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_TRACKED_TASKGRAPH_IDS) break;
  }
  return out;
}
