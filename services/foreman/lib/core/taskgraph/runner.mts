import type {
  TaskGraphEventsResult,
  TaskGraphNodeInspectResult,
  TaskGraphPatchResult,
  TaskGraphStatusResult,
  TaskGraphWaitReason,
} from './contracts.mts'
import type {
  EventRefs,
  EventSource,
  ExecutionError,
  PatchError,
  TaskGraphEvent,
  TaskGraphEventType,
  TaskGraphSignal,
} from './contracts.mts'
import {
  evaluateCondition,
  parseConditionParams,
} from './condition.mts'
import type {
  JsonObject,
  JsonValue,
  NodeId,
  OnNodeFailurePolicy,
  PatchOperation,
  TaskGraph,
  TaskGraphFailureCauseKind,
  TaskGraphNode,
  TaskGraphPatch,
} from './model.mts'
import {
  assembleNodeOutput,
  resolveActionTemplate,
  resolveNodeInputs,
  validateJsonObject,
  type ValueResolutionFailure,
} from './runtime-values.mts'
import { decideTaskGraphSignal } from './signals/catalog.mts'
import {
  TaskGraphStore,
  type TaskGraphProjection,
} from './store.mts'
import type {
  TaskGraphTaskBridge,
  TaskGraphTaskHandle,
  TaskGraphTaskRequest,
  TaskGraphTaskTerminal,
} from './task-bridge.mts'
import {
  validateTaskGraphPostImage,
  type FrozenDetail,
} from './validator.mts'
import type { TaskGraphAutoSchemaResolver } from './materialize.mts'
import type { TaskGraphTaskContractResolver } from './task-contract-resolver.mts'
import { isProjectInScope } from '../fwa/project-scope.mts'
import { buildTaskNodeSlip, type TaskNodeSlip } from './task-slip.mts'

export interface GraphRunnerOptions {
  taskgraphId: string
  store: TaskGraphStore
  taskBridge: TaskGraphTaskBridge
  schemaResolver: TaskGraphAutoSchemaResolver
  /** Optional task definition contract resolver for B7 payload validation. */
  contractResolver?: TaskGraphTaskContractResolver
  eventSink?: (event: TaskGraphEvent) => void | Promise<void>
  now?: () => string
  /** Optional authoritative project scope for this graph.
   *  When set, task dispatch to projects outside this scope is rejected. */
  allowedProject?: string
}

export type TaskTerminalGraphEvent = {
  kind: 'task_terminal'
  nodeId: NodeId
  taskRunId: string
  terminal: TaskGraphTaskTerminal
}

type GraphEvent =
  | { kind: 'recover' }
  | { kind: 'create'; graph: TaskGraph; onNodeFailure?: OnNodeFailurePolicy; title?: string }
  | { kind: 'signal'; signal: TaskGraphSignal }
  | { kind: 'patch_request'; patch: TaskGraphPatch }
  | { kind: 'patch_confirm'; patchId: string }
  | { kind: 'patch_reject'; patchId: string }
  | TaskTerminalGraphEvent

interface QueueEntry {
  event: GraphEvent
  resolve?: (value: unknown) => void
  reject?: (error: unknown) => void
}

export class GraphRunner {
  public readonly taskgraphId: string

  private readonly store: TaskGraphStore
  private readonly taskBridge: TaskGraphTaskBridge
  private readonly schemaResolver: TaskGraphAutoSchemaResolver
  private readonly contractResolver?: TaskGraphTaskContractResolver
  private readonly eventSink?: (event: TaskGraphEvent) => void | Promise<void>
  private readonly now: () => string
  private readonly allowedProject?: string
  private readonly queue: QueueEntry[] = []
  private pumping = false
  private pumpScheduled = false
  private idleWaiters: Array<() => void> = []
  private settleWaiters: Array<(reason: TaskGraphWaitReason) => void> = []
  private readonly observedTaskRuns = new Set<string>()

  constructor(options: GraphRunnerOptions) {
    this.taskgraphId = options.taskgraphId
    this.store = options.store
    this.taskBridge = options.taskBridge
    this.schemaResolver = options.schemaResolver
    this.contractResolver = options.contractResolver
    this.eventSink = options.eventSink
    this.now = options.now ?? (() => new Date().toISOString())
    this.allowedProject = options.allowedProject
    this.enqueue({ kind: 'recover' })
  }

  create(graph: TaskGraph, onNodeFailure?: OnNodeFailurePolicy, title?: string): Promise<TaskGraph> {
    return this.request<TaskGraph>({ kind: 'create', graph, onNodeFailure, title })
  }

  signal(signal: TaskGraphSignal): { accepted: true } {
    this.enqueue({ kind: 'signal', signal })
    return { accepted: true }
  }

  requestPatch(patch: TaskGraphPatch): Promise<TaskGraphPatchResult> {
    return this.request<TaskGraphPatchResult>({ kind: 'patch_request', patch })
  }

  confirmPatch(patchId: string): Promise<TaskGraphPatchResult> {
    return this.request<TaskGraphPatchResult>({ kind: 'patch_confirm', patchId })
  }

  rejectPatch(patchId: string): Promise<boolean> {
    return this.request<boolean>({ kind: 'patch_reject', patchId })
  }

