// ─── Transactional activity snapshot projection ──────────────────────────────
// The single source of truth for "what is currently active" consumed by the
// Pet desktop: direct and taskgraph-owned task runs, non-terminal graphs plus
// tracked terminal graphs, per-node state/static slip fields, and bounded
// task-run telemetry. Everything is read inside one better-sqlite3 read-only
// transaction across tasks / taskgraph_run / taskgraph_node_state /
// taskgraph_journal (plus task_run_telemetry and executions for display
// metadata). The events table is never scanned, no per-task or per-graph
// N+1 status request is issued, and the response is explicitly bounded:
// exceeding any limit fails the whole call (fail-closed) instead of
// returning a truncated partial snapshot.

import { getDb } from '../../db/connection.mts'
import type { ForemanDatabase } from '../../db/types.mts'
import type {
  GraphStateType,
  NodeRunStateType,
  OnNodeFailurePolicy,
  TaskNodeSlip,
} from '../taskgraph/index.mts'

export const ACTIVITY_SNAPSHOT_SCHEMA_VERSION = 'foreman.activity.snapshot.v1'

/**
 * Explicit response bounds. Any violation fails the entire snapshot; the
 * caller never receives a partial state.
 */
export const ACTIVITY_LIMITS = {
  /** Deduplicated tracked terminal graph ids the client may pass. */
  maxTrackedTaskgraphIds: 128,
  /** Upper bound on queued+running task runs surfaced in one snapshot. */
  maxTasks: 1024,
  /** Upper bound on graphs (non-terminal plus tracked terminal) per snapshot. */
  maxTaskgraphs: 256,
  /** Upper bound on node rows per graph. */
  maxNodesPerGraph: 2048,
  /** Global upper bound on node rows across all graphs in one snapshot. */
  maxTotalNodes: 8192,
} as const

const MAX_PROFILE_LENGTH = 128
const MAX_RUNTIME_LENGTH = 128
const MAX_SUMMARY_LENGTH = 280
const MAX_TPS = 1_000_000

export class ActivitySnapshotError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ActivitySnapshotError'
    this.code = code
  }
}

export type ActivityTaskRunStatus = 'queued' | 'running'
export type ActivityTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export type ActivityTerminalReason = 'success' | 'node_failed' | 'cancelled'

export interface ActivitySnapshotParams {
  trackedTaskgraphIds?: string[]
}

export interface ActivitySnapshotTask {
  task_run_id: string
  status: ActivityTaskRunStatus
  task_id?: string
  task_label?: string
  project?: string
  worktree?: boolean
  requested_agent_runtime?: string
  resolved_profile?: string
  created_at: string
  updated_at: string
  taskgraph_id?: string
  node_id?: string
}

export interface ActivitySnapshotNode {
  node_id: string
  state: NodeRunStateType
  task_run_id?: string
  task_status?: ActivityTaskStatus
  /** Authoritative resolved task definition name (e.g. 'commit'); from the slip, omitted for legacy nodes. */
  task_id?: string
  task_category?: { id: string; display_label: string }
  display_label?: string
  description?: string
  requested_agent_runtime?: string
  resolved_profile?: string
  tool_call_count?: number
  tps?: number
  summary?: string
  /**
   * Node wall-clock duration in integer milliseconds. Non-terminal nodes are
   * sampled as the read time minus task dispatch start; terminal nodes are
   * frozen at task completion (ended_at minus created_at). Omitted when the
   * required timing data is absent or invalid.
   */
  runtime_ms?: number
}

export interface ActivitySnapshotGraph {
  taskgraph_id: string
  state: GraphStateType
  title?: string
  project?: string
  on_node_failure: OnNodeFailurePolicy
  cancel_requested: boolean
  structure_revision: number
  latest_seq: number
  terminal_reason?: ActivityTerminalReason
  node_counts: Record<NodeRunStateType, number>
  active: { running: string[]; waiting: string[] }
  nodes: ActivitySnapshotNode[]
}

export interface ActivitySnapshotV1 {
  schema_version: typeof ACTIVITY_SNAPSHOT_SCHEMA_VERSION
  sampled_at: string
  tasks: ActivitySnapshotTask[]
  taskgraphs: ActivitySnapshotGraph[]
}

interface TaskRow {
  task_run_id: string
  template: string | null
  project: string | null
  worktree: string | null
  status: ActivityTaskRunStatus
  created_at: string
  updated_at: string
  requested_agent_runtime: string | null
  resolved_profile: string | null
}

interface GraphRow {
  id: string
  state: GraphStateType
  cancel_requested: number
  on_node_failure: OnNodeFailurePolicy
  failure_cause: string | null
  structure_revision: number
  project: string | null
  title: string | null
  created_at: string
  updated_at: string
}

