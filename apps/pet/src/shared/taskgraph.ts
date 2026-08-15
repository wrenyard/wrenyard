// ── Read-only TaskGraph DTO model ────────────────────────────────────
// Strict normalizers: reject malformed data without partial acceptance.

export type TaskGraphState = 'created' | 'running' | 'paused' | 'done' | 'cancelled';
export type TaskGraphNodeState = 'planned' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export type TaskGraphEventType =
  | 'taskgraph.created' | 'taskgraph.started' | 'taskgraph.paused' | 'taskgraph.resumed'
  | 'taskgraph.done' | 'taskgraph.cancelled' | 'taskgraph.node.started'
  | 'taskgraph.node.completed' | 'taskgraph.node.failed' | 'taskgraph.node.interrupted'
  | 'taskgraph.node.cancelled' | 'taskgraph.checkpoint.entered'
  | 'taskgraph.checkpoint.resumed' | 'taskgraph.patch.applied'
  | 'taskgraph.signal.received' | 'taskgraph.signal.ignored';

// ── Active-only entity DTO ───────────────────────────────────────────
export interface TaskGraphEntityDto {
  id: string;
  state: 'created' | 'running' | 'paused';
  revision: number;
  created_at: string;
  /** Normalized graph title (already bounded/single-line at the activity
   * snapshot boundary); omitted when absent so the renderer falls back to
   * 未命名任务图. */
  title?: string;
  /** Revision-safe avatar fact-slip counts: `total` is the cached
   * same-revision structure node count whose action.type === 'task';
   * `done` is how many of those task nodes report state 'done' in the
   * current activity presence. Never derived from graph-level node_counts.
   * Omitted when the structure is missing/loading/revision-mismatched. */
  nodeCounts?: { done: number; total: number };
}

export type EntityPresentationState = 'stale' | 'exiting';

/**
 * Wren lifecycle presentation fields carried over the main→renderer boundary.
 * `terminal` marks a tracked graph that just reached a terminal state so the
 * renderer can play its one-time feedback pose (moss badge / fold) before the
 * owner destroys the entity; `terminal_reason` distinguishes success,
 * node_failed and cancelled finishes. `error_paused` marks a paused graph
 * with at least one failed node so the renderer shows a crack instead of a
 * manual-pause hourglass. `motion` lets the renderer cancel loop animation
 * under prefers-reduced-motion while keeping every static pose/badge/color
 * readable. The avatar fact-slip text itself comes from `title` + `nodeCounts`
 * (see TaskGraphEntityDto); lifecycle prose is forbidden.
 */
export interface TaskGraphEntityDtoWithPresentation extends TaskGraphEntityDto {
  presentation?: EntityPresentationState;
  terminal?: 'done' | 'cancelled';
  terminal_reason?: 'success' | 'node_failed' | 'cancelled';
  error_paused?: boolean;
  motion?: 'full' | 'reduced';
}

// ── Graph Slip snapshot DTO ──────────────────────────────────────────
export type TaskRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface GraphSlipNodeDto {
  id: string;
  action_type: string;
  deps: string[];
  state: TaskGraphNodeState;
  task_run_id?: string;
  /** Foreman task definition name (e.g. commit/forge-deploy/investigate)
   * from the activity snapshot node field task_id. The renderer's 任务 ID
   * tip row shows exactly this value and omits the row when absent — the
   * runtime instance id task_run_id is never shown under that label. */
  task_id?: string;
  /** User-visible task run status from the same activity snapshot. When
   * present it takes display precedence over node state (a running node whose
   * task run is still queued must render as 排队中, never 运行中). */
  task_status?: TaskRunStatus;
  runtime_ms?: number;
  // Graph Slip task display facts (foreman.taskgraph.slip.v1), normalized
  // fail-closed: each field is bounded and omitted when absent or malformed.
  task_category?: string;
  /** Pet-only task-tip heading: the cached same-revision static node.name
   * after single-line/CJK/48-UTF-16 validation. Omitted when absent or
   * invalid so the renderer falls back to display_label then '任务'. */
  task_title?: string;
  display_label?: string;
  description?: string;
  agent_runtime?: string;
  profile?: string;
  tool_call_count?: number;
  tps?: number;
  summary?: string;
}

export interface GraphSlipEdgeDto {
  from: string;
  to: string;
  label: string;
}

export interface GraphSlipSnapshotDto {
  graph_id: string;
  revision: number;
  state: TaskGraphState;
  nodes: Record<string, GraphSlipNodeDto>;
  edges: GraphSlipEdgeDto[];
  // Noncritical display metadata projected from taskgraph.status; omitted
  // entirely when malformed or absent so legacy daemon data stays safe.
  title?: string;
}

// ── Graph Slip wire contract (foreman.taskgraph.slip.v1) ────────────
// Requested exactly once per graph load with every visible action.type=task
// node id. The response is validated against the same inspect/status snapshot
// and normalized fail-closed before it may reach the projection DTO.
export const GRAPH_SLIP_SCHEMA_VERSION = 'foreman.taskgraph.slip.v1';

