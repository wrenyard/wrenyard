import type { MessageService } from '../../message/message-service.mts'
import type { MessageSender } from '../../message/protocol.mts'
import type { OperationHost } from '../../core/operations/types.mts'
import { TaskService, TaskServiceError } from '../../core/task/service.mts'
import { ActivitySnapshotError, buildActivitySnapshot } from '../../core/activity/index.mts'
import { listDbEvents } from '../../events/event-query.mts'
import { readTodayStats, readStatsSummary } from '../../events/stats-query.mts'
import type { StatsSummaryResult } from '../../protocol/registry.mts'
import { MAX_STATS_SUMMARY_DAYS } from '../../protocol/methods/stats.mts'
import { createTaskGraphService } from '../../daemon/services/taskgraph-service.mts'
import {
  TaskGraphService,
  TaskGraphServiceError,
  TaskGraphTemplateError,
  toServiceCreateParams,
  type TaskGraphEvent,
} from '../../core/taskgraph/index.mts'
import { appendForemanEvent } from '../../events/event-store.mts'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  ProtocolError,
  TASK_NOT_FOUND,
  type ProtocolErrorCode,
} from '../../protocol/errors.mts'
import type {
  ActivitySnapshotV1,
  MessageSendResult,
  DaemonDrainResult,
  DaemonFreezeResult,
  DaemonShutdownResult,
  DaemonStatusResult,
  DaemonThawResult,
  EventListResult,
  StatsTodayResult,
  TaskRunCancelResult,
  TaskRunCreateResult,
  TaskRunEventsResult,
  TaskRunListResult,
  TaskRunOutputResult,
  TaskRunStatusResult,
  TaskGraphCreateResult,
  TaskGraphEventsResult,
  TaskGraphInspectResult,
  TaskGraphListResult,
  TaskGraphNodeInspectResult,
  TaskGraphPatchResult,
  TaskGraphSignalResult,
  TaskGraphStatusResult,
  TaskGraphWaitResult,
  TaskGraphSlipResult,
  GatewayConnectionResult,
  ClientConfigurationSnapshotResult,
} from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { registerProjectHandlers } from './project.mts'
import { registerWorkspaceDocHandlers, type WorkspaceDocHandlerService } from './workspace-doc.mts'
import {
  DAEMON_DRAIN_DEFAULT_TIMEOUT_MS,
} from '../../protocol/methods/daemon.mts'
import { DispatchControl, DispatchControlError, type DispatchStatus } from '../../daemon/dispatch-control.mts'
import {
  TaskSettingsContentConflictError,
  TaskSettingsInvalidSettingsError,
  TaskSettingsRuntimeUnavailableError,
  TaskSettingsService,
  TaskSettingsTaskNotFoundError,
} from '../../daemon/services/task-settings-service.mts'
import {
  AliasInvalidTargetError,
  AliasNotFoundError,
  RuntimeAliasService,
} from '../../daemon/services/runtime-alias-service.mts'
import {
  AliasValidationError,
  MalformedStoreError,
  RevisionConflictError,
} from '../../runtime-aliases/store.mts'