interface NodeRow {
  taskgraph_id: string
  node_id: string
  state: NodeRunStateType
  task_run_id: string | null
  slip_json: string | null
  task_status: ActivityTaskStatus | null
  task_created_at: string | null
  task_ended_at: string | null
  tool_call_count: number | null
  usage_event_count: number | null
  output_tokens: number | null
  agent_turn_ms: number | null
  tps_complete: number | null
  task_summary: string | null
  requested_agent_runtime: string | null
  resolved_profile: string | null
}

interface LatestSeqRow {
  taskgraph_id: string
  latest_seq: number
}

const TASK_QUERY = `
  SELECT
    t.id AS task_run_id,
    t.template,
    t.project,
    t.worktree,
    t.status,
    t.created_at,
    t.updated_at,
    e.requested_agent_runtime,
    e.resolved_profile
  FROM tasks t
  LEFT JOIN executions e ON e.id = t.execution_id
  WHERE t.status IN ('queued', 'running')
  ORDER BY t.created_at ASC, t.id ASC
`

const GRAPH_QUERY_BASE = `
  SELECT
    id, state, cancel_requested, on_node_failure, failure_cause,
    structure_revision, project, title, created_at, updated_at
  FROM taskgraph_run
`

/**
 * Build the complete activity snapshot in one read-only transaction. All
 * facts — active task runs, selected graphs, node states/slips, latest
 * journal sequences, and task-run telemetry — come from a single committed
 * database snapshot and can never mix different states.
 */
export function buildActivitySnapshot(params: ActivitySnapshotParams = {}): ActivitySnapshotV1 {
  const db = getDb()
  return db.transaction((): ActivitySnapshotV1 => {
    const tracked = normalizeTrackedIds(params.trackedTaskgraphIds)
    const sampledAt = new Date().toISOString()

    const taskRows = db.prepare<[], TaskRow>(TASK_QUERY).all()
    if (taskRows.length > ACTIVITY_LIMITS.maxTasks) {
      throw limitError(`activity snapshot exceeded task limit of ${ACTIVITY_LIMITS.maxTasks}`)
    }

    const graphRows = readGraphRows(db, tracked)
    if (graphRows.length > ACTIVITY_LIMITS.maxTaskgraphs) {
      throw limitError(`activity snapshot exceeded taskgraph limit of ${ACTIVITY_LIMITS.maxTaskgraphs}`)
    }

    const taskgraphs: ActivitySnapshotGraph[] = []
    const taskAssociation = new Map<string, { taskgraph_id: string; node_id: string }>()
    if (graphRows.length > 0) {
      const graphIds = graphRows.map((row) => row.id)
      const nodeRows = readNodeRows(db, graphIds)
      const latestSeqByGraph = readLatestSequences(db, graphIds)

      let totalNodes = 0
      const nodesByGraph = new Map<string, NodeRow[]>()
      for (const row of nodeRows) {
        totalNodes += 1
        if (totalNodes > ACTIVITY_LIMITS.maxTotalNodes) {
          throw limitError(`activity snapshot exceeded total node limit of ${ACTIVITY_LIMITS.maxTotalNodes}`)
        }
        let bucket = nodesByGraph.get(row.taskgraph_id)
        if (!bucket) {
          bucket = []
          nodesByGraph.set(row.taskgraph_id, bucket)
        }
        bucket.push(row)
        if (row.task_run_id && !taskAssociation.has(row.task_run_id)) {
          taskAssociation.set(row.task_run_id, { taskgraph_id: row.taskgraph_id, node_id: row.node_id })
        }
      }

      for (const row of graphRows) {
        taskgraphs.push(
          graphFromRow(row, nodesByGraph.get(row.id) ?? [], latestSeqByGraph.get(row.id) ?? 0, sampledAt),
        )
      }
    }

    const tasks = taskRows.map((row) => taskFromRow(row, taskAssociation.get(row.task_run_id)))
    return {
      schema_version: ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
      sampled_at: sampledAt,
      tasks,
      taskgraphs,
    }
  })()
}

function normalizeTrackedIds(value: string[] | undefined): string[] {
  if (value === undefined || value.length === 0) return []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ActivitySnapshotError(
        'INVALID_TRACKED_IDS',
        'tracked_taskgraph_ids must contain only non-empty strings',
      )
    }
    seen.add(id)
  }
  if (seen.size > ACTIVITY_LIMITS.maxTrackedTaskgraphIds) {
    throw limitError(
      `tracked_taskgraph_ids must contain at most ${ACTIVITY_LIMITS.maxTrackedTaskgraphIds} unique ids`,
    )
  }
  return [...seen]
}

