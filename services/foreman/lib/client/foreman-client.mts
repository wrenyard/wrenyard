import type {
  ActivitySnapshotParams,
  ActivitySnapshotV1,
  DaemonDrainParams,
  DaemonDrainResult,
  DaemonFreezeParams,
  DaemonFreezeResult,
  DaemonShutdownParams,
  DaemonShutdownResult,
  DaemonStatusParams,
  DaemonStatusResult,
  DaemonThawParams,
  DaemonThawResult,
  HealthPingParams,
  HealthPingResult,
  EventListParams,
  EventListResult,
  MessageSendParams,
  MessageSendResult,
  ProjectDescribeParams,
  ProjectDescribeResult,
  ProjectListParams,
  ProjectListResult,
  ProjectPullParams,
  ProjectPullResult,
  ProjectPushParams,
  ProjectPushResult,
  ProjectStatusParams,
  ProjectStatusResult,
  ProjectWorktreeCreateParams,
  ProjectWorktreeCreateResult,
  ProjectWorktreeListParams,
  ProjectWorktreeListResult,
  ProjectWorktreeMergeParams,
  ProjectWorktreeMergeResult,
  ProjectWorktreeRemoveParams,
  ProjectWorktreeRemoveResult,
  StatsTodayParams,
  StatsTodayResult,
  StatsSummaryParams,
  StatsSummaryResult,
  TaskDefinitionDescribeParams,
  TaskDefinitionDescribeResult,
  TaskDefinitionListParams,
  TaskDefinitionListResult,
  TaskRunCancelParams,
  TaskRunCancelResult,
  TaskRunCreateParams,
  TaskRunCreateResult,
  TaskRunEventsParams,
  TaskRunEventsResult,
  TaskRunListParams,
  TaskRunListResult,
  TaskRunOutputParams,
  TaskRunOutputResult,
  TaskRunStatusParams,
  TaskRunStatusResult,
  TaskGraphCreateParams,
  TaskGraphCreateResult,
  TaskGraphListParams,
  TaskGraphListResult,
  TaskGraphPatchParams,
  TaskGraphPatchResult,
  TaskGraphStatusParams,
  TaskGraphStatusResult,
  TaskGraphEventsParams,
  TaskGraphEventsResult,
  TaskGraphSignalParams,
  TaskGraphSignalResult,
  TaskGraphNodeInspectParams,
  TaskGraphNodeInspectResult,
  TaskGraphInspectParams,
  TaskGraphInspectResult,
  TaskGraphWaitParams,
  TaskGraphWaitResult,
  TaskGraphSlipParams,
  TaskGraphSlipResult,
  ClientConfigurationSnapshotParams,
  ClientConfigurationSnapshotResult,
  ClientConfigurationPlanParams,
  ClientConfigurationPlanResult,
  ClientConfigurationApplyParams,
  ClientConfigurationApplyResult,
  ClientConfigurationPlanRestoreParams,
  ClientConfigurationPlanRestoreResult,
  ClientConfigurationRestoreParams,
  ClientConfigurationRestoreResult,
} from '../protocol/registry.mts'

export interface ForemanRequestOptions {
  /** Per-request deadline override in ms, or null to disable the client timer. */
  timeoutMs?: number | null
}

export interface ForemanClientRpc {
  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: ForemanRequestOptions,
  ): Promise<TResult>
  close(error?: Error): void
  dispose(error?: Error): void
}

export interface ForemanClientTransportLifecycle {
  close?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface ForemanClientOptions {
  transport?: ForemanClientTransportLifecycle
}

/** Server-side wait defaults mirrored from TaskGraphService (lib/core/taskgraph/service.mts). */
const WAIT_REQUEST_DEFAULT_TIMEOUT_MS = 60_000
const WAIT_REQUEST_MAX_TIMEOUT_MS = 600_000

/** Buffer on top of timeout_ms so the client deadline never truncates the server's bounded wait. */
const WAIT_REQUEST_TIMEOUT_MARGIN_MS = 5_000

/**
 * Mirror TaskGraphService.normalizeWaitTimeout so the request deadline always
 * covers the effective server wait, even for omitted or oversized timeout_ms,
 * instead of falling back to the short JSON-RPC default deadline.
 */
function normalizeWaitTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), WAIT_REQUEST_MAX_TIMEOUT_MS)
  }
  return WAIT_REQUEST_DEFAULT_TIMEOUT_MS
}

/** Params for the event-driven `task.run.wait` RPC. Mirrors the shared server
 * contract: await one task run until it reaches a terminal status and return
 * the full TaskRunOutputResult. */
export interface TaskRunWaitParams {
  task_run_id: string
  /** Optional server-side bounded wait ceiling in milliseconds. */
  timeout_ms?: number
}

export class ForemanClient {
  private readonly rpc: ForemanClientRpc
  private readonly transport?: ForemanClientTransportLifecycle