export interface CoreRpcHandlerOptions {
  startedAt: number
  workspaceRoot: string
  operations?: OperationHost
  shutdown?: (reason: string) => void | Promise<void>
  dispatchControl?: DispatchControl
  /** Daemon-owned TaskGraphService shared by all transports. */
  taskgraphService?: TaskGraphService
  /** Unified MessageService for principal-based message.send */
  messageService?: import('../../message/message-service.mts').MessageService
  /** Workspace doc service for workspace.doc.* RPC methods. */
  workspaceDocService?: WorkspaceDocHandlerService
  /** IPC-only model Gateway connection descriptor for local clients. */
  gatewayConnection?: () => Promise<GatewayConnectionResult>
  /** Daemon-owned TaskSettingsService backing task.settings.snapshot/save. */
  taskSettings?: TaskSettingsService
  /** Daemon-owned RuntimeAliasService backing runtime.alias.snapshot/put/remove. */
  runtimeAlias?: RuntimeAliasService
  /**
   * Daemon-owned exact current-Catalog display-name lookup used to label recent
   * stats.summary task-run rows. Optional: contexts without it emit rows
   * without the additive paired display-name fields.
   */
  resolveTaskRunDisplayNames?: import('../../events/stats-query.mts').TaskRunDisplayNameResolver
  providerList?: () => Promise<import('../../protocol/methods/provider.mts').ProviderListResult>
  providerConfigure?: (params: import('../../protocol/methods/provider.mts').ProviderConfigureParams) => Promise<import('../../protocol/methods/provider.mts').ProviderConfigureResult>
  clientConfiguration?: {
    snapshot(): Promise<ClientConfigurationSnapshotResult>
    plan(params: import('../../protocol/methods/client-configuration.mts').ClientConfigurationPlanParams): Promise<import('../../protocol/methods/client-configuration.mts').ClientConfigurationPlanResult>
    apply(params: import('../../protocol/methods/client-configuration.mts').ClientConfigurationApplyParams): Promise<import('../../protocol/methods/client-configuration.mts').ClientConfigurationApplyResult>
    planRestore(params: import('../../protocol/methods/client-configuration.mts').ClientConfigurationPlanRestoreParams): Promise<import('../../protocol/methods/client-configuration.mts').ClientConfigurationPlanRestoreResult>
    restore(params: import('../../protocol/methods/client-configuration.mts').ClientConfigurationRestoreParams): Promise<import('../../protocol/methods/client-configuration.mts').ClientConfigurationRestoreResult>
  }
}

export type CoreRpcTransport = 'ipc' | 'http' | 'mcp'

export interface CoreRpcContext {
  transport?: CoreRpcTransport
  connectingId?: string
  sender?: MessageSender
}