export interface TaskGraphSlipNode {
  node_id: string;
  state: TaskGraphNodeState;
  task_category?: string;
  display_label?: string;
  description?: string;
  agent_runtime?: string;
  profile?: string;
  tool_call_count?: number;
  tps?: number;
  summary?: string;
}

export interface TaskGraphSlipResult {
  schema_version: string;
  taskgraph_id: string;
  graph_state: TaskGraphState;
  structure_revision: number;
  latest_seq: number;
  nodes: TaskGraphSlipNode[];
}

export interface TaskGraphListRun {
  taskgraph_id: string;
  state: TaskGraphState;
  cancel_requested?: boolean;
  structure_revision: number;
  project?: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
  // Noncritical display metadata; normalized and omitted when malformed.
  title?: string;
}

export interface TaskGraphListResult {
  runs: TaskGraphListRun[];
}

export interface TaskGraphNodeAction {
  type: string;
  params?: Record<string, unknown>;
}

export interface TaskGraphNodeInputSource {
  name: string;
  source: string;
}

export interface TaskGraphNode {
  id: string;
  name?: string;
  action: TaskGraphNodeAction;
  deps: string[];
  input?: TaskGraphNodeInputSource[];
  input_schema?: unknown;
  output_schema?: unknown;
}

export interface TaskGraphInspectGraph {
  id: string;
  revision: number;
  nodes: Record<string, TaskGraphNode>;
}

export interface TaskGraphInspectResult {
  graph: TaskGraphInspectGraph;
}

export interface TaskGraphNodeCounts {
  planned: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
  interrupted: number;
  cancelled: number;
}

export interface TaskGraphStatusResult {
  taskgraph_id: string;
  state: TaskGraphState;
  cancel_requested?: boolean;
  structure_revision: number;
  latest_seq: number;
  node_counts: TaskGraphNodeCounts;
  active: {
    running: string[];
    waiting: string[];
  };
  // Noncritical display metadata; normalized and omitted when malformed.
  title?: string;
}

export interface TaskGraphNodeInspectRun {
  state: TaskGraphNodeState;
  task_run_id?: string;
}

export interface TaskGraphNodeInspectResult {
  structure_revision: number;
  node: TaskGraphNode;
  run: TaskGraphNodeInspectRun;
}

export interface TaskGraphEvent {
  taskgraph_id: string;
  seq: number;
  type: TaskGraphEventType;
  occurred_at: string;
  structure_revision: number;
  refs?: {
    node_id?: string;
    task_run_id?: string;
  };
}

export interface TaskGraphEventsResult {
  events: TaskGraphEvent[];
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}

// ── Graph Slip snapshot DTO ──────────────────────────────────────────
// This is the only TaskGraph snapshot shape allowed across the
// main→renderer boundary. Raw action params, schemas, outputs, errors,
// and event payloads intentionally remain in the main process.

export interface TaskRunEvent {
  seq: number;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  status?: string;
  exit_code?: number;
  is_error?: boolean;
}

export interface TaskRunEventsResult {
  task_run_id: string;
  events: TaskRunEvent[];
  next_seq: number;
  has_more: boolean;
}

export interface SafeTaskRunEventsResult {
  task_run_id: string;
  events: SafeTranscriptEventData[];
  next_seq: number;
  has_more: boolean;
}

// ── SafeTranscriptEventData — strict Foreman response-time projection ──
// Only bounded, daemon-authored message/input/output summaries plus their
// identifying metadata are allowed. Raw text/content/input/output/result/
// output_tail, nested objects/arrays, unapproved keys, and malformed numbers
// remain rejected. Unknown event types keep only type and timestamp.

interface SafeEventBase {
  timestamp: string;
}

export interface SafeMessageEvent extends SafeEventBase {
  type: 'message';
  message_summary: string;
  role?: string;
}

export interface SafeToolCallEvent extends SafeEventBase {
  type: 'tool_call';
  tool_name: string;
  call_id?: string;
  input_summary: string;
}

export interface SafeToolResultEvent extends SafeEventBase {
  type: 'tool_result';
  call_id?: string;
  status: string;
  is_error: boolean;
  output_summary: string;
}

export interface SafeUsageEvent extends SafeEventBase {
  type: 'turn_usage';
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
}

export interface SafeLifecycleEvent extends SafeEventBase {
  type: 'lifecycle';
  event: string;
  status?: string;
}

export interface SafeUnknownEvent extends SafeEventBase {
  type: 'unknown';
  event_type: string;
  data: Record<string, never>;
}

export type SafeTranscriptEventData =
  | SafeMessageEvent
  | SafeToolCallEvent
  | SafeToolResultEvent
  | SafeUsageEvent
  | SafeLifecycleEvent
  | SafeUnknownEvent;

