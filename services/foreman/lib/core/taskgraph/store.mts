import { randomBytes } from 'node:crypto'

import type { ForemanDatabase } from '../../db/types.mts'
import type {
  EventRefs,
  EventSource,
  ExecutionError,
  PatchError,
  TaskGraphEvent,
  TaskGraphEventType,
  TaskGraphRunSummary,
} from './contracts.mts'
import type {
  GraphStateType,
  JsonObject,
  NodeId,
  NodeRunStateType,
  OnNodeFailurePolicy,
  TaskGraph,
  TaskGraphFailureCause,
  TaskGraphFailureCauseKind,
  TaskGraphPatch,
} from './model.mts'
import type { TaskNodeSlip } from './task-slip.mts'

export const TASKGRAPH_RUNNER_VERSION = 'taskgraph.runner.v1'

export interface TaskGraphRunProjection {
  id: string
  state: GraphStateType
  cancelRequested: boolean
  onNodeFailure: OnNodeFailurePolicy
  failureCause?: TaskGraphFailureCause
  structureRevision: number
  runnerVersion: string
  project?: string
  /** Immutable create-time title. Present on runs created with a title. */
  title?: string
  createdAt: string
  updatedAt: string
  endedAt?: string
}

export interface TaskGraphNodeStateProjection {
  nodeId: NodeId
  state: NodeRunStateType
  error?: ExecutionError
  output?: JsonObject
  taskRunId?: string
  /** Bounded server-authored static display metadata snapshot (slip). */
  slip?: TaskNodeSlip
  createdAt: string
  updatedAt: string
}

export interface TaskGraphProjection {
  run: TaskGraphRunProjection
  graph: TaskGraph
  nodeStates: Record<NodeId, TaskGraphNodeStateProjection>
}

/** Bounded per-node dynamic facts read by the atomic slip snapshot. */
export interface TaskGraphSlipTelemetry {
  taskRunId: string | null
  toolCallCount: number | null
  usageEventCount: number | null
  outputTokens: number | null
  agentTurnMs: number | null
  tpsComplete: number | null
  taskSummary: string | null
  resolvedProfile: string | null
}

/**
 * The whole taskgraph.slip payload resolved from one committed database
 * snapshot: run identity/state/structure revision, latest journal sequence,
 * requested-node action types/state/static slip snapshots, and matching
 * task-run telemetry/dynamic facts all correspond to the same transaction.
 */
export interface TaskGraphSlipSnapshot {
  taskgraphId: string
  graphState: GraphStateType
  structureRevision: number
  latestSeq: number
  actionTypes: ReadonlyMap<NodeId, string>
  nodes: ReadonlyMap<NodeId, { state: NodeRunStateType; slip?: TaskNodeSlip }>
  telemetry: ReadonlyMap<NodeId, TaskGraphSlipTelemetry>
}

export interface StoredTaskGraphPatch {
  id: string
  taskgraphId: string
  baseRevision: number
  status: 'pending' | 'applied' | 'rejected'
  patch: TaskGraphPatch
  postGraph: TaskGraph
  errors?: PatchError[]
  createdAt: string
  consumedAt?: string
}