export function registerCoreHandlers(router: RpcRouter, options: CoreRpcHandlerOptions): void {
  const taskService = new TaskService({ workspaceRoot: options.workspaceRoot, operations: options.operations })
  let taskgraphService: TaskGraphService | undefined
  const getTaskGraphService = (): TaskGraphService => {
    // When the daemon wires its own single TaskGraphService, use it directly
    // so every transport shares one instance and events flow through the bus.
    if (options.taskgraphService) return options.taskgraphService
    // Lazy fallback for tests/contexts that do not provide one.
    taskgraphService ??= createTaskGraphService({
      workspaceRoot: options.workspaceRoot,
      operations: options.operations,
      eventSink: projectTaskGraphEvent,
    })
    return taskgraphService
  }

  router.register('health.ping', async () => {
    const result: {
      ok: true
      uptimeMs: number
      dispatch?: {
        mode: 'accepting' | 'frozen' | 'planned_restart'
        frozen: boolean
        accepting: boolean
        activeTaskCount: number
        activeWorkflowCount: number
        activeExecutionCount: number
        active_task_count: number
        active_workflow_count: number
        active_execution_count: number
        recovery_required: boolean
        operation_id?: string
        kind?: 'update' | 'restart'
        phase?: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
      }
    } = {
      ok: true as const,
      uptimeMs: Math.max(0, Date.now() - options.startedAt),
      ...(options.gatewayConnection ? { gateway: { status: 'ready' as const } } : {}),
    }
    if (options.dispatchControl) {
      result.dispatch = projectDispatchStatus(options.dispatchControl.status())
    }
    return result
  })
  if (options.gatewayConnection) {
    router.register('gateway.connection', async (_params, _message, context) => {
      const rpcContext = coreRpcContextFromUnknown(context)
      if (rpcContext.transport !== 'ipc') {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: 'gateway.connection is only available over IPC' },
          { code: 'gateway_connection_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
        )
      }
      return options.gatewayConnection!()
    })
  }
  if (options.providerList && options.providerConfigure) {
    router.register('provider.list', async (_params, _message, context) => {
      const rpcContext = coreRpcContextFromUnknown(context)
      if (rpcContext.transport !== 'ipc') {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: 'provider.list is only available over IPC' },
          { code: 'provider_list_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
        )
      }
      return options.providerList!()
    })
    router.register('provider.configure', async (params, _message, context) => {
      const rpcContext = coreRpcContextFromUnknown(context)
      if (rpcContext.transport !== 'ipc') {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: 'provider.configure is only available over IPC' },
          { code: 'provider_configure_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
        )
      }
      return options.providerConfigure!(params)
    })
  }
  if (options.clientConfiguration) {
    const requireClientConfigurationIpc = (context: unknown, method: string): void => {
      const rpcContext = coreRpcContextFromUnknown(context)
      if (rpcContext.transport !== 'ipc') {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
          { code: 'client_configuration_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
        )
      }
    }
    const callClientConfiguration = async <T,>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        throw new ProtocolError(
          {
            code: INVALID_PARAMS.code,
            message: error instanceof Error ? error.message : 'Client configuration request rejected',
          },
          { code: 'client_configuration_rejected' },
        )
      }
    }
    router.register('client.configuration.snapshot', async (_params, _message, context) => {
      requireClientConfigurationIpc(context, 'client.configuration.snapshot')
      return options.clientConfiguration!.snapshot()
    })
    router.register('client.configuration.plan', async (params, _message, context) => {
      requireClientConfigurationIpc(context, 'client.configuration.plan')
      return callClientConfiguration(() => options.clientConfiguration!.plan(params))
    })
    router.register('client.configuration.apply', async (params, _message, context) => {
      requireClientConfigurationIpc(context, 'client.configuration.apply')
      return callClientConfiguration(() => options.clientConfiguration!.apply(params))
    })
    router.register('client.configuration.plan-restore', async (params, _message, context) => {
      requireClientConfigurationIpc(context, 'client.configuration.plan-restore')
      return callClientConfiguration(() => options.clientConfiguration!.planRestore(params))
    })
    router.register('client.configuration.restore', async (params, _message, context) => {
      requireClientConfigurationIpc(context, 'client.configuration.restore')
      return callClientConfiguration(() => options.clientConfiguration!.restore(params))
    })
  }
  router.register('event.list', (params) => {
    const since = params.since ?? 0
    const limit = params.limit ?? 100
    const events = listDbEvents(since, limit)
    const lastEvent = events.at(-1)
    return {
      events,
      count: events.length,
      cursor: typeof lastEvent?.id === 'number' ? lastEvent.id : since,
    } satisfies EventListResult
  })
  router.register('stats.today', () => {
    return readTodayStats() satisfies StatsTodayResult
  })
  router.register('stats.summary', (params) => {
    const days = typeof params.days === 'number' ? params.days : 7
    const limit = typeof params.limit === 'number' ? params.limit : 20
    if (!Number.isInteger(days) || days < 1 || days > MAX_STATS_SUMMARY_DAYS) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Invalid days: ${days}. Must be an integer between 1 and ${MAX_STATS_SUMMARY_DAYS}.` },
        { param: 'days', value: days },
      )
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Invalid limit: ${limit}. Must be an integer between 1 and 50.` },
        { param: 'limit', value: limit },
      )
    }
    return readStatsSummary(
      { days, limit },
      new Date(),
      options.resolveTaskRunDisplayNames ? { resolveDisplayNames: options.resolveTaskRunDisplayNames } : undefined,
    ) satisfies StatsSummaryResult
  })
  router.register('daemon.shutdown', (params, _message, context) => {
    const rpcContext = coreRpcContextFromUnknown(context)
    if (rpcContext.transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'daemon.shutdown is only available over IPC' },
        {
          code: 'daemon_shutdown_forbidden',
          statusCode: 403,
          transport: rpcContext.transport ?? 'unknown',
        },
      )
    }
    if (!options.shutdown) {
      throw new ProtocolError(
        { code: INTERNAL_ERROR.code, message: 'daemon.shutdown is not available in this runtime' },
        { code: 'daemon_shutdown_unavailable' },
      )
    }
    const reason = typeof params.reason === 'string' && params.reason.trim()
      ? params.reason.trim()
      : 'daemon.shutdown'
    scheduleShutdown(options.shutdown, reason)
    return {
      ok: true,
      shutting_down: true,
      reason,
    } satisfies DaemonShutdownResult
  })
  if (options.dispatchControl) {
    router.register('daemon.freeze', async () => {
      options.dispatchControl!.freeze()
      const status = options.dispatchControl!.status()
      return {
        ok: true as const,
        ...projectDispatchStatus(status),
      } satisfies DaemonFreezeResult
    })
    router.register('daemon.thaw', async () => {
      options.dispatchControl!.thaw()
      const status = options.dispatchControl!.status()
      return {
        ok: true as const,
        frozen: status.frozen,
        accepting: status.accepting,
        activeTasks: status.activeTasks,
        activeTaskCount: status.activeTaskCount,
        activeWorkflows: status.activeWorkflows,
        activeWorkflowCount: status.activeWorkflowCount,
        activeExecutions: status.activeExecutions,
        activeExecutionCount: status.activeExecutionCount,
      } satisfies DaemonThawResult
    })
    router.register('daemon.drain', async (params) => {
      const timeoutMs = typeof params.timeout_ms === 'number' && params.timeout_ms >= 1 && params.timeout_ms <= 300_000
        ? params.timeout_ms
        : DAEMON_DRAIN_DEFAULT_TIMEOUT_MS
      const result = await options.dispatchControl!.drain(timeoutMs)
      return result satisfies DaemonDrainResult
    })
    router.register('daemon.status', async () => {
      const status = options.dispatchControl!.status()
      return {
        ok: true as const,
        ...projectDispatchStatus(status),
      } satisfies DaemonStatusResult
    })
  }
  router.register('task.definition.list', async (params) => {
    return serviceJsonResult(
      () => taskService.list(params.project),
    )
  })
  router.register('task.definition.describe', async (params) => {
    return serviceJsonResult(
      () => taskService.describe(params.task_id, params.project),
    )
  })
  // task.settings.snapshot/save delegate to the injected daemon-owned
  // TaskSettingsService; the RPC surface never recreates selection or config
  // mutation logic. IPC-only. When the dependency is absent the methods fail
  // loud with a bounded unavailable error instead of being silently dropped.
  const requireTaskSettings = (
    context: unknown,
    method: string,
  ): TaskSettingsService => {
    const rpcContext = coreRpcContextFromUnknown(context)
    if (rpcContext.transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'task_settings_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
      )
    }
    if (!options.taskSettings) {
      throw new ProtocolError(
        { code: INTERNAL_ERROR.code, message: `${method} is not available in this runtime` },
        { code: 'task_settings_unavailable' },
      )
    }
    return options.taskSettings
  }
  router.register('task.settings.snapshot', async (params, _message, context) => {
    const service = requireTaskSettings(context, 'task.settings.snapshot')
    return service.snapshot(params)
  })
  router.register('task.settings.save', async (params, _message, context) => {
    const service = requireTaskSettings(context, 'task.settings.save')
    try {
      return await service.save(params)
    } catch (error) {
      if (
        error instanceof TaskSettingsContentConflictError
        || error instanceof TaskSettingsTaskNotFoundError
        || error instanceof TaskSettingsInvalidSettingsError
        || error instanceof TaskSettingsRuntimeUnavailableError
      ) {
        throw protocolErrorFromTaskSettingsError(error)
      }
      throw error
    }
  })
  // runtime.alias.snapshot/put/remove delegate to the injected daemon-owned
  // RuntimeAliasService; the RPC surface never recreates store or resolution
  // logic. IPC-only. When the dependency is absent the methods fail loud with a
  // bounded unavailable error instead of being silently dropped.
  const requireRuntimeAliasService = (
    context: unknown,
    method: string,
  ): RuntimeAliasService => {
    const rpcContext = coreRpcContextFromUnknown(context)
    if (rpcContext.transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
        { code: 'runtime_alias_forbidden', statusCode: 403, transport: rpcContext.transport ?? 'unknown' },
      )
    }
    if (!options.runtimeAlias) {
      throw new ProtocolError(
        { code: INTERNAL_ERROR.code, message: `${method} is not available in this runtime` },
        { code: 'runtime_alias_unavailable' },
      )
    }
    return options.runtimeAlias
  }
  const callRuntimeAliasService = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw protocolErrorFromRuntimeAliasError(error)
    }
  }
  router.register('runtime.alias.snapshot', async (_params, _message, context) => {
    const service = requireRuntimeAliasService(context, 'runtime.alias.snapshot')
    return callRuntimeAliasService(() => service.snapshot())
  })
  router.register('runtime.alias.put', async (params, _message, context) => {
    const service = requireRuntimeAliasService(context, 'runtime.alias.put')
    return callRuntimeAliasService(() => service.put(params))
  })
  router.register('runtime.alias.remove', async (params, _message, context) => {
    const service = requireRuntimeAliasService(context, 'runtime.alias.remove')
    return callRuntimeAliasService(() => service.remove(params))
  })
  router.register('task.run.create', async (params, _message, context) => {
    if (options.dispatchControl) assertDispatchAccepting(options.dispatchControl)
    const rpcContext = coreRpcContextFromUnknown(context)
    return serviceJsonResult<TaskRunCreateResult>(
      () => taskService.run({
        taskId: params.task_id,
        project: params.project,
        worktree: params.worktree,
        input: params.input,
        ctx: params.ctx as import('../../core/task/context.mts').TaskContext | undefined,
        connectingId: rpcContext.connectingId,
        invocationSettings: params.invocation_settings,
      }),
    )
  })
  router.register('task.run.list', () => {
    return taskService.activeRuns() satisfies TaskRunListResult
  })
  router.register('task.run.status', (params) => {
    return serviceRunResult<TaskRunStatusResult>(
      taskService.status(params.task_run_id),
      () => taskRunNotFound(params.task_run_id),
    )
  })
  router.register('task.run.output', (params) => {
    return serviceRunResult<TaskRunOutputResult>(
      taskService.output(params.task_run_id),
      () => taskRunNotFound(params.task_run_id),
    )
  })
  router.register('task.run.cancel', async (params) => {
    try {
      return await serviceJsonResult<TaskRunCancelResult>(
        () => taskService.cancel(params.task_run_id),
      )
    } catch (error) {
      if (isTaskRunNotFoundError(error, params.task_run_id)) throw taskRunNotFound(params.task_run_id)
      throw error
    }
  })
  router.register('task.run.wait', async (params, _message, context) => {
    // Pass through TaskService.wait: it resolves only on the authoritative task
    // terminal and never returns a nonterminal TaskRunOutputResult. Explicit
    // timeout/abort/service failures surface as TaskServiceError control errors
    // (re-thrown by serviceJsonResult) rather than being normalized into success.
    // If the transport exposes a disconnect/abort signal it is forwarded below.
    const signal = context && typeof context === 'object' && 'signal' in context
      ? (context as { signal?: AbortSignal }).signal
      : undefined
    return serviceJsonResult<TaskRunOutputResult>(() =>
      taskService.wait(params.task_run_id, params.timeout_ms, signal),
    )
  })
  router.register('task.run.events', async (params) => {
    return serviceJsonResult<TaskRunEventsResult>(
      () => taskService.taskRunEvents({
        taskRunId: params.task_run_id,
        afterSeq: params.after_seq,
        limit: params.limit,
      }),
    )
  })
  router.register('activity.snapshot', (params) => {
    return activitySnapshotResult<ActivitySnapshotV1>(() =>
      buildActivitySnapshot({
        trackedTaskgraphIds: params.tracked_taskgraph_ids,
      }),
    )
  })

  registerProjectHandlers(router, {
    workspaceRoot: options.workspaceRoot,
  })

  registerWorkspaceDocHandlers(router, options.workspaceDocService)

  router.register('message.send', async (params, _message, context) => {
    // Check whether raw RPC context owns a sender property
    const rawContext = (context && typeof context === 'object' && !Array.isArray(context)
      ? context as Record<string, unknown>
      : {})
    const contextHasSender = 'sender' in rawContext
    const rpcContext = coreRpcContextFromUnknown(context)

    const from: string | undefined = (() => {
      if (contextHasSender) {
        // Context sender is authoritative — must be valid
        if (rpcContext.sender && rpcContext.sender.role?.trim()) {
          return rpcContext.sender.role.trim()
        }
        // Context has sender but it's invalid — reject, do NOT fallback to params
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: 'message.send requires a valid sender in context' },
          { code: 'context_sender_required' },
        )
      }
      // No context sender — IPC/CLI callers may supply sender via params
      const senderRaw: string | undefined = typeof params.sender === 'string'
        ? params.sender
        : params.sender && typeof params.sender === 'object' && typeof params.sender.role === 'string'
          ? params.sender.role
          : undefined
      return senderRaw
    })()
    if (!from) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'message.send requires a from principal' },
        { code: 'sender_required' },
      )
    }
    if (!options.messageService) {
      throw new ProtocolError(
        { code: INTERNAL_ERROR.code, message: 'message service is not configured' },
        { code: 'message_service_unavailable' },
      )
    }
    const result = await options.messageService.send({
      from,
      to: params.to,
      text: params.text,
      ...(params.client_message_id ? { client_message_id: params.client_message_id } : {}),
    })
    if ("ok" in result) {
      return {
        accepted: false,
        message_id: '',
        error: result.error,
        message: result.message,
      } satisfies MessageSendResult
    }
    return {
      accepted: result.accepted,
      message_id: result.message_id,
      ...(result.target_seq !== undefined ? { target_seq: result.target_seq } : {}),
      ...(result.queue_depth !== undefined ? { queue_depth: result.queue_depth } : {}),
      ...(result.delivery ? { delivery: result.delivery } : {}),
    } satisfies MessageSendResult
  })

  router.register('taskgraph.create', async (params) => {
    return taskgraphResult<TaskGraphCreateResult>(async () => {
      try {
        return await getTaskGraphService().create(
          toServiceCreateParams(params as Parameters<typeof toServiceCreateParams>[0]),
        ) as unknown as TaskGraphCreateResult
      } catch (error) {
        if (error instanceof TaskGraphTemplateError) {
          throw new TaskGraphServiceError('INVALID_GRAPH', error.message)
        }
        throw error
      }
    })
  })
  router.register('taskgraph.patch', async (params) => {
    return taskgraphResult<TaskGraphPatchResult>(async () =>
      await getTaskGraphService().patch(params as unknown as Parameters<TaskGraphService['patch']>[0]) as unknown as TaskGraphPatchResult,
    )
  })
  router.register('taskgraph.status', (params) => {
    return taskgraphResult<TaskGraphStatusResult>(() =>
      getTaskGraphService().status(params as unknown as Parameters<TaskGraphService['status']>[0]) as unknown as TaskGraphStatusResult,
    )
  })
  router.register('taskgraph.events', (params) => {
    return taskgraphResult<TaskGraphEventsResult>(() =>
      getTaskGraphService().events(params as unknown as Parameters<TaskGraphService['events']>[0]) as unknown as TaskGraphEventsResult,
    )
  })
  router.register('taskgraph.signal', (params) => {
    return taskgraphResult<TaskGraphSignalResult>(() =>
      getTaskGraphService().signal(params as unknown as Parameters<TaskGraphService['signal']>[0]) as unknown as TaskGraphSignalResult,
    )
  })
  router.register('taskgraph.node.inspect', (params) => {
    return taskgraphResult<TaskGraphNodeInspectResult>(() =>
      getTaskGraphService().inspect(params as unknown as Parameters<TaskGraphService['inspect']>[0]) as unknown as TaskGraphNodeInspectResult,
    )
  })
  router.register('taskgraph.inspect', (params) => {
    return taskgraphResult<TaskGraphInspectResult>(() =>
      getTaskGraphService().inspectGraph(params as unknown as Parameters<TaskGraphService['inspectGraph']>[0]) as unknown as TaskGraphInspectResult,
    )
  })
  router.register('taskgraph.list', (params) => {
    return taskgraphResult<TaskGraphListResult>(() =>
      getTaskGraphService().list(params as unknown as Parameters<TaskGraphService['list']>[0]) as unknown as TaskGraphListResult,
    )
  })
  router.register('taskgraph.wait', async (params) => {
    return taskgraphResult<TaskGraphWaitResult>(async () =>
      await getTaskGraphService().wait(params as unknown as Parameters<TaskGraphService['wait']>[0]) as unknown as TaskGraphWaitResult,
    )
  })
  router.register('taskgraph.slip', (params) => {
    return taskgraphResult<TaskGraphSlipResult>(() =>
      getTaskGraphService().slip(params as unknown as Parameters<TaskGraphService['slip']>[0]),
    )
  })

}