  readonly daemon = {
    shutdown: (params: DaemonShutdownParams = {}): Promise<DaemonShutdownResult> => {
      return this.rpc.request<DaemonShutdownResult>('daemon.shutdown', params)
    },
    freeze: (params: DaemonFreezeParams = {}): Promise<DaemonFreezeResult> => {
      return this.rpc.request<DaemonFreezeResult>('daemon.freeze', params)
    },
    thaw: (params: DaemonThawParams = {}): Promise<DaemonThawResult> => {
      return this.rpc.request<DaemonThawResult>('daemon.thaw', params)
    },
    drain: (params: DaemonDrainParams = {}): Promise<DaemonDrainResult> => {
      return this.rpc.request<DaemonDrainResult>('daemon.drain', params)
    },
    status: (params: DaemonStatusParams = {}): Promise<DaemonStatusResult> => {
      return this.rpc.request<DaemonStatusResult>('daemon.status', params)
    },
  }

  readonly health = {
    ping: (params: HealthPingParams = {}): Promise<HealthPingResult> => {
      return this.rpc.request<HealthPingResult>('health.ping', params)
    },
  }

  readonly event = {
    list: (params: EventListParams = {}): Promise<EventListResult> => {
      return this.rpc.request<EventListResult>('event.list', params)
    },
  }

  readonly activity = {
    snapshot: (params: ActivitySnapshotParams = {}): Promise<ActivitySnapshotV1> => {
      return this.rpc.request<ActivitySnapshotV1>('activity.snapshot', params)
    },
  }

  readonly clientConfiguration = {
    snapshot: (params: ClientConfigurationSnapshotParams = {}): Promise<ClientConfigurationSnapshotResult> => {
      return this.rpc.request<ClientConfigurationSnapshotResult>('client.configuration.snapshot', params)
    },
    plan: (params: ClientConfigurationPlanParams): Promise<ClientConfigurationPlanResult> => {
      return this.rpc.request<ClientConfigurationPlanResult>('client.configuration.plan', params)
    },
    apply: (params: ClientConfigurationApplyParams): Promise<ClientConfigurationApplyResult> => {
      return this.rpc.request<ClientConfigurationApplyResult>('client.configuration.apply', params)
    },
    planRestore: (params: ClientConfigurationPlanRestoreParams): Promise<ClientConfigurationPlanRestoreResult> => {
      return this.rpc.request<ClientConfigurationPlanRestoreResult>('client.configuration.plan-restore', params)
    },
    restore: (params: ClientConfigurationRestoreParams): Promise<ClientConfigurationRestoreResult> => {
      return this.rpc.request<ClientConfigurationRestoreResult>('client.configuration.restore', params)
    },
  }

  readonly stats = {
    today: (params: StatsTodayParams = {}): Promise<StatsTodayResult> => {
      return this.rpc.request<StatsTodayResult>('stats.today', params)
    },
    summary: (params: StatsSummaryParams = {}): Promise<StatsSummaryResult> => {
      return this.rpc.request<StatsSummaryResult>('stats.summary', params)
    },
  }

  readonly task = {
    definition: {
      list: (params: TaskDefinitionListParams = {}): Promise<TaskDefinitionListResult> => {
        return this.rpc.request<TaskDefinitionListResult>('task.definition.list', params)
      },
      describe: (params: TaskDefinitionDescribeParams): Promise<TaskDefinitionDescribeResult> => {
        return this.rpc.request<TaskDefinitionDescribeResult>('task.definition.describe', params)
      },
    },
    run: {
      create: (params: TaskRunCreateParams): Promise<TaskRunCreateResult> => {
        return this.rpc.request<TaskRunCreateResult>('task.run.create', params)
      },
      list: (params: TaskRunListParams = {}): Promise<TaskRunListResult> => {
        return this.rpc.request<TaskRunListResult>('task.run.list', params)
      },
      status: (params: TaskRunStatusParams): Promise<TaskRunStatusResult> => {
        return this.rpc.request<TaskRunStatusResult>('task.run.status', params)
      },
      output: (params: TaskRunOutputParams): Promise<TaskRunOutputResult> => {
        return this.rpc.request<TaskRunOutputResult>('task.run.output', params)
      },
      cancel: (params: TaskRunCancelParams): Promise<TaskRunCancelResult> => {
        return this.rpc.request<TaskRunCancelResult>('task.run.cancel', params)
      },
      events: (params: TaskRunEventsParams): Promise<TaskRunEventsResult> => {
        return this.rpc.request<TaskRunEventsResult>('task.run.events', params)
      },
      wait: (params: TaskRunWaitParams): Promise<TaskRunOutputResult> => {
        // When the caller omits a server timeout, pass timeoutMs:null so a
        // legitimate long task has no transport deadline (it crosses the
        // normal 30s/10min RPC boundaries). When explicit, set the transport
        // deadline to the server timeout plus the margin so it is never
        // truncated, and preserve the server timeout param unchanged.
        const options = params.timeout_ms === undefined
          ? { timeoutMs: null }
          : { timeoutMs: params.timeout_ms + WAIT_REQUEST_TIMEOUT_MARGIN_MS }
        return this.rpc.request<TaskRunOutputResult>(
          'task.run.wait',
          params,
          options,
        )
      },
    },
  }

