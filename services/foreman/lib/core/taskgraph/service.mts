import { randomBytes } from 'node:crypto'

import type { OperationHost } from '../operations/types.mts'
import type { ForemanDatabase } from '../../db/types.mts'
import type {
  TaskGraphCreateParams,
  TaskGraphCreateResult,
  TaskGraphEventsParams,
  TaskGraphInspectParams,
  TaskGraphInspectResult,
  TaskGraphListParams,
  TaskGraphListResult,
  TaskGraphNodeInspectParams,
  TaskGraphPatchParams,
  TaskGraphSignalParams,
  TaskGraphSignalResult,
  TaskGraphStatusParams,
  TaskGraphEventsResult,
  TaskGraphNodeInspectResult,
  TaskGraphPatchResult,
  TaskGraphStatusResult,
  TaskGraphEvent,
  TaskGraphSlipParams,
  TaskGraphSlipResult,
  TaskGraphWaitParams,
  TaskGraphWaitReason,
  TaskGraphWaitResult,
} from './contracts.mts'
import type { JsonObject, ObjectJsonSchema, TaskGraph, TaskGraphNode } from './model.mts'
import {
  GraphRunner,
  TaskGraphValidationError,
} from './runner.mts'
import { TaskGraphStore, type TaskGraphRunProjection, type TaskGraphSlipTelemetry } from './store.mts'
import {
  TaskServiceTaskBridge,
  type TaskGraphTaskBridge,
} from './task-bridge.mts'
import type { TaskGraphAutoSchemaResolver } from './materialize.mts'
import { WorkspaceTaskContractResolver, type TaskGraphTaskContractResolver } from './task-contract-resolver.mts'
import { buildTaskSlipNode, type TaskSlipNodeOutput } from './task-slip.mts'
import { findTaskDefinition } from '../../workspace/definition-registry.mts'
import { normalizeTaskContext, TaskContextError } from '../task/context.mts'

export type TaskGraphServiceErrorCode =
  | 'TASKGRAPH_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'INVALID_GRAPH'
  | 'INVALID_TITLE'
  | 'INVALID_CONTEXT'
  | 'INVALID_SLIP_REQUEST'

export class TaskGraphServiceError extends Error {
  readonly code: TaskGraphServiceErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: TaskGraphServiceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'TaskGraphServiceError'
    this.code = code
    this.details = details
  }
}

export interface TaskGraphServiceOptions {
  db: ForemanDatabase
  workspaceRoot: string
  operations?: OperationHost
  taskBridge?: TaskGraphTaskBridge
  schemaResolver?: TaskGraphAutoSchemaResolver
  contractResolver?: TaskGraphTaskContractResolver
  eventSink?: (event: TaskGraphEvent) => void | Promise<void>
  now?: () => string
}

export class TaskGraphService {
  private readonly store: TaskGraphStore
  private readonly taskBridge: TaskGraphTaskBridge
  private readonly schemaResolver: TaskGraphAutoSchemaResolver
  private readonly contractResolver: TaskGraphTaskContractResolver
  private readonly eventSink?: (event: TaskGraphEvent) => void | Promise<void>
  private readonly now: () => string
  private readonly runners = new Map<string, GraphRunner>()