const SAFE_LIFECYCLE_EVENT_TYPES = new Set([
  'dispatch',
  'workflow.started', 'workflow.completed', 'workflow.failed',
  'task.started', 'task.done', 'task.completed', 'task.failed', 'task.cancelled',
  'agent.started', 'agent.completed', 'agent.failed',
  'execution.started', 'execution.completed',
  'plan_generated', 'plan_accepted', 'plan_rejected',
]);
const SAFE_LIFECYCLE_STATUSES = new Set([
  'created', 'queued', 'running', 'done', 'completed', 'failed', 'cancelled',
  'interrupted', 'paused', 'waiting', 'blocked',
]);

function safeTranscriptIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined;
  return /^[a-z0-9_.:/-]+$/iu.test(value) ? value : undefined;
}

function safeTranscriptSummary(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  let text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim();
  if (!text) return fallback;

  // Defence in depth: the daemon performs the authoritative projection, but
  // renderer DTO normalization still refuses common credential forms.
  text = text
    .replace(/(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/giu, '$1[REDACTED]')
    .replace(
      /(\b(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|authorization|auth)\b\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/giu,
      '$1[REDACTED]',
    );

  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Normalize a raw TaskRunEvent through the strict safe-transcript
 * allowlist.  Unknown event types retain type and timestamp only;
 * their data becomes {}.
 */
export function normalizeSafeEvent(raw: TaskRunEvent): SafeTranscriptEventData {
  const data: Record<string, unknown> = raw.data ?? {};
  switch (raw.type) {
    case 'message': {
      return {
        type: 'message',
        timestamp: raw.timestamp,
        message_summary: safeTranscriptSummary(data.message_summary, 1_200, 'Message recorded'),
        role: safeTranscriptIdentifier(data.role, 24),
      };
    }
    case 'tool_call': {
      return {
        type: 'tool_call',
        timestamp: raw.timestamp,
        tool_name: safeTranscriptIdentifier(data.tool_name, 80) ?? '',
        call_id: safeTranscriptIdentifier(data.call_id, 120),
        input_summary: safeTranscriptSummary(data.input_summary, 500, 'No tool input recorded'),
      };
    }
    case 'tool_result': {
      return {
        type: 'tool_result',
        timestamp: raw.timestamp,
        call_id: safeTranscriptIdentifier(data.call_id, 120),
        status: safeTranscriptIdentifier(data.status, 40) ?? '',
        is_error: typeof raw.is_error === 'boolean'
          ? raw.is_error
          : (typeof data.is_error === 'boolean'
              ? data.is_error
              : data.status === 'error' || data.status === 'failed'),
        output_summary: safeTranscriptSummary(data.output_summary, 500, 'No tool output recorded'),
      };
    }
    case 'turn_usage': {
      const clampNonneg = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
      return {
        type: 'turn_usage',
        timestamp: raw.timestamp,
        input_tokens: clampNonneg(data.input_tokens),
        output_tokens: clampNonneg(data.output_tokens),
        total_tokens: clampNonneg(data.total_tokens),
        duration_ms: clampNonneg(data.duration_ms),
      };
    }
    case 'lifecycle': {
      const event = typeof data.event === 'string' && SAFE_LIFECYCLE_EVENT_TYPES.has(data.event)
        ? data.event
        : 'transition';
      const status = typeof data.status === 'string' && SAFE_LIFECYCLE_STATUSES.has(data.status)
        ? data.status
        : undefined;
      return {
        type: 'lifecycle',
        timestamp: raw.timestamp,
        event,
        status,
      };
    }
    default: {
      if (SAFE_LIFECYCLE_EVENT_TYPES.has(raw.type)) {
        return {
          type: 'lifecycle',
          timestamp: raw.timestamp,
          event: raw.type,
          status: typeof data.status === 'string' && SAFE_LIFECYCLE_STATUSES.has(data.status)
            ? data.status
            : undefined,
        };
      }
      return {
        type: 'unknown',
        event_type: raw.type,
        timestamp: raw.timestamp,
        data: {},
      };
    }
  }
}

// ── Strict normalizers ───────────────────────────────────────────────

function assertRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`TaskGraph: expected object at ${path}, got ${typeof v}`);
  }
  return v as Record<string, unknown>;
}

function assertString(v: unknown, path: string): string {
  if (typeof v !== 'string') {
    throw new Error(`TaskGraph: expected string at ${path}, got ${typeof v}`);
  }
  return v;
}

function assertNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`TaskGraph: expected finite number at ${path}, got ${typeof v}`);
  }
  return v;
}

// Slip identity sequence (structure_revision / latest_seq): a nonnegative
// safe integer that participates in the atomic revision/sequence merge.
// Negative, fractional, NaN/Infinity, and values beyond
// Number.MAX_SAFE_INTEGER are rejected outright — never coerced or clamped —
// so a corrupted identity can never silently skew the merge.
function assertSlipSeq(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`TaskGraph: expected nonnegative safe integer at ${path}, got ${typeof v}`);
  }
  return v;
}