function coreRpcContextFromUnknown(value: unknown): CoreRpcContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as { transport?: unknown; connectingId?: unknown; sender?: unknown }
  return {
    ...(isCoreRpcTransport(record.transport) ? { transport: record.transport } : {}),
    ...(typeof record.connectingId === 'string' && record.connectingId.trim()
      ? { connectingId: record.connectingId.trim() }
      : {}),
    ...(isSender(record.sender) ? { sender: record.sender } : {}),
  }
}

function isCoreRpcTransport(value: unknown): value is CoreRpcTransport {
  return value === 'ipc' || value === 'http' || value === 'mcp'
}

function scheduleShutdown(
  shutdown: (reason: string) => void | Promise<void>,
  reason: string,
): void {
  const immediate = setImmediate(() => {
    void Promise.resolve(shutdown(reason)).catch((error: unknown) => {
      process.stderr.write(`[foreman] daemon.shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  })
  immediate.unref()
}

function isSender(value: unknown): value is MessageSender {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { role?: unknown }).role === 'string'
    && Boolean((value as { role: string }).role.trim())
}

function senderFromRpc(sender: string | { role: string; [key: string]: unknown }): MessageSender {
  if (typeof sender === 'string') return { role: sender }
  return sender
}

function serviceRunResult<T>(
  result: unknown | null,
  notFound: () => ProtocolError,
): T {
  if (result === null) throw notFound()
  return toJsonShape(result) as T
}

async function serviceJsonResult<T>(
  operation: () => Promise<unknown>,
): Promise<T> {
  try {
    return toJsonShape(await operation()) as T
  } catch (error) {
    if (error instanceof TaskServiceError) {
      throw protocolErrorFromTaskServiceError(error)
    }
    throw error
  }
}

function activitySnapshotResult<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof ActivitySnapshotError) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: error.message },
        { service: 'activity', code: error.code },
      )
    }
    throw error
  }
}

async function taskgraphResult<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof TaskGraphServiceError) {
      throw new ProtocolError(
        {
          code: error.code === 'TASKGRAPH_NOT_FOUND' || error.code === 'NODE_NOT_FOUND'
            ? TASK_NOT_FOUND.code
            : INVALID_PARAMS.code,
          message: error.message,
        },
        toJsonShape({
          service: 'taskgraph',
          code: error.code,
          details: error.details,
        }),
      )
    }
    throw error
  }
}

async function projectTaskGraphEvent(event: TaskGraphEvent): Promise<void> {
  await appendForemanEvent({
    id: event.event_id,
    kind: event.type,
    source: 'foreman.taskgraph',
    severity: event.type === 'taskgraph.node.failed'
      ? 'error'
      : event.type === 'taskgraph.done'
        ? 'success'
        : event.type === 'taskgraph.paused'
          ? 'warning'
          : 'info',
    refs: {
      taskgraphId: event.taskgraph_id,
      ...(event.refs?.task_run_id ? { taskRunId: event.refs.task_run_id } : {}),
    },
    data: {
      seq: event.seq,
      structure_revision: event.structure_revision,
      ...(event.refs ? { refs: event.refs } : {}),
      ...event.data,
    },
    occurredAt: event.occurred_at,
  })
}

function protocolErrorFromTaskServiceError(error: TaskServiceError): ProtocolError {
  if (error.code === 'task_not_found') {
    return serviceProtocolError(TASK_NOT_FOUND.code, error, 'task')
  }
  return serviceProtocolError(protocolCodeForServiceStatus(error.statusCode), error, 'task')
}

function protocolErrorFromTaskSettingsError(
  error:
    | TaskSettingsContentConflictError
    | TaskSettingsTaskNotFoundError
    | TaskSettingsInvalidSettingsError
    | TaskSettingsRuntimeUnavailableError,
): ProtocolError {
  if (error instanceof TaskSettingsTaskNotFoundError) {
    return new ProtocolError(
      { code: TASK_NOT_FOUND.code, message: error.message },
      { service: 'task.settings', code: error.code },
    )
  }
  const detail: Record<string, unknown> = { service: 'task.settings', code: error.code }
  if (error instanceof TaskSettingsContentConflictError) {
    detail.expected_revision = error.expectedRevision
    detail.actual_revision = error.actualRevision
  } else if (error instanceof TaskSettingsRuntimeUnavailableError) {
    detail.task_id = error.taskId
    detail.runtime = error.runtime
    detail.reason = error.reason
  } else {
    detail.detail = error.detail
  }
  return new ProtocolError(
    { code: INVALID_PARAMS.code, message: error.message },
    detail,
  )
}

function protocolErrorFromRuntimeAliasError(error: unknown): ProtocolError {
  if (error instanceof RevisionConflictError) {
    return new ProtocolError(
      { code: INVALID_PARAMS.code, message: error.message },
      {
        service: 'runtime.alias',
        code: 'revision_conflict',
        expected_revision: error.expectedRevision,
        actual_revision: error.actualRevision,
      },
    )
  }
  if (error instanceof AliasValidationError) {
    return new ProtocolError(
      { code: INVALID_PARAMS.code, message: error.message },
      { service: 'runtime.alias', code: 'alias_validation_error' },
    )
  }
  if (error instanceof MalformedStoreError) {
    return new ProtocolError(
      { code: INTERNAL_ERROR.code, message: error.message },
      { service: 'runtime.alias', code: 'malformed_store', reason: error.reason },
    )
  }
  if (error instanceof AliasNotFoundError) {
    return new ProtocolError(
      { code: INVALID_PARAMS.code, message: error.message },
      { service: 'runtime.alias', code: error.code, alias: error.aliasName },
    )
  }
  if (error instanceof AliasInvalidTargetError) {
    return new ProtocolError(
      { code: INVALID_PARAMS.code, message: error.message },
      { service: 'runtime.alias', code: error.code, target: error.target },
    )
  }
  throw error
}

function taskRunNotFound(taskRunId: string): ProtocolError {
  return new ProtocolError(
    { code: TASK_NOT_FOUND.code, message: `Task run '${taskRunId}' not found` },
    {
      service: 'task',
      code: 'task_run_not_found',
      task_run_id: taskRunId,
    },
  )
}

function isTaskRunNotFoundError(error: unknown, taskRunId: string): boolean {
  return error instanceof Error && error.message === `Task run '${taskRunId}' not found`
}

function protocolCodeForServiceStatus(statusCode: number): ProtocolErrorCode {
  return statusCode >= 500 ? INTERNAL_ERROR.code : INVALID_PARAMS.code
}

function serviceProtocolError(
  code: ProtocolErrorCode,
  error: TaskServiceError,
  service: 'task',
): ProtocolError {
  return new ProtocolError({ code, message: error.message }, toJsonShape({
    service,
    code: error.code,
    statusCode: error.statusCode,
    details: error.details,
  }))
}

function assertDispatchAccepting(control: DispatchControl): void {
  try {
    control.assertAccepting()
  } catch (error) {
    if (error instanceof DispatchControlError) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: error.message },
        { code: error.code },
      )
    }
    throw error
  }
}

/**
 * Single projection of DispatchControl.status() shared by daemon.status and the
 * optional health.ping dispatch summary. Adds the durable plan fields and the
 * snake-case active counts while retaining the legacy frozen/accepting/active
 * arrays and camel-case counts for old clients.
 */
function projectDispatchStatus(status: DispatchStatus): {
  mode: DispatchStatus['mode']
  frozen: boolean
  accepting: boolean
  activeTasks: string[]
  activeTaskCount: number
  activeWorkflows: string[]
  activeWorkflowCount: number
  activeExecutions: string[]
  activeExecutionCount: number
  active_task_count: number
  active_workflow_count: number
  active_execution_count: number
  recovery_required: boolean
  operation_id?: string
  kind?: 'update' | 'restart'
  phase?: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
} {
  const plan = status.plannedRestart
  return {
    mode: status.mode,
    frozen: status.frozen,
    accepting: status.accepting,
    activeTasks: status.activeTasks,
    activeTaskCount: status.activeTaskCount,
    activeWorkflows: status.activeWorkflows,
    activeWorkflowCount: status.activeWorkflowCount,
    activeExecutions: status.activeExecutions,
    activeExecutionCount: status.activeExecutionCount,
    active_task_count: status.activeTaskCount,
    active_workflow_count: status.activeWorkflowCount,
    active_execution_count: status.activeExecutionCount,
    recovery_required: plan ? plan.recoveryRequired : false,
    ...(plan
      ? {
        operation_id: plan.operationId,
        kind: plan.kind,
        phase: plan.phase,
      }
      : {}),
  }
}

function toJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Widen a handler function to RpcHandler to bypass strict typed-router overload checks. */
function asRpcHandler<TParams, TResult>(fn: (params: TParams) => TResult | Promise<TResult>): (params: unknown) => TResult | Promise<TResult> {
  return fn as unknown as (params: unknown) => TResult | Promise<TResult>
}