  readonly message = {
    send: (params: MessageSendParams): Promise<MessageSendResult> => {
      return this.rpc.request<MessageSendResult>('message.send', params)
    },
  }

  readonly project = {
    list: (params: ProjectListParams = {}): Promise<ProjectListResult> => {
      return this.rpc.request<ProjectListResult>('project.list', params)
    },
    describe: (params: ProjectDescribeParams): Promise<ProjectDescribeResult> => {
      return this.rpc.request<ProjectDescribeResult>('project.describe', params)
    },
    status: (params: ProjectStatusParams = {}): Promise<ProjectStatusResult> => {
      return this.rpc.request<ProjectStatusResult>('project.status', params)
    },
    pull: (params: ProjectPullParams): Promise<ProjectPullResult> => {
      return this.rpc.request<ProjectPullResult>('project.pull', params)
    },
    push: (params: ProjectPushParams): Promise<ProjectPushResult> => {
      return this.rpc.request<ProjectPushResult>('project.push', params)
    },
    worktree: {
      list: (params: ProjectWorktreeListParams): Promise<ProjectWorktreeListResult> => {
        return this.rpc.request<ProjectWorktreeListResult>('project.worktree.list', params)
      },
      create: (params: ProjectWorktreeCreateParams): Promise<ProjectWorktreeCreateResult> => {
        return this.rpc.request<ProjectWorktreeCreateResult>('project.worktree.create', params)
      },
      remove: (params: ProjectWorktreeRemoveParams): Promise<ProjectWorktreeRemoveResult> => {
        return this.rpc.request<ProjectWorktreeRemoveResult>('project.worktree.remove', params)
      },
      merge: (params: ProjectWorktreeMergeParams): Promise<ProjectWorktreeMergeResult> => {
        return this.rpc.request<ProjectWorktreeMergeResult>('project.worktree.merge', params)
      },
    },
  }

  readonly taskgraph = {
    create: (params: TaskGraphCreateParams): Promise<TaskGraphCreateResult> => {
      return this.rpc.request<TaskGraphCreateResult>('taskgraph.create', params)
    },
    patch: (params: TaskGraphPatchParams): Promise<TaskGraphPatchResult> => {
      return this.rpc.request<TaskGraphPatchResult>('taskgraph.patch', params)
    },
    status: (params: TaskGraphStatusParams): Promise<TaskGraphStatusResult> => {
      return this.rpc.request<TaskGraphStatusResult>('taskgraph.status', params)
    },
    events: (params: TaskGraphEventsParams): Promise<TaskGraphEventsResult> => {
      return this.rpc.request<TaskGraphEventsResult>('taskgraph.events', params)
    },
    signal: (params: TaskGraphSignalParams): Promise<TaskGraphSignalResult> => {
      return this.rpc.request<TaskGraphSignalResult>('taskgraph.signal', params)
    },
    node: {
      inspect: (params: TaskGraphNodeInspectParams): Promise<TaskGraphNodeInspectResult> => {
        return this.rpc.request<TaskGraphNodeInspectResult>('taskgraph.node.inspect', params)
      },
    },
    inspect: (params: TaskGraphInspectParams): Promise<TaskGraphInspectResult> => {
      return this.rpc.request<TaskGraphInspectResult>('taskgraph.inspect', params)
    },
    list: (params: TaskGraphListParams = {}): Promise<TaskGraphListResult> => {
      return this.rpc.request<TaskGraphListResult>('taskgraph.list', params)
    },
    wait: (params: TaskGraphWaitParams): Promise<TaskGraphWaitResult> => {
      // Normalize the effective server wait (default 60000, max 600000) and
      // set the transport request deadline to that wait plus the margin so
      // omitted, invalid, or oversized timeout_ms never hit the short RPC
      // default deadline (30000 ms).
      const effectiveWaitMs = normalizeWaitTimeout(params.timeout_ms)
      return this.rpc.request<TaskGraphWaitResult>(
        'taskgraph.wait',
        params,
        { timeoutMs: effectiveWaitMs + WAIT_REQUEST_TIMEOUT_MARGIN_MS },
      )
    },
    slip: (params: TaskGraphSlipParams): Promise<TaskGraphSlipResult> => {
      return this.rpc.request<TaskGraphSlipResult>('taskgraph.slip', params)
    },
  }

  constructor(rpc: ForemanClientRpc, options: ForemanClientOptions = {}) {
    this.rpc = rpc
    this.transport = options.transport
  }

  close(error = new Error('ForemanClient closed')): void {
    this.rpc.close(error)
    void this.transport?.close?.()
  }

  dispose(error = new Error('ForemanClient disposed')): void {
    this.rpc.dispose(error)
    void this.transport?.dispose?.()
  }
}