function assertOptionalString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return assertString(v, path);
}

function assertOptionalBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`TaskGraph: expected boolean at ${path}, got ${typeof v}`);
  }
  return v;
}

// ── Server display string policy (d-1/d-2) ───────────────────────────
// One central fail-closed primitive for every server-authored display
// string. The policy is a closed typed object: maxCodeUnits, singleLine,
// and a whitespace enum ('trim'|'collapse'); no callbacks and no extra
// keys. The order is mandatory:
//   1. type check;
//   2. validate the ORIGINAL UTF-16 code units before any transformation
//      (reject all C0 U+0000..U+001F, DEL U+007F, C1 U+0080..U+009F,
//      unpaired high/low surrogates, and U+2028/U+2029 when singleLine);
//   3. only then trim/collapse whitespace;
//   4. reject empty results;
//   5. enforce the post-transform UTF-16 code-unit cap.
// Malformed input is rejected outright, never sanitized into valid text.
export interface ServerDisplayPolicy {
  maxCodeUnits: number;
  singleLine: boolean;
  whitespace: 'trim' | 'collapse';
}

// Fail-closed Unicode predicate over ORIGINAL code units: no C0
// (U+0000..U+001F), DEL (U+007F), or C1 (U+0080..U+009F) controls; every
// high surrogate (U+D800..U+DBFF) must be immediately paired with a low
// surrogate (U+DC00..U+DFFF) and no low surrogate may appear unpaired;
// when singleLine, also no U+2028/U+2029. Valid Chinese and paired
// supplementary-plane characters pass through unchanged.
function isValidDisplayString(s: string, singleLine: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit <= 0x1f || unit === 0x7f || (unit >= 0x80 && unit <= 0x9f)) return false;
    if (singleLine && (unit === 0x2028 || unit === 0x2029)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // High surrogate: the immediately following code unit must pair it.
      // A trailing high surrogate is a lone unpaired surrogate.
      if (i + 1 >= s.length) return false;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // Unpaired low surrogate.
      return false;
    }
  }
  return true;
}

export function normalizeServerDisplayString(raw: unknown, policy: ServerDisplayPolicy): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!isValidDisplayString(raw, policy.singleLine)) return undefined;
  const transformed = policy.whitespace === 'collapse'
    ? raw.replace(/\s+/g, ' ').trim()
    : raw.trim();
  if (transformed.length === 0) return undefined;
  if (transformed.length > policy.maxCodeUnits) return undefined;
  return transformed;
}

// Optional display title: explicit policy — 120 code units, single-line,
// trim, via the central primitive. Malformed or legacy values are silently
// omitted, never sanitized — title is noncritical display metadata and must
// never break Pet polling.
function normalizeOptionalTitle(v: unknown): string | undefined {
  return normalizeServerDisplayString(v, { maxCodeUnits: 120, singleLine: true, whitespace: 'trim' });
}

const VALID_GRAPH_STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'done', 'cancelled']);
const VALID_NODE_STATES: ReadonlySet<string> = new Set([
  'planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled',
]);
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'taskgraph.created', 'taskgraph.started', 'taskgraph.paused', 'taskgraph.resumed',
  'taskgraph.done', 'taskgraph.cancelled', 'taskgraph.node.started',
  'taskgraph.node.completed', 'taskgraph.node.failed', 'taskgraph.node.interrupted',
  'taskgraph.node.cancelled', 'taskgraph.checkpoint.entered', 'taskgraph.checkpoint.resumed',
  'taskgraph.patch.applied', 'taskgraph.signal.received', 'taskgraph.signal.ignored',
]);

function assertTaskGraphState(v: unknown, path: string): TaskGraphState {
  const s = assertString(v, path);
  if (!VALID_GRAPH_STATES.has(s)) {
    throw new Error(`TaskGraph: invalid state "${s}" at ${path}`);
  }
  return s as TaskGraphState;
}

function assertTaskGraphNodeState(v: unknown, path: string): TaskGraphNodeState {
  const s = assertString(v, path);
  if (!VALID_NODE_STATES.has(s)) {
    throw new Error(`TaskGraph: invalid node state "${s}" at ${path}`);
  }
  return s as TaskGraphNodeState;
}

function assertTaskGraphEventType(v: unknown, path: string): TaskGraphEventType {
  const s = assertString(v, path);
  if (!VALID_EVENT_TYPES.has(s)) {
    throw new Error(`TaskGraph: invalid event type "${s}" at ${path}`);
  }
  return s as TaskGraphEventType;
}