  enqueueTaskTerminal(event: Omit<TaskTerminalGraphEvent, 'kind'>): void {
    this.enqueue({ kind: 'task_terminal', ...event })
  }

  async whenIdle(): Promise<void> {
    if (!this.pumping && !this.pumpScheduled && this.queue.length === 0) return
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  /**
   * Event-driven wait until the graph settles into a state an operator cares
   * about: done, cancelled, paused, or running with an active waiting
   * checkpoint. A just-created graph is never terminal, so it keeps waiting.
   * Returns the settle reason, or 'timeout' once timeoutMs elapses.
   */
  async waitForSettle(timeoutMs: number): Promise<TaskGraphWaitReason> {
    const existing = this.settleReason()
    if (existing) return existing
    return new Promise<TaskGraphWaitReason>((resolve) => {
      const timer = setTimeout(() => {
        this.removeSettleWaiter(onSettle)
        resolve('timeout')
      }, timeoutMs)
      const onSettle = (reason: TaskGraphWaitReason): void => {
        clearTimeout(timer)
        resolve(reason)
      }
      this.settleWaiters.push(onSettle)
      // Re-check after registration: the pump may already be mid-flight and a
      // settle could have happened between the first check and registration.
      const settled = this.settleReason()
      if (settled) {
        this.removeSettleWaiter(onSettle)
        clearTimeout(timer)
        resolve(settled)
      }
    })
  }

  private removeSettleWaiter(waiter: (reason: TaskGraphWaitReason) => void): void {
    const index = this.settleWaiters.indexOf(waiter)
    if (index >= 0) this.settleWaiters.splice(index, 1)
  }

  private settleReason(): TaskGraphWaitReason | null {
    const projection = this.store.readProjection(this.taskgraphId)
    if (!projection) return null
    if (projection.run.state === 'done') return 'done'
    if (projection.run.state === 'cancelled') return 'cancelled'
    if (projection.run.state === 'paused') return 'paused'
    const hasWaitingCheckpoint = Object.values(projection.nodeStates)
      .some((entry) => entry.state === 'waiting')
    if (hasWaitingCheckpoint) return 'waiting'
    return null
  }

  private notifySettled(): void {
    const reason = this.settleReason()
    if (!reason) return
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const waiter of waiters) waiter(reason)
  }

  status(): TaskGraphStatusResult {
    const projection = this.store.requireProjection(this.taskgraphId)
    const counts = {
      planned: 0,
      running: 0,
      waiting: 0,
      done: 0,
      failed: 0,
      interrupted: 0,
      cancelled: 0,
    }
    const active = { running: [] as NodeId[], waiting: [] as NodeId[] }
    for (const nodeId of Object.keys(projection.nodeStates).sort()) {
      const state = projection.nodeStates[nodeId].state
      counts[state] += 1
      if (state === 'running') active.running.push(nodeId)
      if (state === 'waiting') active.waiting.push(nodeId)
    }

    const result: TaskGraphStatusResult = {
      taskgraph_id: this.taskgraphId,
      state: projection.run.state,
      ...(projection.run.cancelRequested ? { cancel_requested: true as const } : {}),
      on_node_failure: projection.run.onNodeFailure,
      ...(projection.run.title ? { title: projection.run.title } : {}),
      structure_revision: projection.graph.revision,
      latest_seq: this.store.latestSequence(this.taskgraphId),
      node_counts: counts,
      active,
    }
    if (projection.run.state === 'done') {
      const end = Object.values(projection.graph.nodes)
        .find((node) => node.action.type === 'end'
          && projection.nodeStates[node.id]?.state === 'done')
      result.terminal = {
        outcome: 'done',
        ...(end && projection.nodeStates[end.id]?.output
          ? { end_output: projection.nodeStates[end.id].output }
          : {}),
      }
    } else if (projection.run.state === 'cancelled') {
      result.terminal = {
        outcome: 'cancelled',
        ...(projection.run.failureCause ? { failure: projection.run.failureCause } : {}),
      }
    }
    return result
  }

  events(afterSeq?: number, limit?: number): TaskGraphEventsResult {
    const result = this.store.listEvents(this.taskgraphId, afterSeq, limit)
    return {
      events: result.events,
      next_seq: result.nextSeq,
      latest_seq: result.latestSeq,
      has_more: result.hasMore,
    }
  }

  inspect(nodeId: NodeId): TaskGraphNodeInspectResult | undefined {
    const projection = this.store.requireProjection(this.taskgraphId)
    const node = Object.hasOwn(projection.graph.nodes, nodeId)
      ? projection.graph.nodes[nodeId]
      : undefined
    const state = Object.hasOwn(projection.nodeStates, nodeId)
      ? projection.nodeStates[nodeId]
      : undefined
    if (!node || !state) return undefined
    return {
      structure_revision: projection.graph.revision,
      node,
      run: {
        state: state.state,
        ...(state.error ? { error: state.error } : {}),
        ...(state.taskRunId ? { task_run_id: state.taskRunId } : {}),
      },
      ...(state.output ? { output: state.output } : {}),
    }
  }

  private enqueue(event: GraphEvent): void {
    this.queue.push({ event })
    this.schedulePump()
  }