  constructor(options: TaskGraphServiceOptions) {
    this.store = new TaskGraphStore(options.db)
    this.taskBridge = options.taskBridge ?? new TaskServiceTaskBridge({
      workspaceRoot: options.workspaceRoot,
      operations: options.operations,
    })
    this.contractResolver = options.contractResolver ?? workspaceContractResolver(options.workspaceRoot)
    this.schemaResolver = options.schemaResolver ?? contractSchemaResolver(this.contractResolver)
    this.eventSink = options.eventSink
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async create(params: TaskGraphCreateParams): Promise<TaskGraphCreateResult> {
    const id = createTaskGraphId()
    const title = normalizeCreateTitle(params.title)
    let taskGraphContext
    try {
      taskGraphContext = params.tg_ctx === undefined
        ? undefined
        : normalizeTaskContext(params.tg_ctx, 'tg_ctx')
    } catch (error) {
      if (error instanceof TaskContextError) {
        throw new TaskGraphServiceError('INVALID_CONTEXT', error.message)
      }
      throw error
    }
    const graph: TaskGraph = {
      id,
      revision: 1,
      ...(taskGraphContext ? { tg_ctx: taskGraphContext } : {}),
      nodes: cloneNodes(params.graph.nodes as unknown as Record<string, TaskGraphNode>),
    }
    try {
      const created = await this.runner(id, params.project).create(
        graph,
        params.on_node_failure,
        title,
      )
      const projection = this.store.requireProjection(id)
      return {
        taskgraph: {
          id: created.id,
          revision: created.revision,
          status: 'created',
          created_at: projection.run.createdAt,
          ...(projection.run.title ? { title: projection.run.title } : {}),
        },
      }
    } catch (error) {
      this.runners.delete(id)
      if (error instanceof TaskGraphValidationError) {
        throw new TaskGraphServiceError(
          'INVALID_GRAPH',
          `TaskGraph failed full-graph validation: ${error.issues
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join('; ')}`,
          { issues: error.issues },
        )
      }
      throw error
    }
  }

  async patch(params: TaskGraphPatchParams): Promise<TaskGraphPatchResult> {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    if (params.operation.type === 'request_patch') {
      return r.requestPatch(
        params.operation.patch as unknown as import('./model.mts').TaskGraphPatch,
      )
    }
    return r.confirmPatch(params.operation.patch_id)
  }

  async rejectPatch(taskgraphId: string, patchId: string): Promise<boolean> {
    this.requireTaskGraph(taskgraphId)
    return this.runner(taskgraphId).rejectPatch(patchId)
  }

  status(params: TaskGraphStatusParams): TaskGraphStatusResult {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    return r.status()
  }

  events(params: TaskGraphEventsParams): TaskGraphEventsResult {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    return r.events(params.after_seq, params.limit)
  }

  signal(params: TaskGraphSignalParams): TaskGraphSignalResult {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    return r.signal(
      params.signal as unknown as import('./contracts.mts').TaskGraphSignal,
    )
  }

  inspect(params: TaskGraphNodeInspectParams): TaskGraphNodeInspectResult {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    const result = r.inspect(params.node_id)
    if (!result) {
      throw new TaskGraphServiceError(
        'NODE_NOT_FOUND',
        `TaskGraph node '${params.node_id}' not found`,
        {
          taskgraph_id: params.taskgraph_id,
          node_id: params.node_id,
        },
      )
    }
    return result
  }

  inspectGraph(params: TaskGraphInspectParams): TaskGraphInspectResult {
    this.requireTaskGraph(params.taskgraph_id)
    const projection = this.store.requireProjection(params.taskgraph_id)
    return { graph: projection.graph }
  }

  /**
   * Read-only bounded task-node slip projection built entirely from the
   * store's single atomic read snapshot (run state/structure revision, latest
   * journal sequence, node states/static slips, and task-run telemetry all
   * come from one committed database snapshot). Fail-closed: the whole
   * request fails on duplicate, unknown, or non-task node ids; the response
   * is one bounded DTO per node in request order with no N+1 queries and no
   * raw execution data.
   */
  slip(params: TaskGraphSlipParams): TaskGraphSlipResult {
    this.requireTaskGraph(params.taskgraph_id)
    const nodeIds = params.node_ids
    if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.length > 256) {
      throw new TaskGraphServiceError(
        'INVALID_SLIP_REQUEST',
        'node_ids must be a non-empty array of at most 256 unique ids',
      )
    }
    const seen = new Set<string>()
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) {
        throw new TaskGraphServiceError(
          'INVALID_SLIP_REQUEST',
          'each node_id must be a string of 1..128 UTF-16 code units',
        )
      }
      if (seen.has(nodeId)) {
        throw new TaskGraphServiceError(
          'INVALID_SLIP_REQUEST',
          `duplicate node_id '${nodeId}'`,
        )
      }
      seen.add(nodeId)
    }

    const projection = this.store.readSlipProjection(params.taskgraph_id, nodeIds)
    for (const nodeId of nodeIds) {
      if (!projection.nodes.has(nodeId) || projection.actionTypes.get(nodeId) !== 'task') {
        throw new TaskGraphServiceError(
          'INVALID_SLIP_REQUEST',
          `node '${nodeId}' is not an existing task action node`,
        )
      }
    }

    const nodes = nodeIds.map((nodeId) => {
      const entry = projection.nodes.get(nodeId)
      const state = entry?.state ?? 'planned'
      const node: SlipNodeOutput = {
        ...buildTaskSlipNode({
          nodeId,
          state,
          slip: entry?.slip,
        }),
      }
      const row = projection.telemetry.get(nodeId)
      // tool_call_count is surfaced only when the task run has a durable
      // telemetry row; legacy runs without a row simply omit it.
      if (row && row.taskRunId !== null && row.toolCallCount !== null) {
        node.tool_call_count = row.toolCallCount
      }
      // tps is the end-to-end effective output rate over client-reported
      // agent-turn wall time (may include tool execution and waiting); it is
      // never named or documented as provider generation speed.
      const tps = row ? effectiveTps(row) : undefined
      if (tps !== undefined) node.tps = tps
      if (row && typeof row.resolvedProfile === 'string'
        && row.resolvedProfile.length > 0 && row.resolvedProfile.length <= MAX_PROFILE_LENGTH) {
        node.profile = row.resolvedProfile
      }
      // The folded/truncated task summary is bounded to 280 UTF-16 units and
      // only surfaced for graph nodes whose node state is done.
      if (state === 'done' && row && typeof row.taskSummary === 'string' && row.taskSummary.trim()) {
        node.summary = foldSlipSummary(row.taskSummary)
      }
      return node
    })
    return {
      schema_version: 'foreman.taskgraph.slip.v1',
      taskgraph_id: params.taskgraph_id,
      graph_state: projection.graphState,
      structure_revision: projection.structureRevision,
      latest_seq: projection.latestSeq,
      nodes,
    }
  }

  list(params: TaskGraphListParams = {}): TaskGraphListResult {
    const limit = typeof params.limit === 'number'
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 24
    const runs = this.store.list({
      project: params.project,
      states: params.states,
      limit,
    })
    return { runs }
  }

  async wait(params: TaskGraphWaitParams): Promise<TaskGraphWaitResult> {
    this.requireTaskGraph(params.taskgraph_id)
    const r = this.runner(params.taskgraph_id)
    const timeoutMs = normalizeWaitTimeout(params.timeout_ms)
    const reason = await r.waitForSettle(timeoutMs)
    return buildWaitResult(r, reason)
  }

  async whenIdle(taskgraphId: string): Promise<void> {
    this.requireTaskGraph(taskgraphId)
    const r = this.runner(taskgraphId)
    await r.whenIdle()
  }

  /**
   * One-shot startup reconciliation: instantiate runners only for
   * store-reported actionable graphs (running, cancel_requested, paused with
   * live running nodes, or cancel-policy graphs whose failed node has not
   * converged). Each graph's recovery is isolated and observable rather than
   * blocking daemon startup; ordinary graphs stay lazy and are never polled.
   */
  async reconcileStartup(): Promise<void> {
    const actionable = this.store.listActionableRuns()
    await Promise.all(actionable.map((run) => this.reconcileRun(run)))
  }

  private async reconcileRun(run: TaskGraphRunProjection): Promise<void> {
    try {
      const runner = this.runner(run.id)
      await runner.whenIdle()
    } catch (error) {
      process.stderr.write(
        `[taskgraph] startup reconciliation failed for '${run.id}': ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

  private runner(taskgraphId: string, project?: string): GraphRunner {
    const existing = this.runners.get(taskgraphId)
    if (existing) return existing
    // If project not explicitly provided and graph already exists in store,
    // load the persisted allowedProject from the projection so that
    // post-reconstruction runners enforce the same scope as the original create.
    let resolvedProject = project
    if (resolvedProject === undefined && this.store.has(taskgraphId)) {
      const projection = this.store.requireProjection(taskgraphId)
      resolvedProject = projection.run.project
    }
    const runner = new GraphRunner({
      taskgraphId,
      store: this.store,
      taskBridge: this.taskBridge,
      schemaResolver: this.schemaResolver,
      contractResolver: this.contractResolver,
      eventSink: this.eventSink,
      now: this.now,
      allowedProject: resolvedProject,
    })
    this.runners.set(taskgraphId, runner)
    return runner
  }

  private requireTaskGraph(taskgraphId: string): void {
    if (!this.store.has(taskgraphId)) {
      throw new TaskGraphServiceError(
        'TASKGRAPH_NOT_FOUND',
        `TaskGraph '${taskgraphId}' not found`,
        { taskgraph_id: taskgraphId },
      )
    }
  }
}

/**
 * Slip node DTO extended with bounded dynamic runtime fields. Every optional
 * field is omitted (never null) when the underlying data is absent, invalid,
 * or out of its documented bound.
 */
type SlipNodeOutput = TaskSlipNodeOutput & {
  tool_call_count?: number
  tps?: number
  profile?: string
  summary?: string
}

const MAX_PROFILE_LENGTH = 128
const MAX_SUMMARY_LENGTH = 280
const MAX_TPS = 1_000_000

/**
 * End-to-end effective output TPS = 1000 * output_tokens / agent_turn_ms
 * over client-reported agent-turn/session wall time (may include tool
 * execution and waiting). Returned only when the run's telemetry is complete
 * (tps_complete), at least one usage event was recorded, the summed
 * agent-turn wall time is positive, and the rate is finite within
 * 0..1_000_000. Anything else is omitted. This is deliberately not named or
 * documented as provider generation speed.
 */
function effectiveTps(row: TaskGraphSlipTelemetry): number | undefined {
  if (row.tpsComplete !== 1) return undefined
  if (row.usageEventCount === null || row.usageEventCount <= 0) return undefined
  if (row.agentTurnMs === null || row.agentTurnMs <= 0) return undefined
  if (row.outputTokens === null) return undefined
  const tps = (1000 * row.outputTokens) / row.agentTurnMs
  if (!Number.isFinite(tps) || tps < 0 || tps > MAX_TPS) return undefined
  return tps
}

/** Collapse whitespace to single spaces and truncate to 280 UTF-16 units. */
function foldSlipSummary(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= MAX_SUMMARY_LENGTH ? collapsed : collapsed.slice(0, MAX_SUMMARY_LENGTH)
}

const DEFAULT_WAIT_TIMEOUT_MS = 60_000
const MAX_WAIT_TIMEOUT_MS = 600_000

/**
 * Default auto-schema resolver that materializes task node schemas
 * from the selected project's task definition contract. This lets
 * task nodes omit hand-copied schemas when the current task contract carries
 * them. Explicit graph schemas are preserved by materialization (resolver
 * output is only used for omitted output schemas); when no contract can be
 * resolved, materialization fails with a clear SCHEMA_REQUIRED issue.
 */
function contractSchemaResolver(
  contractResolver: TaskGraphTaskContractResolver,
): TaskGraphAutoSchemaResolver {
  return {
    resolveActionSchema(actionType, params) {
      const name = typeof params.name === 'string' && params.name.trim() ? params.name : ''
      const project = typeof params.project === 'string' && params.project.trim() ? params.project : ''
      if (!name || !project) return null
      const contract = contractResolver.resolveDefinitionContract(actionType, name, project)
      if (!contract) return null
      const output = toTaskGraphOutputSchema(contract.output)
      // TaskGraph node outputs are always object-rooted. Task definitions may
      // return an explicit non-object root (for example edit returns an
      // evidence array); the task bridge wraps those values under `result`, so
      // materialization must pin the matching wrapper schema. Ambiguous root
      // unions still require an explicit graph schema.
      if (!output) return null
      return {
        input: toObjectSchema(contract.input) ?? { type: 'object' },
        output,
      }
    },
    resolveLlmInputSchema: () => null,
    resolveLlmStructuredOpts: () => null,
  }
}

function toObjectSchema(schema: unknown): ObjectJsonSchema | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  if ((schema as { type?: unknown }).type !== 'object') return undefined
  return schema as ObjectJsonSchema
}

function toTaskGraphOutputSchema(schema: unknown): ObjectJsonSchema | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const rootType = (schema as { type?: unknown }).type
  if (rootType === 'object') return schema as ObjectJsonSchema
  if (typeof rootType !== 'string') return undefined
  return {
    type: 'object',
    properties: { result: schema as JsonObject },
    required: ['result'],
    additionalProperties: false,
  }
}

function normalizeWaitTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS)
  }
  return DEFAULT_WAIT_TIMEOUT_MS
}

/**
 * Normalize an optional create-time title: trim surrounding whitespace and
 * reject an empty normalized title, embedded CR/LF, or more than 120 UTF-16
 * code units. Returns undefined for legacy requests that omit a title, so
 * they behave exactly as before.
 */
function normalizeCreateTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new TaskGraphServiceError(
      'INVALID_TITLE',
      'TaskGraph title must be a string',
      { title: value },
    )
  }
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TaskGraphServiceError(
      'INVALID_TITLE',
      'TaskGraph title must be a non-empty string after trimming whitespace',
    )
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new TaskGraphServiceError(
      'INVALID_TITLE',
      'TaskGraph title must not contain CR or LF line breaks',
    )
  }
  if (normalized.length > 120) {
    throw new TaskGraphServiceError(
      'INVALID_TITLE',
      'TaskGraph title must not exceed 120 UTF-16 code units',
    )
  }
  return normalized
}

function buildWaitResult(
  runner: GraphRunner,
  reason: TaskGraphWaitReason,
): TaskGraphWaitResult {
  const status = runner.status()
  const waitingNodes = status.active.waiting
  return {
    taskgraph_id: status.taskgraph_id,
    state: status.state,
    reason,
    on_node_failure: status.on_node_failure ?? 'pause',
    ...(status.title ? { title: status.title } : {}),
    structure_revision: status.structure_revision,
    latest_seq: status.latest_seq,
    node_counts: status.node_counts,
    active: status.active,
    ...(status.terminal ? { terminal: status.terminal } : {}),
    ...(reason === 'waiting' && waitingNodes.length > 0
      ? { checkpoint_node_id: waitingNodes[0] }
      : {}),
  }
}

function cloneNodes(
  nodes: Record<string, TaskGraphNode>,
): Record<string, TaskGraphNode> {
  return JSON.parse(JSON.stringify(nodes)) as Record<string, TaskGraphNode>
}

function createTaskGraphId(): string {
  return `tg_${randomBytes(12).toString('hex')}`
}

function workspaceContractResolver(workspaceRoot: string): TaskGraphTaskContractResolver {
  return new WorkspaceTaskContractResolver({
    findTaskDefinition(name: string, project: string) {
      return findTaskDefinition(name, workspaceRoot, project) ?? null
    },
  })
}