interface RunRow {
  id: string
  state: GraphStateType
  cancel_requested: number
  on_node_failure: OnNodeFailurePolicy
  failure_cause: string | null
  structure_revision: number
  runner_version: string
  project: string | null
  title: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

interface GraphRow {
  graph_json: string
}

interface NodeStateRow {
  node_id: string
  state: NodeRunStateType
  error_json: string | null
  output_json: string | null
  task_run_id: string | null
  slip_json: string | null
  created_at: string
  updated_at: string
}

interface PatchRow {
  id: string
  taskgraph_id: string
  base_revision: number
  status: 'pending' | 'applied' | 'rejected'
  patch_json: string
  post_graph_json: string
  errors_json: string | null
  created_at: string
  consumed_at: string | null
}

interface JournalRow {
  event_id: string
  taskgraph_id: string
  seq: number
  type: TaskGraphEventType
  occurred_at: string
  structure_revision: number
  source_json: string
  refs_json: string | null
  data_json: string
}

/** Bounded columns read by the slip telemetry batch query. */
interface SlipTelemetryRow {
  node_id: string
  task_run_id: string | null
  tool_call_count: number | null
  usage_event_count: number | null
  output_tokens: number | null
  agent_turn_ms: number | null
  tps_complete: number | null
  task_summary: string | null
  resolved_profile: string | null
}

export class TaskGraphStore {
  constructor(private readonly db: ForemanDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  createProjection(
    graph: TaskGraph,
    createdAt: string,
    project?: string,
    onNodeFailure: OnNodeFailurePolicy = 'pause',
    title?: string,
    slips?: Readonly<Record<NodeId, TaskNodeSlip>>,
  ): TaskGraphProjection {
    return this.transaction(() => {
      this.db.prepare(
        `INSERT INTO taskgraph_run (
          id, state, cancel_requested, on_node_failure, failure_cause,
          structure_revision, runner_version,
          project, title, created_at, updated_at, ended_at
        ) VALUES (?, 'created', 0, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        graph.id,
        onNodeFailure,
        graph.revision,
        TASKGRAPH_RUNNER_VERSION,
        project ?? null,
        title ?? null,
        createdAt,
        createdAt,
      )
      this.db.prepare(
        `INSERT INTO taskgraph_graph (taskgraph_id, graph_json, updated_at)
         VALUES (?, ?, ?)`,
      ).run(graph.id, jsonText(graph), createdAt)

      const insertNode = this.db.prepare(
        `INSERT INTO taskgraph_node_state (
          taskgraph_id, node_id, state, error_json, output_json, task_run_id,
          slip_json, created_at, updated_at
        ) VALUES (?, ?, 'planned', NULL, NULL, NULL, ?, ?, ?)`,
      )
      for (const nodeId of Object.keys(graph.nodes)) {
        const slip = slips ? slips[nodeId] : undefined
        insertNode.run(graph.id, nodeId, slip ? jsonText(slip) : null, createdAt, createdAt)
      }
      return this.requireProjection(graph.id)
    })
  }

  has(taskgraphId: string): boolean {
    return this.db.prepare<[string], { present: number }>(
      'SELECT 1 AS present FROM taskgraph_run WHERE id = ?',
    ).get(taskgraphId) !== undefined
  }

  readProjection(taskgraphId: string): TaskGraphProjection | undefined {
    const run = this.db.prepare<[string], RunRow>(
      `SELECT id, state, cancel_requested, on_node_failure, failure_cause,
              structure_revision, runner_version,
              project, title, created_at, updated_at, ended_at
       FROM taskgraph_run WHERE id = ?`,
    ).get(taskgraphId)
    if (!run) return undefined

    const graphRow = this.db.prepare<[string], GraphRow>(
      'SELECT graph_json FROM taskgraph_graph WHERE taskgraph_id = ?',
    ).get(taskgraphId)
    if (!graphRow) throw new Error(`TaskGraph '${taskgraphId}' is missing graph projection`)

    const nodeRows = this.db.prepare<[string], NodeStateRow>(
      `SELECT node_id, state, error_json, output_json, task_run_id, slip_json, created_at, updated_at
       FROM taskgraph_node_state
       WHERE taskgraph_id = ?
       ORDER BY node_id ASC`,
    ).all(taskgraphId)
    const nodeStates = Object.create(null) as Record<NodeId, TaskGraphNodeStateProjection>
    for (const row of nodeRows) {
      Object.defineProperty(nodeStates, row.node_id, {
        value: nodeStateFromRow(row),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }

    return {
      run: runProjectionFromRow(run),
      graph: parseJson<TaskGraph>(graphRow.graph_json),
      nodeStates,
    }
  }

  requireProjection(taskgraphId: string): TaskGraphProjection {
    const projection = this.readProjection(taskgraphId)
    if (!projection) throw new Error(`TaskGraph '${taskgraphId}' not found`)
    return projection
  }

  updateRun(
    taskgraphId: string,
    update: {
      state?: GraphStateType
      cancelRequested?: boolean
      onNodeFailure?: OnNodeFailurePolicy
      failureCause?: TaskGraphFailureCause | null
      structureRevision?: number
      endedAt?: string | null
    },
    updatedAt: string,
  ): void {
    const current = this.requireProjection(taskgraphId).run
    this.db.prepare(
      `UPDATE taskgraph_run
       SET state = ?, cancel_requested = ?, on_node_failure = ?,
           failure_cause = ?, structure_revision = ?,
           updated_at = ?, ended_at = ?
       WHERE id = ?`,
    ).run(
      update.state ?? current.state,
      (update.cancelRequested ?? current.cancelRequested) ? 1 : 0,
      update.onNodeFailure ?? current.onNodeFailure,
      update.failureCause === undefined
        ? (current.failureCause ? jsonText(current.failureCause) : null)
        : (update.failureCause ? jsonText(update.failureCause) : null),
      update.structureRevision ?? current.structureRevision,
      updatedAt,
      update.endedAt === undefined ? (current.endedAt ?? null) : update.endedAt,
      taskgraphId,
    )
  }

  replaceGraph(graph: TaskGraph, updatedAt: string): void {
    this.db.prepare(
      `UPDATE taskgraph_graph SET graph_json = ?, updated_at = ? WHERE taskgraph_id = ?`,
    ).run(jsonText(graph), updatedAt, graph.id)
    this.updateRun(graph.id, { structureRevision: graph.revision }, updatedAt)
  }

  putNodeState(
    taskgraphId: string,
    nodeId: NodeId,
    update: {
      state: NodeRunStateType
      error?: ExecutionError | null
      output?: JsonObject | null
      taskRunId?: string | null
    },
    updatedAt: string,
  ): void {
    const existing = this.db.prepare<[string, string], { created_at: string }>(
      'SELECT created_at FROM taskgraph_node_state WHERE taskgraph_id = ? AND node_id = ?',
    ).get(taskgraphId, nodeId)
    this.db.prepare(
      `INSERT INTO taskgraph_node_state (
        taskgraph_id, node_id, state, error_json, output_json, task_run_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskgraph_id, node_id) DO UPDATE SET
        state = excluded.state,
        error_json = excluded.error_json,
        output_json = excluded.output_json,
        task_run_id = excluded.task_run_id,
        updated_at = excluded.updated_at`,
    ).run(
      taskgraphId,
      nodeId,
      update.state,
      update.error ? jsonText(update.error) : null,
      update.output ? jsonText(update.output) : null,
      update.taskRunId ?? null,
      existing?.created_at ?? updatedAt,
      updatedAt,
    )
  }

  deleteNodeState(taskgraphId: string, nodeId: NodeId): void {
    this.db.prepare(
      'DELETE FROM taskgraph_node_state WHERE taskgraph_id = ? AND node_id = ?',
    ).run(taskgraphId, nodeId)
  }

  /**
   * Persist (or clear) the bounded slip snapshot for one task node. The
   * snapshot is server-authored from the resolved task definition at graph
   * create / AddNode / ReplaceNode time and never mutates an existing graph
   * revision. Passing `null`/`undefined` clears any previously stored slip.
   */
  putNodeSlip(
    taskgraphId: string,
    nodeId: NodeId,
    slip: TaskNodeSlip | null | undefined,
    updatedAt: string,
  ): void {
    const existing = this.db.prepare<[string, string], { created_at: string }>(
      'SELECT created_at FROM taskgraph_node_state WHERE taskgraph_id = ? AND node_id = ?',
    ).get(taskgraphId, nodeId)
    if (!existing) return
    this.db.prepare(
      `UPDATE taskgraph_node_state SET slip_json = ?, updated_at = ?
       WHERE taskgraph_id = ? AND node_id = ?`,
    ).run(slip ? jsonText(slip) : null, updatedAt, taskgraphId, nodeId)
  }

  /**
   * One synchronous read snapshot for taskgraph.slip. All facts — run identity/
   * state/structure revision, latest journal sequence, requested-node action
   * types/state/static slip snapshots, and the matching task-run telemetry —
   * are read inside a single transaction so a slip response can never mix
   * different committed database snapshots. Selects only the bounded
   * projection columns — never action params or schemas, task input/output/
   * error, execution prompt/output/raw_result/error, or event data. Node
   * action types are extracted from the graph JSON with JSON1
   * `json_each`/`json_extract` so only `action.type` is read, not
   * `action.params`. Telemetry is one batched join (never N+1) bounded to the
   * requested nodes.
   */
  readSlipProjection(
    taskgraphId: string,
    nodeIds: readonly NodeId[],
  ): TaskGraphSlipSnapshot {
    return this.transaction(() => {
      const runRow = this.db.prepare<[string], { id: string; state: GraphStateType; structure_revision: number }>(
        `SELECT id, state, structure_revision FROM taskgraph_run WHERE id = ?`,
      ).get(taskgraphId)
      if (!runRow) throw new Error(`TaskGraph '${taskgraphId}' not found`)

      const actionTypeRows = this.db.prepare<[string], { node_id: string; action_type: string | null }>(
        `SELECT json_each.key AS node_id, json_extract(json_each.value, '$.action.type') AS action_type
         FROM taskgraph_graph, json_each(taskgraph_graph.graph_json, '$.nodes')
         WHERE taskgraph_id = ?`,
      ).all(taskgraphId)
      const actionTypes = new Map<NodeId, string>()
      for (const row of actionTypeRows) {
        if (row.action_type) actionTypes.set(row.node_id, row.action_type)
      }

      const placeholders = nodeIds.map(() => '?').join(', ')
      const nodeRows = this.db.prepare<[string, ...string[]], { node_id: string; state: NodeRunStateType; slip_json: string | null }>(
        `SELECT node_id, state, slip_json
         FROM taskgraph_node_state
         WHERE taskgraph_id = ? AND node_id IN (${placeholders})`,
      ).all(taskgraphId, ...nodeIds)
      const nodes = new Map<NodeId, { state: NodeRunStateType; slip?: TaskNodeSlip }>()
      for (const row of nodeRows) {
        nodes.set(row.node_id, {
          state: row.state,
          ...(row.slip_json ? { slip: parseJson<TaskNodeSlip>(row.slip_json) } : {}),
        })
      }

      const latestSeq = this.db.prepare<[string], { latest_seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM taskgraph_journal WHERE taskgraph_id = ?',
      ).get(taskgraphId)?.latest_seq ?? 0

      const telemetry = new Map<NodeId, TaskGraphSlipTelemetry>()
      for (const row of this.readSlipTelemetry(taskgraphId, nodeIds)) {
        telemetry.set(row.node_id, {
          taskRunId: row.task_run_id,
          toolCallCount: row.tool_call_count,
          usageEventCount: row.usage_event_count,
          outputTokens: row.output_tokens,
          agentTurnMs: row.agent_turn_ms,
          tpsComplete: row.tps_complete,
          taskSummary: row.task_summary,
          resolvedProfile: row.resolved_profile,
        })
      }

      return {
        taskgraphId: runRow.id,
        graphState: runRow.state,
        structureRevision: runRow.structure_revision,
        latestSeq,
        actionTypes,
        nodes,
        telemetry,
      }
    })
  }

  /**
   * One bounded batch query for slip dynamic fields, executed inside the
   * atomic slip snapshot. Joins each requested node's current execution
   * (through its task run and that run's execution_id) and its durable
   * telemetry row. Never N+1 and never scans the events table: only per-run
   * counters, the task summary, and the resolved profile are read.
   */
  private readSlipTelemetry(
    taskgraphId: string,
    nodeIds: readonly NodeId[],
  ): SlipTelemetryRow[] {
    const placeholders = nodeIds.map(() => '?').join(', ')
    return this.db.prepare<[string, ...string[]], SlipTelemetryRow>(
      `SELECT
         n.node_id,
         n.task_run_id,
         tel.tool_call_count,
         tel.usage_event_count,
         tel.output_tokens,
         tel.agent_turn_ms,
         tel.tps_complete,
         t.summary AS task_summary,
         e.resolved_profile AS resolved_profile
       FROM taskgraph_node_state n
       LEFT JOIN task_run_telemetry tel ON tel.task_run_id = n.task_run_id
       LEFT JOIN tasks t ON t.id = n.task_run_id
       LEFT JOIN executions e ON e.id = t.execution_id
       WHERE n.taskgraph_id = ? AND n.node_id IN (${placeholders})`,
    ).all(taskgraphId, ...nodeIds)
  }

  storePendingPatch(patch: StoredTaskGraphPatch): void {
    this.db.prepare(
      `INSERT INTO taskgraph_patch (
        id, taskgraph_id, base_revision, status, patch_json, post_graph_json,
        errors_json, created_at, consumed_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, NULL)`,
    ).run(
      patch.id,
      patch.taskgraphId,
      patch.baseRevision,
      jsonText(patch.patch),
      jsonText(patch.postGraph),
      patch.createdAt,
    )
  }

  readPatch(patchId: string): StoredTaskGraphPatch | undefined {
    const row = this.db.prepare<[string], PatchRow>(
      `SELECT id, taskgraph_id, base_revision, status, patch_json, post_graph_json,
              errors_json, created_at, consumed_at
       FROM taskgraph_patch WHERE id = ?`,
    ).get(patchId)
    if (!row) return undefined
    return {
      id: row.id,
      taskgraphId: row.taskgraph_id,
      baseRevision: row.base_revision,
      status: row.status,
      patch: parseJson<TaskGraphPatch>(row.patch_json),
      postGraph: parseJson<TaskGraph>(row.post_graph_json),
      ...(row.errors_json ? { errors: parseJson<PatchError[]>(row.errors_json) } : {}),
      createdAt: row.created_at,
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    }
  }

  consumePatch(
    patchId: string,
    status: 'applied' | 'rejected',
    consumedAt: string,
    errors?: PatchError[],
  ): boolean {
    const result = this.db.prepare(
      `UPDATE taskgraph_patch
       SET status = ?, errors_json = ?, consumed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(status, errors ? jsonText(errors) : null, consumedAt, patchId)
    return result.changes === 1
  }

  appendJournal(params: {
    taskgraphId: string
    type: TaskGraphEventType
    occurredAt: string
    structureRevision: number
    source: EventSource
    refs?: EventRefs
    data?: JsonObject
  }): TaskGraphEvent {
    const seqRow = this.db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
       FROM taskgraph_journal WHERE taskgraph_id = ?`,
    ).get(params.taskgraphId)
    const event: TaskGraphEvent = {
      event_id: createEventId(),
      taskgraph_id: params.taskgraphId,
      seq: seqRow?.seq ?? 1,
      type: params.type,
      occurred_at: params.occurredAt,
      structure_revision: params.structureRevision,
      source: params.source,
      ...(params.refs ? { refs: params.refs } : {}),
      data: params.data ?? {},
    }
    this.db.prepare(
      `INSERT INTO taskgraph_journal (
        taskgraph_id, seq, event_id, type, occurred_at, structure_revision,
        source_json, refs_json, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.taskgraph_id,
      event.seq,
      event.event_id,
      event.type,
      event.occurred_at,
      event.structure_revision,
      jsonText(event.source),
      event.refs ? jsonText(event.refs) : null,
      jsonText(event.data),
    )
    return event
  }

  /**
   * Transaction-scoped cancel-policy failure commit. Atomically persists the
   * failed node state, the taskgraph.node.failed journal row (returned so the
   * caller can read its event id), the first immutable failure cause, and
   * cancellation intent before sibling cancellation begins. An existing
   * persisted cause is preserved: the first terminal cause is the only one
   * ever recorded, and later failures never overwrite it. A crash between a
   * failed-node write and this commit is repaired idempotently by
   * repairCancelPolicyFailure.
   */
  failNodeForCancellation(params: {
    taskgraphId: string
    nodeId: NodeId
    error: ExecutionError
    taskRunId?: string
    occurredAt: string
    source: EventSource
    refs?: EventRefs
    data?: JsonObject
    causeKind?: TaskGraphFailureCauseKind
  }): TaskGraphEvent {
    return this.transaction(() => {
      this.putNodeState(
        params.taskgraphId,
        params.nodeId,
        { state: 'failed', error: params.error, output: null, taskRunId: params.taskRunId ?? null },
        params.occurredAt,
      )
      const event = this.appendJournal({
        taskgraphId: params.taskgraphId,
        type: 'taskgraph.node.failed',
        occurredAt: params.occurredAt,
        structureRevision: this.requireProjection(params.taskgraphId).graph.revision,
        source: params.source,
        refs: params.refs,
        data: params.data,
      })
      const run = this.requireProjection(params.taskgraphId).run
      const firstCause: TaskGraphFailureCause = {
        kind: params.causeKind ?? 'node_failed',
        node_id: params.nodeId,
        ...(params.taskRunId ? { task_run_id: params.taskRunId } : {}),
        error: params.error,
        event_id: event.event_id,
      }
      this.updateRun(
        params.taskgraphId,
        {
          cancelRequested: true,
          failureCause: run.failureCause ?? firstCause,
        },
        params.occurredAt,
      )
      return event
    })
  }

  /**
   * Idempotent recovery repair for a cancel-policy run whose persisted failed
   * node lacks cancellation intent and/or a run-level failure cause (a crash
   * between the failed-node write and the atomic cancel-policy commit).
   * Deterministically selects the globally earliest durable failure: the
   * earliest taskgraph.node.failed journal row (ordered by journal seq,
   * without page/limit truncation) for any currently failed node. When no
   * journal evidence exists, falls back to the persisted failure-transition
   * ordering source (node row updated_at), never node row created_at. No-op
   * once the run already carries cancellation intent and a cause, so it is
   * safe to re-run on every restart; an existing cause is never replaced.
   */
  repairCancelPolicyFailure(taskgraphId: string, updatedAt: string): void {
    const projection = this.requireProjection(taskgraphId)
    if (projection.run.onNodeFailure !== 'cancel') return
    if (projection.run.cancelRequested && projection.run.failureCause) return

    const failedNodes = Object.values(projection.nodeStates)
      .filter((entry) => entry.state === 'failed')
    if (failedNodes.length === 0) return

    // Globally earliest durable failure: the first taskgraph.node.failed
    // journal row for any currently failed node, ordered by journal seq with
    // no page/limit window, so large journals cannot hide the first failure.
    const failedNodeIds = new Set(failedNodes.map((entry) => entry.nodeId))
    const failedRows = this.db.prepare<[string], JournalRow>(
      `SELECT event_id, taskgraph_id, seq, type, occurred_at, structure_revision,
              source_json, refs_json, data_json
       FROM taskgraph_journal
       WHERE taskgraph_id = ? AND type = 'taskgraph.node.failed'
       ORDER BY seq ASC`,
    ).all(taskgraphId)
    const firstRow = failedRows.find((row) => {
      const refs = row.refs_json ? parseJson<EventRefs>(row.refs_json) : undefined
      return refs?.node_id !== undefined && failedNodeIds.has(refs.node_id)
    })

    // Select the failed node the earliest journal row belongs to; with no
    // journal evidence, use the persisted failure-transition ordering source
    // (node row updated_at), never node row created_at.
    let earliest: TaskGraphNodeStateProjection | undefined
    if (firstRow) {
      const refs = firstRow.refs_json ? parseJson<EventRefs>(firstRow.refs_json) : undefined
      earliest = failedNodes.find((entry) => entry.nodeId === refs?.node_id)
    }
    if (!earliest) {
      earliest = failedNodes
        .slice()
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]
    }
    if (!earliest) return

    const error = earliest.error ?? {
      code: 'TASK_RUN_FAILED',
      message: `taskgraph node '${earliest.nodeId}' failed without persisted evidence`,
    }
    const cause: TaskGraphFailureCause = {
      kind: 'node_failed',
      node_id: earliest.nodeId,
      ...(earliest.taskRunId ? { task_run_id: earliest.taskRunId } : {}),
      error,
      ...(firstRow ? { event_id: firstRow.event_id } : {}),
    }
    this.updateRun(taskgraphId, {
      cancelRequested: true,
      failureCause: projection.run.failureCause ?? cause,
    }, updatedAt)
  }

  listEvents(
    taskgraphId: string,
    afterSeq = 0,
    requestedLimit = 100,
  ): { events: TaskGraphEvent[]; nextSeq: number; latestSeq: number; hasMore: boolean } {
    const limit = Math.max(1, Math.min(requestedLimit, 1000))
    const rows = this.db.prepare<[string, number, number], JournalRow>(
      `SELECT event_id, taskgraph_id, seq, type, occurred_at, structure_revision,
              source_json, refs_json, data_json
       FROM taskgraph_journal
       WHERE taskgraph_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    ).all(taskgraphId, afterSeq, limit + 1)
    const hasMore = rows.length > limit
    const selected = hasMore ? rows.slice(0, limit) : rows
    const events = selected.map(eventFromRow)
    const latestRow = this.db.prepare<[string], { latest_seq: number }>(
      'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM taskgraph_journal WHERE taskgraph_id = ?',
    ).get(taskgraphId)
    return {
      events,
      nextSeq: events.at(-1)?.seq ?? afterSeq,
      latestSeq: latestRow?.latest_seq ?? 0,
      hasMore,
    }
  }

  latestSequence(taskgraphId: string): number {
    return this.db.prepare<[string], { latest_seq: number }>(
      'SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM taskgraph_journal WHERE taskgraph_id = ?',
    ).get(taskgraphId)?.latest_seq ?? 0
  }

  list(
    params: { project?: string; states?: GraphStateType[]; limit: number },
  ): TaskGraphRunSummary[] {
    const conditions: string[] = []
    const bindings: unknown[] = []

    if (params.project !== undefined) {
      conditions.push('project = ?')
      bindings.push(params.project)
    }

    if (params.states !== undefined && params.states.length > 0) {
      const placeholders = params.states.map(() => '?').join(', ')
      conditions.push(`state IN (${placeholders})`)
      bindings.push(...params.states)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = this.db.prepare<unknown[], RunRow>(
      `SELECT id, state, cancel_requested, on_node_failure, failure_cause,
              structure_revision, runner_version,
              project, title, created_at, updated_at, ended_at
       FROM taskgraph_run
       ${whereClause}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    ).all(...bindings, params.limit) as RunRow[]

    return rows.map(runSummaryFromRow)
  }

  /**
   * Narrowly scoped startup query for runs that need daemon action: active
   * running graphs, in-flight cancellations, paused graphs with a live running
   * node, and cancel-policy graphs whose persisted failed node has not yet
   * converged to cancelled. These are the only projections the daemon startup
   * reconciliation should instantiate runners for.
   */
  listActionableRuns(): TaskGraphRunProjection[] {
    const rows = this.db.prepare<[], RunRow>(
      `SELECT DISTINCT r.id, r.state, r.cancel_requested, r.on_node_failure,
              r.failure_cause, r.structure_revision, r.runner_version,
              r.project, r.title, r.created_at, r.updated_at, r.ended_at
       FROM taskgraph_run r
       LEFT JOIN taskgraph_node_state n ON n.taskgraph_id = r.id
       WHERE r.state = 'running'
          OR r.cancel_requested = 1
          OR (r.state = 'paused' AND n.state = 'running')
          OR (r.state = 'paused' AND r.on_node_failure = 'cancel' AND n.state = 'failed')
       ORDER BY r.updated_at ASC, r.id ASC`,
    ).all()
    return rows.map(runProjectionFromRow)
  }
}

function runProjectionFromRow(row: RunRow): TaskGraphRunProjection {
  return {
    id: row.id,
    state: row.state,
    cancelRequested: row.cancel_requested === 1,
    onNodeFailure: row.on_node_failure,
    ...(row.failure_cause ? { failureCause: parseJson<TaskGraphFailureCause>(row.failure_cause) } : {}),
    structureRevision: row.structure_revision,
    runnerVersion: row.runner_version,
    ...(row.project ? { project: row.project } : {}),
    ...(row.title ? { title: row.title } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  }
}

function nodeStateFromRow(row: NodeStateRow): TaskGraphNodeStateProjection {
  return {
    nodeId: row.node_id,
    state: row.state,
    ...(row.error_json ? { error: parseJson<ExecutionError>(row.error_json) } : {}),
    ...(row.output_json ? { output: parseJson<JsonObject>(row.output_json) } : {}),
    ...(row.task_run_id ? { taskRunId: row.task_run_id } : {}),
    ...(row.slip_json ? { slip: parseJson<TaskNodeSlip>(row.slip_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function eventFromRow(row: JournalRow): TaskGraphEvent {
  return {
    event_id: row.event_id,
    taskgraph_id: row.taskgraph_id,
    seq: row.seq,
    type: row.type,
    occurred_at: row.occurred_at,
    structure_revision: row.structure_revision,
    source: parseJson<EventSource>(row.source_json),
    ...(row.refs_json ? { refs: parseJson<EventRefs>(row.refs_json) } : {}),
    data: parseJson<JsonObject>(row.data_json),
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value)
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function createEventId(): string {
  return `tge_${randomBytes(12).toString('hex')}`
}

function runSummaryFromRow(row: RunRow): TaskGraphRunSummary {
  return {
    taskgraph_id: row.id,
    state: row.state,
    ...(row.cancel_requested === 1 ? { cancel_requested: true as const } : {}),
    on_node_failure: row.on_node_failure,
    ...(row.title ? { title: row.title } : {}),
    ...(row.failure_cause ? { failure: parseJson<TaskGraphFailureCause>(row.failure_cause) } : {}),
    structure_revision: row.structure_revision,
    ...(row.project ? { project: row.project } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.ended_at ? { ended_at: row.ended_at } : {}),
  }
}