function readGraphRows(db: ForemanDatabase, tracked: readonly string[]): GraphRow[] {
  if (tracked.length === 0) {
    return db.prepare<[], GraphRow>(
      `${GRAPH_QUERY_BASE} WHERE state IN ('created','running','paused') ORDER BY updated_at ASC, id ASC`,
    ).all()
  }
  const placeholders = tracked.map(() => '?').join(', ')
  return db.prepare<string[], GraphRow>(
    `${GRAPH_QUERY_BASE}
     WHERE state IN ('created','running','paused')
        OR (id IN (${placeholders}) AND state IN ('done','cancelled'))
     ORDER BY updated_at ASC, id ASC`,
  ).all(...tracked)
}

function readNodeRows(db: ForemanDatabase, graphIds: readonly string[]): NodeRow[] {
  const placeholders = graphIds.map(() => '?').join(', ')
  return db.prepare<string[], NodeRow>(
    `SELECT
       n.taskgraph_id, n.node_id, n.state, n.task_run_id, n.slip_json,
       t.status AS task_status,
       t.created_at AS task_created_at, t.ended_at AS task_ended_at,
       tel.tool_call_count, tel.usage_event_count, tel.output_tokens,
       tel.agent_turn_ms, tel.tps_complete,
       t.summary AS task_summary,
       e.requested_agent_runtime, e.resolved_profile
     FROM taskgraph_node_state n
     LEFT JOIN tasks t ON t.id = n.task_run_id
     LEFT JOIN task_run_telemetry tel ON tel.task_run_id = n.task_run_id
     LEFT JOIN executions e ON e.id = t.execution_id
     WHERE n.taskgraph_id IN (${placeholders})
     ORDER BY n.taskgraph_id ASC, n.node_id ASC`,
  ).all(...graphIds)
}
function readLatestSequences(db: ForemanDatabase, graphIds: readonly string[]): Map<string, number> {
  const placeholders = graphIds.map(() => '?').join(', ')
  const rows = db.prepare<string[], LatestSeqRow>(
    `SELECT taskgraph_id, COALESCE(MAX(seq), 0) AS latest_seq
     FROM taskgraph_journal
     WHERE taskgraph_id IN (${placeholders})
     GROUP BY taskgraph_id`,
  ).all(...graphIds)
  const byGraph = new Map<string, number>()
  for (const row of rows) byGraph.set(row.taskgraph_id, row.latest_seq)
  return byGraph
}