export function normalizeTaskGraphListRun(v: unknown, path: string = 'run'): TaskGraphListRun {
  const r = assertRecord(v, path);
  return {
    taskgraph_id: assertString(r.taskgraph_id, `${path}.taskgraph_id`),
    state: assertTaskGraphState(r.state, `${path}.state`),
    cancel_requested: assertOptionalBoolean(r.cancel_requested, `${path}.cancel_requested`),
    structure_revision: assertNumber(r.structure_revision, `${path}.structure_revision`),
    project: assertOptionalString(r.project, `${path}.project`),
    created_at: assertString(r.created_at, `${path}.created_at`),
    updated_at: assertString(r.updated_at, `${path}.updated_at`),
    ended_at: assertOptionalString(r.ended_at, `${path}.ended_at`),
    title: normalizeOptionalTitle(r.title),
  };
}

export function normalizeTaskGraphListResult(v: unknown): TaskGraphListResult {
  const r = assertRecord(v, 'taskgraph.list');
  const runs = r.runs;
  if (!Array.isArray(runs)) {
    throw new Error('TaskGraph: taskgraph.list result.runs must be an array');
  }
  return {
    runs: runs.map((item, i) => normalizeTaskGraphListRun(item, `runs[${i}]`)),
  };
}

export function normalizeTaskGraphAction(v: unknown, path: string): TaskGraphNodeAction {
  const r = assertRecord(v, path);
  return {
    type: assertString(r.type, `${path}.type`),
    params: (r.params !== undefined && r.params !== null)
      ? (assertRecord(r.params, `${path}.params`) as Record<string, unknown>)
      : undefined,
  };
}

export function normalizeTaskGraphNode(v: unknown, path: string): TaskGraphNode {
  const r = assertRecord(v, path);
  const deps = r.deps;
  if (!Array.isArray(deps)) {
    throw new Error(`TaskGraph: expected array at ${path}.deps`);
  }
  const inputArr = r.input;
  let input: TaskGraphNodeInputSource[] | undefined;
  if (inputArr !== undefined && inputArr !== null) {
    if (!Array.isArray(inputArr)) {
      throw new Error(`TaskGraph: expected array at ${path}.input`);
    }
    input = inputArr.map((item, i) => {
      const iv = assertRecord(item, `${path}.input[${i}]`);
      return {
        name: assertString(iv.name, `${path}.input[${i}].name`),
        source: assertString(iv.source, `${path}.input[${i}].source`),
      };
    });
  }
  return {
    id: assertString(r.id, `${path}.id`),
    name: assertOptionalString(r.name, `${path}.name`),
    action: normalizeTaskGraphAction(r.action, `${path}.action`),
    deps: deps.map((d, i) => assertString(d, `${path}.deps[${i}]`)),
    input,
    input_schema: r.input_schema,
    output_schema: r.output_schema,
  };
}

export function normalizeTaskGraphInspectResult(v: unknown): TaskGraphInspectResult {
  const r = assertRecord(v, 'taskgraph.inspect');
  const graph = assertRecord(r.graph, 'taskgraph.inspect.graph');
  const nodes = graph.nodes;
  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
    throw new Error('TaskGraph: taskgraph.inspect.graph.nodes must be a record');
  }
  const normalizedNodes: Record<string, TaskGraphNode> = {};
  for (const [key, node] of Object.entries(nodes)) {
    normalizedNodes[key] = normalizeTaskGraphNode(node, `graph.nodes["${key}"]`);
  }
  return {
    graph: {
      id: assertString(graph.id, 'graph.id'),
      revision: assertNumber(graph.revision, 'graph.revision'),
      nodes: normalizedNodes,
    },
  };
}

export function normalizeTaskGraphStatusResult(v: unknown): TaskGraphStatusResult {
  const r = assertRecord(v, 'taskgraph.status');
  const nc = assertRecord(r.node_counts, 'node_counts');
  const active = assertRecord(r.active, 'active');
  if (!Array.isArray(active.running)) throw new Error('TaskGraph: expected array at active.running');
  if (!Array.isArray(active.waiting)) throw new Error('TaskGraph: expected array at active.waiting');
  return {
    taskgraph_id: assertString(r.taskgraph_id, 'taskgraph_id'),
    state: assertTaskGraphState(r.state, 'state'),
    cancel_requested: assertOptionalBoolean(r.cancel_requested, 'cancel_requested'),
    structure_revision: assertNumber(r.structure_revision, 'structure_revision'),
    latest_seq: assertNumber(r.latest_seq, 'latest_seq'),
    node_counts: {
      planned: assertNumber(nc.planned, 'node_counts.planned'),
      running: assertNumber(nc.running, 'node_counts.running'),
      waiting: assertNumber(nc.waiting, 'node_counts.waiting'),
      done: assertNumber(nc.done, 'node_counts.done'),
      failed: assertNumber(nc.failed, 'node_counts.failed'),
      interrupted: assertNumber(nc.interrupted, 'node_counts.interrupted'),
      cancelled: assertNumber(nc.cancelled, 'node_counts.cancelled'),
    },
    active: {
      running: active.running.map((item, i) => assertString(item, `active.running[${i}]`)),
      waiting: active.waiting.map((item, i) => assertString(item, `active.waiting[${i}]`)),
    },
    title: normalizeOptionalTitle(r.title),
  };
}