  private request<TResult>(event: GraphEvent): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      this.queue.push({
        event,
        resolve: (value) => resolve(value as TResult),
        reject,
      })
      this.schedulePump()
    })
  }

  private schedulePump(): void {
    if (this.pumping || this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift() as QueueEntry
        try {
          const result = await this.handle(entry.event)
          entry.resolve?.(result)
        } catch (error) {
          entry.reject?.(error)
        }
      }
    } finally {
      this.pumping = false
      if (this.queue.length > 0) {
        this.schedulePump()
      } else {
        this.notifySettled()
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
    }
  }

  private async handle(event: GraphEvent): Promise<unknown> {
    switch (event.kind) {
      case 'recover':
        return this.handleRecover()
      case 'create':
        return this.handleCreate(event.graph, event.onNodeFailure, event.title)
      case 'signal':
        return this.handleSignal(event.signal)
      case 'patch_request':
        return this.handlePatchRequest(event.patch)
      case 'patch_confirm':
        return this.handlePatchConfirm(event.patchId)
      case 'patch_reject':
        return this.handlePatchReject(event.patchId)
      case 'task_terminal':
        return this.handleTaskTerminal(event)
    }
  }

  private async handleRecover(): Promise<void> {
    const projection = this.store.readProjection(this.taskgraphId)
    if (!projection) return
    // Repair a cancel-policy failed node persisted without cancellation
    // intent/evidence (a crash between the failed-node write and the atomic
    // cause/intent commit) BEFORE any reattach that could fail and win the
    // first-cause race: the repaired earliest cause/intent is persisted first,
    // so a secondary reattach failure can never replace it. Idempotent: once
    // intent and a cause exist, no-op; an existing cause is never replaced.
    this.store.repairCancelPolicyFailure(this.taskgraphId, this.now())
    let recoveredFailure = false
    for (const state of Object.values(projection.nodeStates)) {
      if (state.state !== 'running') continue
      if (!state.taskRunId) {
        // A persisted running node with no task run binding can never make
        // progress and must not be skipped forever or silently redispatched.
        // Fail it explicitly; the failure policy decides pause vs cancel.
        await this.failNode(state.nodeId, {
          code: 'TASK_RUN_UNBOUND',
          message: `node '${state.nodeId}' was running at restart with no task run binding`,
        }, undefined, { causeKind: 'recovery_failed', sourceKind: 'daemon' })
        recoveredFailure = true
        continue
      }
      try {
        this.observeTaskHandle(this.taskBridge.reattach(state.taskRunId), state.nodeId)
      } catch (error) {
        // Isolate reattach failures per node so a bad handle does not abort
        // recovery of sibling nodes.
        await this.failNode(state.nodeId, {
          code: 'TASK_RUN_REATTACH_FAILED',
          message: `cannot reattach task run '${state.taskRunId}': ${error instanceof Error ? error.message : String(error)}`,
        }, state.taskRunId, { causeKind: 'recovery_failed', sourceKind: 'daemon' })
        recoveredFailure = true
      }
    }
    if (recoveredFailure) return
    const repaired = this.store.requireProjection(this.taskgraphId)
    // A cancel policy may have been mid-flight at restart: the failed node and
    // cancellation intent persist but convergence did not complete. Reissue the
    // cancellation path idempotently; with no running nodes beginCancellation
    // finishes immediately, otherwise it reattaches/re-cancels and converges.
    if (repaired.run.cancelRequested) {
      await this.beginCancellation()
      return
    }
    if (repaired.run.state === 'running') await this.tick()
  }

  private async failNode(
    nodeId: NodeId,
    failure: ValueResolutionFailure | ExecutionError,
    taskRunId?: string,
    options: { causeKind?: TaskGraphFailureCauseKind; sourceKind?: 'action' | 'daemon'; pauseReason?: 'node_failed' | 'recovery_failed' } = {},
  ): Promise<void> {
    const error: ExecutionError = {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    }
    const at = this.now()
    const run = this.store.requireProjection(this.taskgraphId).run
    if (run.onNodeFailure === 'cancel') {
      // Unattended failure: atomically persist the failed node state, the
      // taskgraph.node.failed journal evidence, the first immutable failure
      // cause, and cancellation intent in one transaction before sibling
      // cancellation begins. A crash between a failed-node write and this
      // commit is repaired idempotently during recovery; later failures update
      // their own node state but never replace the first terminal cause.
      const event = this.store.failNodeForCancellation({
        taskgraphId: this.taskgraphId,
        nodeId,
        error,
        taskRunId,
        occurredAt: at,
        source: { kind: options.sourceKind ?? 'action', ...(taskRunId ? { id: taskRunId } : {}) },
        refs: { node_id: nodeId, ...(taskRunId ? { task_run_id: taskRunId } : {}) },
        data: { code: error.code, message: error.message },
        causeKind: options.causeKind,
      })
      this.projectEvent(event)
      await this.beginCancellation()
      return
    }
    this.store.putNodeState(
      this.taskgraphId,
      nodeId,
      { state: 'failed', error, output: null, taskRunId: taskRunId ?? null },
      at,
    )
    this.emit(
      'taskgraph.node.failed',
      { kind: options.sourceKind ?? 'action', ...(taskRunId ? { id: taskRunId } : {}) },
      { node_id: nodeId, ...(taskRunId ? { task_run_id: taskRunId } : {}) },
      { code: error.code, message: error.message },
    )
    if (run.state !== 'paused') {
      this.store.updateRun(this.taskgraphId, { state: 'paused' }, at)
      this.emit('taskgraph.paused', { kind: 'runner' }, { node_id: nodeId }, {
        reason: options.pauseReason ?? 'node_failed',
      })
    }
  }

  private handleCreate(graph: TaskGraph, onNodeFailure?: OnNodeFailurePolicy, title?: string): TaskGraph {
    if (this.store.has(this.taskgraphId)) {
      throw new Error(`TaskGraph '${this.taskgraphId}' already exists`)
    }
    const empty: TaskGraph = {
      id: graph.id,
      revision: graph.revision,
      ...(graph.tg_ctx ? { tg_ctx: graph.tg_ctx } : {}),
      nodes: {},
    }
    const ops: PatchOperation[] = Object.values(graph.nodes)
      .map((node) => ({ op: 'AddNode' as const, node }))
    const validated = validateTaskGraphPostImage(
      empty,
      ops,
      undefined,
      this.schemaResolver,
      this.contractResolver,
      this.allowedProject,
    )
    if (!validated.graph) {
      throw new TaskGraphValidationError(validated.issues)
    }
    validated.graph.revision = graph.revision
    const at = this.now()
    const slips = this.resolveSlipsForNodes(validated.graph.nodes)
    this.store.createProjection(validated.graph, at, this.allowedProject, onNodeFailure, title, slips)
    this.emit('taskgraph.created', { kind: 'daemon' }, undefined, {})
    return validated.graph
  }

  /**
   * Server-authored bounded slip snapshot for a single task node, resolved
   * from the current task definition at create / AddNode / ReplaceNode time.
   * Definition hot reloads never mutate an existing graph revision because
   * the snapshot is computed and persisted only when the graph structure
   * changes. Returns undefined for non-task nodes, unresolvable definitions,
   * or definitions that expose no bounded static metadata.
   */
  private slipForNode(node: TaskGraphNode): TaskNodeSlip | undefined {
    if (node.action.type !== 'task') return undefined
    if (!this.contractResolver) return undefined
    const params = node.action.params as Record<string, unknown>
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : undefined
    const project = typeof params.project === 'string' && params.project.trim() ? params.project.trim() : undefined
    if (!name || !project) return undefined
    const contract = this.contractResolver.resolveDefinitionContract('task', name, project)
    return buildTaskNodeSlip(contract)
  }

  private resolveSlipsForNodes(
    nodes: Record<NodeId, TaskGraphNode>,
  ): Record<NodeId, TaskNodeSlip> {
    const slips = Object.create(null) as Record<NodeId, TaskNodeSlip>
    for (const node of Object.values(nodes)) {
      const slip = this.slipForNode(node)
      if (slip) {
        Object.defineProperty(slips, node.id, {
          value: slip,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    return slips
  }

  private async handleSignal(signal: TaskGraphSignal): Promise<void> {
    let projection = this.store.requireProjection(this.taskgraphId)
    this.emit(
      'taskgraph.signal.received',
      { kind: 'client' },
      undefined,
      { type: signal.type },
    )
    projection = this.store.requireProjection(this.taskgraphId)
    const decision = decideTaskGraphSignal(projection, signal, {
      startInputValid: (input) => {
        const start = Object.values(projection.graph.nodes)
          .find((node) => node.action.type === 'start')
        return Boolean(start && validateJsonObject(
          start.output_schema,
          input,
          'START_INPUT_SCHEMA_MISMATCH',
        ).ok)
      },
      checkpointOutputValid: (nodeId, output) => {
        const node = projection.graph.nodes[nodeId]
        return Boolean(node && validateJsonObject(
          node.output_schema,
          output,
          'CHECKPOINT_OUTPUT_SCHEMA_MISMATCH',
        ).ok)
      },
    })

    if (decision.kind === 'ignore') {
      this.emit(
        'taskgraph.signal.ignored',
        { kind: 'runner' },
        undefined,
        { type: signal.type, reason_code: decision.reason },
      )
      return
    }

    const at = this.now()
    switch (decision.kind) {
      case 'start':
        this.store.putNodeState(
          this.taskgraphId,
          decision.startNodeId,
          { state: 'done', output: decision.input, error: null, taskRunId: null },
          at,
        )
        this.store.updateRun(
          this.taskgraphId,
          { state: 'running', cancelRequested: false },
          at,
        )
        this.emit(
          'taskgraph.started',
          { kind: 'runner' },
          { node_id: decision.startNodeId },
          {},
        )
        await this.tick()
        return

      case 'pause':
        this.store.updateRun(this.taskgraphId, { state: 'paused' }, at)
        this.emit('taskgraph.paused', { kind: 'runner' }, undefined, {})
        return

      case 'resume':
        this.store.updateRun(this.taskgraphId, { state: 'running' }, at)
        this.emit('taskgraph.resumed', { kind: 'runner' }, undefined, {})
        await this.tick()
        return

      case 'cancel':
        await this.beginCancellation()
        return

      case 'resume_checkpoint':
        this.store.putNodeState(
          this.taskgraphId,
          decision.nodeId,
          { state: 'done', output: decision.output, error: null, taskRunId: null },
          at,
        )
        this.emit(
          'taskgraph.checkpoint.resumed',
          { kind: 'runner' },
          { node_id: decision.nodeId },
          {},
        )
        if (this.store.requireProjection(this.taskgraphId).run.state === 'running') {
          await this.tick()
        }
    }
  }

  private handlePatchRequest(patch: TaskGraphPatch): TaskGraphPatchResult {
    const projection = this.store.requireProjection(this.taskgraphId)
    if (patch.base_revision !== projection.graph.revision) {
      return rejected([staleBaseError(patch.base_revision, projection.graph.revision)])
    }
    const validation = validateTaskGraphPostImage(
      projection.graph,
      patch.ops,
      nodeStateMap(projection),
      this.schemaResolver,
      this.contractResolver,
      this.allowedProject,
    )
    if (!validation.graph) return rejected(validation.issues.map(validationIssueToPatchError))

    const postGraph = validation.graph
    postGraph.revision = projection.graph.revision + 1
    const patchId = createPatchId()
    this.store.storePendingPatch({
      id: patchId,
      taskgraphId: this.taskgraphId,
      baseRevision: patch.base_revision,
      status: 'pending',
      patch,
      postGraph,
      createdAt: this.now(),
    })
    return { type: 'preview', patch_id: patchId, graph: postGraph }
  }

  private handlePatchConfirm(patchId: string): TaskGraphPatchResult {
    const stored = this.store.readPatch(patchId)
    if (!stored || stored.taskgraphId !== this.taskgraphId || stored.status !== 'pending') {
      return rejected([{
        code: 'PATCH_NOT_FOUND',
        message: `patch "${patchId}" was not found or has already been consumed`,
        details: { patch_id: patchId },
      }])
    }

    const projection = this.store.requireProjection(this.taskgraphId)
    const at = this.now()
    if (stored.baseRevision !== projection.graph.revision) {
      const errors = [staleBaseError(stored.baseRevision, projection.graph.revision, patchId)]
      this.store.consumePatch(patchId, 'rejected', at, errors)
      return rejected(errors)
    }

    const validation = validateTaskGraphPostImage(
      projection.graph,
      stored.patch.ops,
      nodeStateMap(projection),
      this.schemaResolver,
      this.contractResolver,
      this.allowedProject,
    )
    if (!validation.graph) {
      const errors = validation.issues.map(validationIssueToPatchError)
      this.store.consumePatch(patchId, 'rejected', at, errors)
      return rejected(errors)
    }

    const graph = validation.graph
    graph.revision = projection.graph.revision + 1
    this.store.transaction(() => {
      this.store.replaceGraph(graph, at)
      for (const op of stored.patch.ops) {
        if (op.op === 'RemoveNode') {
          this.store.deleteNodeState(this.taskgraphId, op.id)
        } else {
          this.store.putNodeState(
            this.taskgraphId,
            op.node.id,
            { state: 'planned', error: null, output: null, taskRunId: null },
            at,
          )
          // Server-authored slip snapshot for the (re)created node, resolved
          // from the current task definition. Cleared when the replacement no
          // longer resolves to a task definition with bounded metadata.
          this.store.putNodeSlip(this.taskgraphId, op.node.id, this.slipForNode(op.node), at)
        }
      }
      this.store.consumePatch(patchId, 'applied', at)
      this.emit(
        'taskgraph.patch.applied',
        { kind: 'runner' },
        { patch_id: patchId },
        { revision: graph.revision },
      )
    })
    return { type: 'applied', revision: graph.revision }
  }

  private handlePatchReject(patchId: string): boolean {
    const stored = this.store.readPatch(patchId)
    if (!stored || stored.taskgraphId !== this.taskgraphId || stored.status !== 'pending') return false
    return this.store.consumePatch(patchId, 'rejected', this.now())
  }

  private async handleTaskTerminal(event: TaskTerminalGraphEvent): Promise<void> {
    this.observedTaskRuns.delete(event.taskRunId)
    const projection = this.store.requireProjection(this.taskgraphId)
    const state = projection.nodeStates[event.nodeId]
    if (!state || state.state !== 'running' || state.taskRunId !== event.taskRunId) return
    // A late terminal event for an already-converged run must not re-enter the
    // failure/cancellation path or mutate immutable terminal evidence.
    if (projection.run.state === 'cancelled' || projection.run.state === 'done') return

    if (projection.run.cancelRequested) {
      this.store.putNodeState(
        this.taskgraphId,
        event.nodeId,
        { state: 'interrupted', error: null, output: null, taskRunId: event.taskRunId },
        this.now(),
      )
      this.emit(
        'taskgraph.node.interrupted',
        { kind: 'action', id: event.taskRunId },
        { node_id: event.nodeId, task_run_id: event.taskRunId },
        {},
      )
      await this.convergeCancellation()
      return
    }

    if (event.terminal.status !== 'done' || !event.terminal.output) {
      await this.failNode(event.nodeId, {
        code: 'TASK_RUN_FAILED',
        message: event.terminal.error
          ?? `Task run '${event.taskRunId}' ended as ${event.terminal.status}`,
      }, event.taskRunId)
      return
    }

    const node = projection.graph.nodes[event.nodeId]
    const output = validateJsonObject(
      node.output_schema,
      event.terminal.output,
      'OUTPUT_SCHEMA_MISMATCH',
    )
    if (!output.ok) {
      await this.failNode(event.nodeId, output.error, event.taskRunId)
      return
    }
    this.store.putNodeState(
      this.taskgraphId,
      event.nodeId,
      {
        state: 'done',
        output: event.terminal.output,
        error: null,
        taskRunId: event.taskRunId,
      },
      this.now(),
    )
    this.emit(
      'taskgraph.node.completed',
      { kind: 'action', id: event.taskRunId },
      { node_id: event.nodeId, task_run_id: event.taskRunId },
      {},
    )
    if (this.store.requireProjection(this.taskgraphId).run.state === 'running') {
      await this.tick()
    }
  }

  private async tick(): Promise<void> {
    for (;;) {
      const projection = this.store.requireProjection(this.taskgraphId)
      if (projection.run.state !== 'running' || projection.run.cancelRequested) return

      const completedEnd = findCompletedEnd(projection)
      if (completedEnd) {
        this.finishDone(completedEnd)
        return
      }

      let changed = false
      for (const nodeId of schedulingOrder(projection.graph)) {
        const fresh = this.store.requireProjection(this.taskgraphId)
        if (fresh.run.state !== 'running' || fresh.run.cancelRequested) return
        const state = fresh.nodeStates[nodeId]
        const node = fresh.graph.nodes[nodeId]
        if (!state || !node || state.state !== 'planned' || node.action.type === 'start') continue

        const depStatus = dependencyStatus(fresh, node)
        if (depStatus === 'impossible') {
          this.store.putNodeState(
            this.taskgraphId,
            nodeId,
            { state: 'cancelled', error: null, output: null, taskRunId: null },
            this.now(),
          )
          this.emit(
            'taskgraph.node.cancelled',
            { kind: 'runner' },
            { node_id: nodeId },
            { reason: 'dependency_unsatisfied' },
          )
          changed = true
          continue
        }
        if (depStatus === 'satisfied') {
          await this.activateNode(node)
          changed = true
        }
      }

      const current = this.store.requireProjection(this.taskgraphId)
      if (current.run.state !== 'running' || current.run.cancelRequested) return
      const end = findCompletedEnd(current)
      if (end) {
        this.finishDone(end)
        return
      }
      if (changed) continue

      const states = Object.values(current.nodeStates).map((entry) => entry.state)
      const active = states.some((state) => state === 'running' || state === 'waiting')
      const planned = states.some((state) => state === 'planned')
      if (!active && !planned) {
        this.finishCancelled()
      }
      return
    }
  }

  private async activateNode(node: TaskGraphNode): Promise<void> {
    const projection = this.store.requireProjection(this.taskgraphId)
    const inputs = resolveNodeInputs(projection.graph, node, projection.nodeStates)
    if (!inputs.ok) {
      await this.failNode(node.id, inputs.error)
      return
    }
    const validInput = validateJsonObject(
      node.input_schema,
      inputs.value,
      'INPUT_SCHEMA_MISMATCH',
    )
    if (!validInput.ok) {
      await this.failNode(node.id, validInput.error)
      return
    }

    if (node.action.type === 'checkpoint') {
      this.store.putNodeState(
        this.taskgraphId,
        node.id,
        { state: 'waiting', error: null, output: null, taskRunId: null },
        this.now(),
      )
      this.emit(
        'taskgraph.checkpoint.entered',
        { kind: 'runner' },
        { node_id: node.id },
        {},
      )
      return
    }

    this.store.putNodeState(
      this.taskgraphId,
      node.id,
      { state: 'running', error: null, output: null, taskRunId: null },
      this.now(),
    )
    this.emit(
      'taskgraph.node.started',
      { kind: 'runner' },
      { node_id: node.id },
      {},
    )

    switch (node.action.type) {
      case 'condition': {
        const evaluation = evaluateCondition(
          parseConditionParams(node.action.params),
          inputs.value,
        )
        await this.completeControlNode(node, {
          branch: evaluation.branch,
        }, {
          branch: evaluation.branch,
          case_index: evaluation.caseIndex === null ? -1 : evaluation.caseIndex,
        })
        return
      }

      case 'convert':
      case 'join': {
        const assembled = assembleNodeOutput(node.action.params.assemble, inputs.value)
        if (!assembled.ok) {
          await this.failNode(node.id, assembled.error)
          return
        }
        await this.completeControlNode(node, assembled.value)
        return
      }

      case 'end':
        await this.completeControlNode(node, inputs.value)
        return

      case 'task':
        await this.dispatchTask(node, inputs.value)
        return

      default:
        await this.failNode(node.id, {
          code: 'ACTION_NOT_IMPLEMENTED',
          message: `TaskGraph action "${node.action.type}" is not implemented by the MVP runner`,
        })
    }
  }

  private async completeControlNode(
    node: TaskGraphNode,
    output: JsonObject,
    eventData: JsonObject = {},
  ): Promise<void> {
    const validated = validateJsonObject(node.output_schema, output, 'OUTPUT_SCHEMA_MISMATCH')
    if (!validated.ok) {
      await this.failNode(node.id, validated.error)
      return
    }
    this.store.putNodeState(
      this.taskgraphId,
      node.id,
      { state: 'done', output, error: null, taskRunId: null },
      this.now(),
    )
    this.emit(
      'taskgraph.node.completed',
      { kind: 'runner' },
      { node_id: node.id },
      eventData,
    )
  }

  private async dispatchTask(node: TaskGraphNode, inputs: JsonObject): Promise<void> {
    const resolved = resolveActionTemplate(node.action.params, inputs)
    if (!resolved.ok || !isJsonObject(resolved.value)) {
      await this.failNode(node.id, resolved.ok
        ? { code: 'TASK_PARAMS_INVALID', message: 'task action params must resolve to an object' }
        : resolved.error)
      return
    }
    const params = resolved.value
    if (typeof params.name !== 'string' || typeof params.project !== 'string') {
      await this.failNode(node.id, {
        code: 'TASK_PARAMS_INVALID',
        message: 'task action params require string name and project fields',
      })
      return
    }
    // Enforce allowedProject if set: reject cross-scope dispatch before
    // taskBridge.start. Uses segment-safe exact-or-descendant semantics.
    if (this.allowedProject && !isProjectInScope(params.project, this.allowedProject)) {
      await this.failNode(node.id, {
        code: 'PROJECT_OUT_OF_SCOPE',
        message: `task project '${params.project}' is outside graph allowed project '${this.allowedProject}'`,
      })
      return
    }
    const taskGraphContext = this.store.requireProjection(this.taskgraphId).graph.tg_ctx
    const request: TaskGraphTaskRequest = {
      node,
      name: params.name,
      project: params.project,
      ...(typeof params.worktree === 'string' ? { worktree: params.worktree } : {}),
      input: Object.hasOwn(params, 'input') ? params.input : inputs,
      ...(taskGraphContext ? { ctx: taskGraphContext } : {}),
    }
    try {
      const handle = await this.taskBridge.start(request)
      this.store.putNodeState(
        this.taskgraphId,
        node.id,
        { state: 'running', error: null, output: null, taskRunId: handle.taskRunId },
        this.now(),
      )
      this.observeTaskHandle(handle, node.id)
    } catch (error) {
      this.enqueueTaskTerminal({
        nodeId: node.id,
        taskRunId: `dispatch:${node.id}`,
        terminal: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      })
      const current = this.store.requireProjection(this.taskgraphId).nodeStates[node.id]
      if (current?.state === 'running' && !current.taskRunId) {
        this.store.putNodeState(
          this.taskgraphId,
          node.id,
          { state: 'running', error: null, output: null, taskRunId: `dispatch:${node.id}` },
          this.now(),
        )
      }
    }
  }

  private observeTaskHandle(handle: TaskGraphTaskHandle, nodeId: NodeId): void {
    if (this.observedTaskRuns.has(handle.taskRunId)) return
    this.observedTaskRuns.add(handle.taskRunId)
    void handle.terminal.then(
      (terminal) => {
        this.enqueueTaskTerminal({ nodeId, taskRunId: handle.taskRunId, terminal })
      },
      (error: unknown) => {
        this.enqueueTaskTerminal({
          nodeId,
          taskRunId: handle.taskRunId,
          terminal: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        })
      },
    )
  }

  private async beginCancellation(): Promise<void> {
    const at = this.now()
    this.store.updateRun(this.taskgraphId, { cancelRequested: true }, at)
    const projection = this.store.requireProjection(this.taskgraphId)
    // Collect every bound running task's cancel operation so all active
    // cancellations are tracked concurrently and settle within one bound (the
    // slowest task, not the task count). The terminal observer remains the
    // idempotent node-transition authority; no node terminal state is
    // synthesized for a bound task the lower layer did not durably reconcile.
    const cancels: Promise<unknown>[] = []
    for (const nodeId of Object.keys(projection.nodeStates).sort()) {
      const state = projection.nodeStates[nodeId]
      if (state.state === 'planned' || state.state === 'waiting') {
        this.store.putNodeState(
          this.taskgraphId,
          nodeId,
          { state: 'cancelled', error: null, output: null, taskRunId: null },
          at,
        )
        this.emit(
          'taskgraph.node.cancelled',
          { kind: 'runner' },
          { node_id: nodeId },
          { reason: 'graph_cancel_requested' },
        )
      } else if (state.state === 'running' && state.taskRunId) {
        cancels.push(this.taskBridge.cancel(state.taskRunId).catch(() => {
          // The terminal observer remains authoritative. A failed cancellation
          // request must not drop the eventual task terminal graph event.
        }))
      } else if (state.state === 'running') {
        this.store.putNodeState(
          this.taskgraphId,
          nodeId,
          { state: 'interrupted', error: null, output: null, taskRunId: null },
          at,
        )
        this.emit(
          'taskgraph.node.interrupted',
          { kind: 'runner' },
          { node_id: nodeId },
          {},
        )
      }
    }
    if (cancels.length > 0) await Promise.allSettled(cancels)
    await this.convergeCancellation()
  }

  private async convergeCancellation(): Promise<void> {
    const projection = this.store.requireProjection(this.taskgraphId)
    if (!projection.run.cancelRequested) return
    if (Object.values(projection.nodeStates).some((state) => state.state === 'running')) return
    this.finishCancelled()
  }

  private finishDone(endNodeId: NodeId): void {
    const projection = this.store.requireProjection(this.taskgraphId)
    if (projection.run.state === 'done') return
    const at = this.now()
    this.store.updateRun(
      this.taskgraphId,
      { state: 'done', cancelRequested: false, endedAt: at },
      at,
    )
    this.emit(
      'taskgraph.done',
      { kind: 'runner' },
      { node_id: endNodeId },
      {},
    )
  }

  private finishCancelled(): void {
    const projection = this.store.requireProjection(this.taskgraphId)
    if (projection.run.state === 'cancelled') return
    const at = this.now()
    this.store.updateRun(
      this.taskgraphId,
      { state: 'cancelled', cancelRequested: false, endedAt: at },
      at,
    )
    this.emit('taskgraph.cancelled', { kind: 'runner' }, undefined, {})
  }

  private emit(
    type: TaskGraphEventType,
    source: EventSource,
    refs: EventRefs | undefined,
    data: JsonObject,
  ): TaskGraphEvent {
    const revision = this.store.requireProjection(this.taskgraphId).graph.revision
    const event = this.store.appendJournal({
      taskgraphId: this.taskgraphId,
      type,
      occurredAt: this.now(),
      structureRevision: revision,
      source,
      ...(refs ? { refs } : {}),
      data,
    })
    this.projectEvent(event)
    return event
  }

  private projectEvent(event: TaskGraphEvent): void {
    if (this.eventSink && shouldProjectGlobally(event.type)) {
      void Promise.resolve(this.eventSink(event)).catch(() => {
        // The TaskGraph journal is the SSOT. Global event projection failure
        // must not corrupt or roll back the graph projection.
      })
    }
  }
}

export class TaskGraphValidationError extends Error {
  readonly issues: FrozenDetail[]

  constructor(issues: FrozenDetail[]) {
    super('TaskGraph validation failed')
    this.name = 'TaskGraphValidationError'
    this.issues = issues
  }
}

function dependencyStatus(
  projection: TaskGraphProjection,
  consumer: TaskGraphNode,
): 'satisfied' | 'waiting' | 'impossible' {
  let waiting = false
  for (const depId of consumer.deps) {
    const dep = projection.graph.nodes[depId]
    const state = projection.nodeStates[depId]
    if (!dep || !state) return 'impossible'
    if (dep.action.type === 'condition') {
      if (state.state === 'done') {
        if (state.output?.branch !== consumer.id) return 'impossible'
        continue
      }
    } else if (state.state === 'done') {
      continue
    }
    if (state.state === 'planned' || state.state === 'running' || state.state === 'waiting') {
      waiting = true
      continue
    }
    return 'impossible'
  }
  return waiting ? 'waiting' : 'satisfied'
}

function schedulingOrder(graph: TaskGraph): NodeId[] {
  const order: NodeId[] = []
  const visited = new Set<NodeId>()
  const visit = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    const node = graph.nodes[nodeId]
    if (!node) return
    for (const depId of node.deps) visit(depId)
    order.push(nodeId)
  }
  const endIds = Object.values(graph.nodes)
    .filter((node) => node.action.type === 'end')
    .map((node) => node.id)
    .sort()
  for (const nodeId of endIds) visit(nodeId)
  for (const nodeId of Object.keys(graph.nodes).sort()) visit(nodeId)
  return order
}

function findCompletedEnd(projection: TaskGraphProjection): NodeId | undefined {
  return Object.values(projection.graph.nodes)
    .filter((node) => node.action.type === 'end')
    .map((node) => node.id)
    .sort()
    .find((nodeId) => projection.nodeStates[nodeId]?.state === 'done')
}

function nodeStateMap(projection: TaskGraphProjection): Record<NodeId, TaskGraphProjection['nodeStates'][NodeId]['state']> {
  const states = Object.create(null) as Record<NodeId, TaskGraphProjection['nodeStates'][NodeId]['state']>
  for (const [nodeId, state] of Object.entries(projection.nodeStates)) {
    Object.defineProperty(states, nodeId, {
      value: state.state,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return states
}

function validationIssueToPatchError(issue: FrozenDetail): PatchError {
  let details: JsonObject
  if (issue.category === 'op') {
    details = {
      op_index: issue.op_index,
      node_id: issue.node_id,
    }
  } else if (issue.category === 'wiring') {
    details = {
      node_id: issue.node_id,
      slot: issue.slot,
    }
  } else {
    details = { node_ids: issue.node_ids }
  }
  return { code: issue.code, message: issue.message, details }
}

function staleBaseError(baseRevision: number, currentRevision: number, patchId?: string): PatchError {
  return {
    code: 'STALE_BASE',
    message: `base revision ${baseRevision} does not match current revision ${currentRevision}`,
    details: {
      base_revision: baseRevision,
      current_revision: currentRevision,
      ...(patchId ? { patch_id: patchId } : {}),
    },
  }
}

function rejected(errors: PatchError[]): TaskGraphPatchResult {
  return { type: 'rejected', errors }
}

function createPatchId(): string {
  return `tgp_${cryptoRandomHex()}`
}

function cryptoRandomHex(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '')
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shouldProjectGlobally(type: TaskGraphEventType): boolean {
  return type === 'taskgraph.created'
    || type === 'taskgraph.started'
    || type === 'taskgraph.paused'
    || type === 'taskgraph.resumed'
    || type === 'taskgraph.done'
    || type === 'taskgraph.cancelled'
    || type === 'taskgraph.checkpoint.entered'
    || type === 'taskgraph.node.failed'
}