function taskFromRow(
  row: TaskRow,
  association: { taskgraph_id: string; node_id: string } | undefined,
): ActivitySnapshotTask {
  const task: ActivitySnapshotTask = {
    task_run_id: row.task_run_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (row.template) task.task_id = row.template
  if (row.project) task.project = row.project
  if (row.worktree) task.worktree = true
  const runtime = boundString(row.requested_agent_runtime, MAX_RUNTIME_LENGTH)
  if (runtime) task.requested_agent_runtime = runtime
  const profile = boundString(row.resolved_profile, MAX_PROFILE_LENGTH)
  if (profile) task.resolved_profile = profile
  if (association) {
    task.taskgraph_id = association.taskgraph_id
    task.node_id = association.node_id
  }
  return task
}

function graphFromRow(
  row: GraphRow,
  nodeRows: NodeRow[],
  latestSeq: number,
  sampledAt: string,
): ActivitySnapshotGraph {
  if (nodeRows.length > ACTIVITY_LIMITS.maxNodesPerGraph) {
    throw limitError(
      `taskgraph '${row.id}' exceeded node limit of ${ACTIVITY_LIMITS.maxNodesPerGraph}`,
    )
  }
  const nodeCounts: Record<NodeRunStateType, number> = {
    planned: 0,
    running: 0,
    waiting: 0,
    done: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
  }
  const running: string[] = []
  const waiting: string[] = []
  const nodes: ActivitySnapshotNode[] = []
  for (const nodeRow of nodeRows) {
    nodeCounts[nodeRow.state] += 1
    if (nodeRow.state === 'running') running.push(nodeRow.node_id)
    if (nodeRow.state === 'waiting') waiting.push(nodeRow.node_id)
    nodes.push(nodeFromRow(nodeRow, sampledAt))
  }
  const graph: ActivitySnapshotGraph = {
    taskgraph_id: row.id,
    state: row.state,
    on_node_failure: row.on_node_failure,
    cancel_requested: row.cancel_requested === 1,
    structure_revision: row.structure_revision,
    latest_seq: latestSeq,
    node_counts: nodeCounts,
    active: { running, waiting },
    nodes,
  }
  if (row.title) graph.title = row.title
  if (row.project) graph.project = row.project
  const terminalReason = terminalReasonFor(row)
  if (terminalReason) graph.terminal_reason = terminalReason
  return graph
}

function terminalReasonFor(row: GraphRow): ActivityTerminalReason | undefined {
  if (row.state === 'done') return 'success'
  if (row.state === 'cancelled') {
    return row.failure_cause ? 'node_failed' : 'cancelled'
  }
  return undefined
}

function nodeFromRow(row: NodeRow, sampledAt: string): ActivitySnapshotNode {
  const node: ActivitySnapshotNode = {
    node_id: row.node_id,
    state: row.state,
  }
  if (row.task_run_id) {
    node.task_run_id = row.task_run_id
    if (row.task_status) node.task_status = row.task_status
  }
  const slip = parseSlip(row.slip_json)
  if (slip) {
    if (
      slip.category
      && typeof slip.category.id === 'string' && slip.category.id.length > 0
      && typeof slip.category.displayLabel === 'string' && slip.category.displayLabel.length > 0
    ) {
      node.task_category = { id: slip.category.id, display_label: slip.category.displayLabel }
      node.display_label = slip.category.displayLabel
    }
    if (typeof slip.description === 'string' && slip.description.trim()) {
      node.description = slip.description
    }
    if (typeof slip.taskId === 'string' && slip.taskId.trim()) {
      node.task_id = slip.taskId
    }
  }
  // The node's requested agent runtime prefers the bounded slip snapshot and
  // falls back to the run's execution metadata.
  const runtime = boundString(slip?.agentRuntime, MAX_RUNTIME_LENGTH)
    ?? boundString(row.requested_agent_runtime, MAX_RUNTIME_LENGTH)
  if (runtime) node.requested_agent_runtime = runtime
  if (row.task_run_id) {
    const profile = boundString(row.resolved_profile, MAX_PROFILE_LENGTH)
    if (profile) node.resolved_profile = profile
    if (row.tool_call_count !== null) node.tool_call_count = row.tool_call_count
    const tps = effectiveTps(row)
    if (tps !== undefined) node.tps = tps
    if (row.state === 'done' && row.task_summary && row.task_summary.trim()) {
      node.summary = foldSummary(row.task_summary)
    }
  }
  const runtimeMs = nodeRuntimeMs(row, sampledAt)
  if (runtimeMs !== undefined) node.runtime_ms = runtimeMs
  return node
}

const TERMINAL_TASK_STATUSES: ReadonlySet<ActivityTaskStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

/**
 * Node wall-clock duration in integer milliseconds. Non-terminal tasks are
 * sampled as the read time minus dispatch start; terminal tasks are frozen at
 * completion (ended_at minus created_at). Negative deltas (clock skew) clamp
 * to zero, and the field is omitted when the required timing data is absent
 * or unparseable.
 */
function nodeRuntimeMs(row: NodeRow, sampledAt: string): number | undefined {
  if (!row.task_created_at) return undefined
  const created = Date.parse(row.task_created_at)
  if (!Number.isFinite(created)) return undefined

  if (row.task_status && TERMINAL_TASK_STATUSES.has(row.task_status)) {
    if (!row.task_ended_at) return undefined
    const ended = Date.parse(row.task_ended_at)
    if (!Number.isFinite(ended)) return undefined
    return Math.max(0, Math.round(ended - created))
  }

  const sampled = Date.parse(sampledAt)
  if (!Number.isFinite(sampled)) return undefined
  return Math.max(0, Math.round(sampled - created))
}

function parseSlip(value: string | null): TaskNodeSlip | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as TaskNodeSlip
  } catch {
    return undefined
  }
}

function boundString(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length <= max ? value : value.slice(0, max)
}

/**
 * End-to-end effective output TPS = 1000 * output_tokens / agent_turn_ms.
 * Omitted unless the run's telemetry is complete, at least one usage event
 * was recorded, agent-turn wall time is positive, and the rate is finite
 * within 0..1_000_000. Mirrors the taskgraph.slip projection semantics.
 */
function effectiveTps(row: NodeRow): number | undefined {
  if (row.tps_complete !== 1) return undefined
  if (row.usage_event_count === null || row.usage_event_count <= 0) return undefined
  if (row.agent_turn_ms === null || row.agent_turn_ms <= 0) return undefined
  if (row.output_tokens === null) return undefined
  const tps = (1000 * row.output_tokens) / row.agent_turn_ms
  if (!Number.isFinite(tps) || tps < 0 || tps > MAX_TPS) return undefined
  return tps
}

/** Collapse whitespace to single spaces and truncate to 280 UTF-16 units. */
function foldSummary(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= MAX_SUMMARY_LENGTH ? collapsed : collapsed.slice(0, MAX_SUMMARY_LENGTH)
}

function limitError(message: string): ActivitySnapshotError {
  return new ActivitySnapshotError('LIMIT_EXCEEDED', message)
}