export function normalizeTaskGraphNodeInspectRun(v: unknown, path: string): TaskGraphNodeInspectRun {
  const r = assertRecord(v, path);
  return {
    state: assertTaskGraphNodeState(r.state, `${path}.state`),
    task_run_id: assertOptionalString(r.task_run_id, `${path}.task_run_id`),
  };
}

export function normalizeTaskGraphNodeInspectResult(v: unknown): TaskGraphNodeInspectResult {
  const r = assertRecord(v, 'taskgraph.node.inspect');
  return {
    structure_revision: assertNumber(r.structure_revision, 'structure_revision'),
    node: normalizeTaskGraphNode(r.node, 'node'),
    run: normalizeTaskGraphNodeInspectRun(r.run, 'run'),
  };
}

export function normalizeTaskGraphEventsResult(v: unknown): TaskGraphEventsResult {
  const r = assertRecord(v, 'taskgraph.events');
  const events = r.events;
  if (!Array.isArray(events)) {
    throw new Error('TaskGraph: taskgraph.events.events must be an array');
  }
  return {
    events: events.map((item, i) => {
      const ev = assertRecord(item, `events[${i}]`);
      const refs = ev.refs;
      let refsNormalized: { node_id?: string; task_run_id?: string } | undefined;
      if (refs !== undefined && refs !== null) {
        const refRec = assertRecord(refs, `events[${i}].refs`);
        refsNormalized = {
          node_id: assertOptionalString(refRec.node_id, `events[${i}].refs.node_id`),
          task_run_id: assertOptionalString(refRec.task_run_id, `events[${i}].refs.task_run_id`),
        };
      }
      return {
        taskgraph_id: assertString(ev.taskgraph_id, `events[${i}].taskgraph_id`),
        seq: assertNumber(ev.seq, `events[${i}].seq`),
        type: assertTaskGraphEventType(ev.type, `events[${i}].type`),
        occurred_at: assertString(ev.occurred_at, `events[${i}].occurred_at`),
        structure_revision: assertNumber(ev.structure_revision, `events[${i}].structure_revision`),
        refs: refsNormalized,
      };
    }),
    next_seq: r.next_seq === undefined ? 0 : assertNumber(r.next_seq, 'next_seq'),
    latest_seq: r.latest_seq === undefined ? 0 : assertNumber(r.latest_seq, 'latest_seq'),
    has_more: r.has_more === true,
  };
}

// ── Graph Slip display field bounds (foreman.taskgraph.slip.v1) ──────
const MAX_TASK_CATEGORY_LENGTH = 32; // task slug
const MAX_DISPLAY_LABEL_LENGTH = 24; // Chinese-capable single-line label
const MAX_SLIP_TEXT_LENGTH = 280;    // description / summary
const MAX_SLIP_IDENT_LENGTH = 128;   // agent_runtime / profile
const MAX_TPS = 1_000_000;

// All Graph Slip display strings flow through the central primitive with an
// explicit policy (validate original code units, then transform, then cap).
// Valid Chinese and paired supplementary-plane characters pass unchanged.

// Single-line, trimmed, non-empty string up to maxLength code units.
// Chinese-capable: no ASCII-only restriction is applied.
function normalizeSlipLabel(v: unknown, maxLength: number): string | undefined {
  return normalizeServerDisplayString(v, { maxCodeUnits: maxLength, singleLine: true, whitespace: 'trim' });
}

// ASCII-ish slug (task category): keeps the exact slug grammar on top of the
// central single-line trim policy.
function normalizeSlipSlug(v: unknown, maxLength: number): string | undefined {
  const label = normalizeServerDisplayString(v, { maxCodeUnits: maxLength, singleLine: true, whitespace: 'trim' });
  if (label === undefined) return undefined;
  // Canonical task category id: lowercase letter, then lowercase letters /
  // digits / hyphens, 1..32 code units. No i/u broadening: uppercase and
  // other punctuation are rejected.
  return /^[a-z][a-z0-9-]{0,31}$/.test(label) ? label : undefined;
}

// Single-line, trimmed, non-empty string up to maxLength code units.
function normalizeSlipText(v: unknown, maxLength: number): string | undefined {
  return normalizeServerDisplayString(v, { maxCodeUnits: maxLength, singleLine: true, whitespace: 'trim' });
}

// Safe nonnegative integer (tool call count). Not a bare >= 0 number: the
// value must be a finite integer that fits the safe-integer range.
function normalizeSlipNonnegInt(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return undefined;
  return v;
}

// Finite TPS within 0..MAX_TPS inclusive.
function normalizeSlipTps(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v < 0 || v > MAX_TPS) return undefined;
  return v;
}

// ── Pet-only task-tip heading policy (task_title) ────────────────────
// The heading candidate is the cached same-revision static node.name from
// taskgraph.inspect. The policy is single-line/trim at most 48 UTF-16 code
// units and the result must contain at least one CJK ideograph, so an
// English-only internal name (e.g. "Analyze") can never become a heading.
// Invalid candidates are omitted fail-closed and the renderer falls back to
// the activity display_label then exactly '任务'.
const MAX_TASK_TITLE_LENGTH = 48;

// At least one CJK ideograph: Han unified ideographs, extension A,
// compatibility ideographs and their compatibility supplements.
const HAS_CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{2f800}-\u{2fa1f}]/u;

export function normalizeTaskTitle(v: unknown): string | undefined {
  const label = normalizeServerDisplayString(v, {
    maxCodeUnits: MAX_TASK_TITLE_LENGTH,
    singleLine: true,
    whitespace: 'trim',
  });
  if (label === undefined) return undefined;
  return HAS_CJK_IDEOGRAPH.test(label) ? label : undefined;
}

export function normalizeTaskGraphSlipNode(v: unknown, path: string): TaskGraphSlipNode {
  const r = assertRecord(v, path);
  return {
    node_id: assertString(r.node_id, `${path}.node_id`),
    state: assertTaskGraphNodeState(r.state, `${path}.state`),
    task_category: normalizeSlipSlug(r.task_category, MAX_TASK_CATEGORY_LENGTH),
    display_label: normalizeSlipLabel(r.display_label, MAX_DISPLAY_LABEL_LENGTH),
    description: normalizeSlipText(r.description, MAX_SLIP_TEXT_LENGTH),
    agent_runtime: normalizeSlipText(r.agent_runtime, MAX_SLIP_IDENT_LENGTH),
    profile: normalizeSlipText(r.profile, MAX_SLIP_IDENT_LENGTH),
    tool_call_count: normalizeSlipNonnegInt(r.tool_call_count),
    tps: normalizeSlipTps(r.tps),
    summary: normalizeSlipText(r.summary, MAX_SLIP_TEXT_LENGTH),
  };
}

export function normalizeTaskGraphSlipResult(v: unknown, expectedNodeCount: number): TaskGraphSlipResult {
  const r = assertRecord(v, 'taskgraph.slip');
  const nodes = r.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('TaskGraph: taskgraph.slip nodes must be an array');
  }
  // Pre-normalization cardinality bound: the response must carry exactly the
  // expected number of nodes before any untrusted element is mapped, indexed,
  // or normalized. Oversized and undersized arrays fail closed in O(1), so a
  // hostile or truncated Slip can never trigger per-element traversal work.
  if (typeof expectedNodeCount !== 'number' || !Number.isSafeInteger(expectedNodeCount) || expectedNodeCount < 0) {
    throw new Error(
      `TaskGraph: taskgraph.slip expected node cardinality must be a nonnegative safe integer, got ${typeof expectedNodeCount}`
    );
  }
  if (nodes.length !== expectedNodeCount) {
    throw new Error(
      `TaskGraph: taskgraph.slip node count mismatch: expected ${expectedNodeCount}, got ${nodes.length}`
    );
  }
  return {
    schema_version: assertString(r.schema_version, 'taskgraph.slip.schema_version'),
    taskgraph_id: assertString(r.taskgraph_id, 'taskgraph.slip.taskgraph_id'),
    graph_state: assertTaskGraphState(r.graph_state, 'taskgraph.slip.graph_state'),
    structure_revision: assertSlipSeq(r.structure_revision, 'taskgraph.slip.structure_revision'),
    latest_seq: assertSlipSeq(r.latest_seq, 'taskgraph.slip.latest_seq'),
    nodes: nodes.map((item, i) => normalizeTaskGraphSlipNode(item, `taskgraph.slip.nodes[${i}]`)),
  };
}

/**
 * Project a slip node's validated display facts onto the main→renderer DTO.
 * Only the allowlisted bounded fields cross; unrecognized wire keys and raw
 * params/schema/input/output/error/prompt/transcript/event data are never
 * copied, and malformed/out-of-bounds values are omitted. A task missing its
 * category leaves display_label absent so the renderer falls back to its
 * static default display label.
 */
export function projectTaskSlipDisplayFields(node: TaskGraphSlipNode): Partial<GraphSlipNodeDto> {
  const out: Partial<GraphSlipNodeDto> = {};
  const taskCategory = normalizeSlipSlug(node.task_category, MAX_TASK_CATEGORY_LENGTH);
  if (taskCategory !== undefined) out.task_category = taskCategory;
  if (taskCategory !== undefined) {
    const displayLabel = normalizeSlipLabel(node.display_label, MAX_DISPLAY_LABEL_LENGTH);
    if (displayLabel !== undefined) out.display_label = displayLabel;
  }
  const description = normalizeSlipText(node.description, MAX_SLIP_TEXT_LENGTH);
  if (description !== undefined) out.description = description;
  const agentRuntime = normalizeSlipText(node.agent_runtime, MAX_SLIP_IDENT_LENGTH);
  if (agentRuntime !== undefined) out.agent_runtime = agentRuntime;
  const profile = normalizeSlipText(node.profile, MAX_SLIP_IDENT_LENGTH);
  if (profile !== undefined) out.profile = profile;
  const toolCallCount = normalizeSlipNonnegInt(node.tool_call_count);
  if (toolCallCount !== undefined) out.tool_call_count = toolCallCount;
  const tps = normalizeSlipTps(node.tps);
  if (tps !== undefined) out.tps = tps;
  const summary = normalizeSlipText(node.summary, MAX_SLIP_TEXT_LENGTH);
  if (summary !== undefined) out.summary = summary;
  return out;
}

export function normalizeTaskRunEvent(v: unknown, path: string): TaskRunEvent {
  const r = assertRecord(v, path);
  return {
    seq: assertNumber(r.seq, `${path}.seq`),
    type: assertString(r.type, `${path}.type`),
    timestamp: assertString(r.timestamp, `${path}.timestamp`),
    data: (r.data !== undefined && r.data !== null)
      ? (assertRecord(r.data, `${path}.data`) as Record<string, unknown>)
      : {},
    status: assertOptionalString(r.status, `${path}.status`),
    exit_code: (r.exit_code !== undefined && r.exit_code !== null)
      ? assertNumber(r.exit_code, `${path}.exit_code`)
      : undefined,
    is_error: (r.is_error !== undefined && r.is_error !== null)
      ? (typeof r.is_error === 'boolean' ? r.is_error : undefined)
      : undefined,
  };
}

export function normalizeTaskRunEventsResult(v: unknown): TaskRunEventsResult {
  const r = assertRecord(v, 'task.run.events');
  const events = r.events;
  if (!Array.isArray(events)) {
    throw new Error('TaskGraph: task.run.events.events must be an array');
  }
  return {
    task_run_id: assertString(r.task_run_id, 'task_run_id'),
    events: events.map((item, i) => normalizeTaskRunEvent(item, `events[${i}]`)),
    next_seq: assertNumber(r.next_seq, 'next_seq'),
    has_more: typeof r.has_more === 'boolean' ? r.has_more : false,
  };
}

// ── Pure utilities ───────────────────────────────────────────────────

export function nodeRuntimesFromEvents(events: TaskGraphEvent[]): Record<string, number> {
  const runtimes: Record<string, number> = {};
  const starts: Record<string, number> = {};
  for (const ev of events) {
    const nodeId = ev.refs?.node_id;
    if (!nodeId) continue;
    const ts = new Date(ev.occurred_at).getTime();
    if (isNaN(ts)) continue;
    if (ev.type === 'taskgraph.node.started') {
      starts[nodeId] = ts;
    } else if (
      ev.type === 'taskgraph.node.completed'
      || ev.type === 'taskgraph.node.failed'
      || ev.type === 'taskgraph.node.interrupted'
      || ev.type === 'taskgraph.node.cancelled'
    ) {
      const start = starts[nodeId];
      if (start !== undefined) {
        runtimes[nodeId] = ts - start;
      }
    }
  }
  return runtimes;
}

export function edgeDataLabel(data?: Record<string, unknown>): string | undefined {
  if (data?.label && typeof data.label === 'string') return data.label;
  if (data?.name && typeof data.name === 'string') return data.name;
  if (data?.summary && typeof data.summary === 'string') return data.summary;
  if (data?.description && typeof data.description === 'string') return data.description;
  return undefined;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return '<1s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

// ── Semantic automation attribute helpers (no DOM dependency) ────────

export function nodeSemanticAttributes(node: TaskGraphNode, inspection?: TaskGraphNodeInspectResult): Record<string, string> {
  const state = inspection?.run.state ?? 'created';
  const isTaskNode = !!inspection?.run.task_run_id;
  return {
    'data-node-id': node.id,
    'data-action-type': node.action.type,
    'data-node-state': state,
    'tabindex': isTaskNode ? '0' : '-1',
    'role': isTaskNode ? 'button' : 'graphics-symbol',
    'aria-label': `${node.name ?? node.action.type} (${state})`,
  };
}

export function edgeSemanticAttributes(sourceId: string, targetId: string, label?: string): Record<string, string> {
  return {
    'data-edge-id': `${sourceId}->${targetId}`,
    'data-source-id': sourceId,
    'data-target-id': targetId,
    'data-edge-label': label ?? '',
    'tabindex': '0',
    'role': 'graphics-symbol',
    'aria-label': `Edge: ${sourceId} → ${targetId}`,
  };
}
