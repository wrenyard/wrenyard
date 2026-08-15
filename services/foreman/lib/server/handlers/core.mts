import type { MessageService, SendAttachmentResult } from '../../message/message-service.mts'
import type { MessageSender } from '../../message/protocol.mts'
import type { OperationHost } from '../../core/operations/types.mts'
import { TaskService, TaskServiceError } from '../../core/task/service.mts'
import { ActivitySnapshotError, buildActivitySnapshot } from '../../core/activity/index.mts'
import { listDbEvents } from '../../events/event-query.mts'
import { readTodayStats, readStatsSummary } from '../../events/stats-query.mts'
import type { StatsSummaryResult } from '../../protocol/registry.mts'
import type { ForemanPetService } from '../../pet/pet-service.mts'
import { createPmTicketCommandsForWorkspace } from '../../daemon/services/pm-ticket-service.mts'
import { createTaskGraphService } from '../../daemon/services/taskgraph-service.mts'
import { PmError } from '../../core/pm/index.mts'
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
import type { AttachmentResultItem } from '../../protocol/methods/message.mts'
import type {
  ActivitySnapshotV1,
  MessageSendResult,
  DaemonDrainResult,
  DaemonFreezeResult,
  DaemonShutdownResult,
  DaemonStatusResult,
  DaemonThawResult,
  PetControlResult,
  PetStatusResult,
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
} from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'
import { registerProjectHandlers } from './project.mts'
import { registerFwaHandlers, type FwaHandlerService } from './fwa.mts'
import { registerWorkspaceDocHandlers, type WorkspaceDocHandlerService } from './workspace-doc.mts'
import type { AgentSyncParams, AgentCompactParams, AgentGraphReviewParams } from '../../protocol/methods/agent.mts'
import type { AgentListResult } from '../../protocol/methods/agent.mts'
import type {
  PmTicketCreateResult,
  PmTicketGetResult,
  PmTicketListResult,
  PmTicketUpdateResult,
  PmTicketDeleteResult,
} from '../../protocol/registry.mts'
import {
  DAEMON_DRAIN_DEFAULT_TIMEOUT_MS,
} from '../../protocol/methods/daemon.mts'
import { DispatchControl, DispatchControlError, type DispatchStatus } from '../../daemon/dispatch-control.mts'

export interface CoreRpcHandlerOptions {
  startedAt: number
  workspaceRoot: string
  operations?: OperationHost
  petService?: Pick<ForemanPetService, 'start' | 'stop' | 'restart' | 'status'>
  shutdown?: (reason: string) => void | Promise<void>
  dispatchControl?: DispatchControl
  fwaService?: FwaHandlerService
  /** Daemon-owned TaskGraphService shared with FWA. When provided it replaces the lazy fallback. */
  taskgraphService?: TaskGraphService
  /** Unified MessageService for principal-based message.send */
  messageService?: import('../../message/message-service.mts').MessageService
  /** Agent handler service for agent.* RPC methods (available only after batch 2). */
  agentService?: AgentHandlerService
  /** Workspace doc service for workspace.doc.* RPC methods. */
  workspaceDocService?: WorkspaceDocHandlerService
}

export interface AgentHandlerService {
  list(): Promise<AgentListResult>
  sync(params: AgentSyncParams): Promise<unknown>
  compact(params: AgentCompactParams): Promise<unknown>
  graphReview(params: AgentGraphReviewParams): Promise<unknown>
  modelList(): Promise<unknown>
  modelSet(params: import('../../protocol/methods/agent.mts').AgentModelSetParams): Promise<unknown>
}

export interface DelegationAdmissionDescriptor {
  address: string
  turn_seq: number
  delegation_id: string
  tool_name: string
  input: Record<string, unknown>
}

export type CoreRpcTransport = 'ipc' | 'http' | 'mcp'

export interface CoreRpcContext {
  transport?: CoreRpcTransport
  connectingId?: string
  sender?: MessageSender
  /** Internal-only delegation admission descriptor. Never accepted from external JSON-RPC params. */
  delegationAdmission?: DelegationAdmissionDescriptor
}

export function registerCoreHandlers(router: RpcRouter, options: CoreRpcHandlerOptions): void {
  const taskService = new TaskService({ workspaceRoot: options.workspaceRoot, operations: options.operations })
  let taskgraphService: TaskGraphService | undefined
  const getTaskGraphService = (): TaskGraphService => {
    // When the daemon wires its own single TaskGraphService, use it directly
    // so FWA and RPC share one instance and events flow through the bus.
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
    }
    if (options.dispatchControl) {
      result.dispatch = projectDispatchStatus(options.dispatchControl.status())
    }
    return result
  })
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
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Invalid days: ${days}. Must be an integer between 1 and 31.` },
        { param: 'days', value: days },
      )
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Invalid limit: ${limit}. Must be an integer between 1 and 50.` },
        { param: 'limit', value: limit },
      )
    }
    return readStatsSummary({ days, limit }) satisfies StatsSummaryResult
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
        delegationAdmission: rpcContext.delegationAdmission,
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
      ...(params.attachments ? { attachments: params.attachments as Array<{ path: string }> } : {}),
    })
    if ("ok" in result) {
      return {
        accepted: false,
        message_id: '',
        error: result.error,
        message: result.message,
      } satisfies MessageSendResult
    }
    const rawAttachments = result.attachments ?? []
    return {
      accepted: result.accepted,
      message_id: result.message_id,
      ...(result.target_seq !== undefined ? { target_seq: result.target_seq } : {}),
      ...(result.queue_depth !== undefined ? { queue_depth: result.queue_depth } : {}),
      ...(result.delivery ? { delivery: result.delivery } : {}),
      ...(rawAttachments.length > 0 ? { attachments: rawAttachments.map(projectAttachmentItem) } : {}),
    } satisfies MessageSendResult
  })

  const petService = options.petService
  if (petService) {
    router.register('pet.status', async () => {
      return petService.status() as PetStatusResult
    })
    router.register('pet.start', async () => {
      await petService.start({ persist: true })
      return {
        ok: true,
        status: petService.status(),
      } satisfies PetControlResult
    })
    router.register('pet.stop', async () => {
      await petService.stop({ persist: true })
      return {
        ok: true,
        status: petService.status(),
      } satisfies PetControlResult
    })
    router.register('pet.restart', async () => {
      await petService.restart({ persist: true })
      return {
        ok: true,
        status: petService.status(),
      } satisfies PetControlResult
    })
  }

  // --- PM ticket commands ---
  let pmCommands: ReturnType<typeof createPmTicketCommandsForWorkspace> | undefined
  const getPmCommands = (): ReturnType<typeof createPmTicketCommandsForWorkspace> => {
    pmCommands ??= createPmTicketCommandsForWorkspace(options.workspaceRoot)
    return pmCommands
  }

  async function pmJsonResult<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof PmError) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: error.message },
          {
            service: 'pm',
            code: error.code,
            statusCode: error.statusCode,
            details: error.details,
          },
        )
      }
      throw error
    }
  }

  router.register('pm.ticket.create', async (params) => {
    return pmJsonResult<PmTicketCreateResult>(async () => {
      const ticket = await getPmCommands().create(params)
      return { ticket }
    })
  })
  router.register('pm.ticket.get', async (params) => {
    return pmJsonResult<PmTicketGetResult>(async () => {
      const ticket = await getPmCommands().get(params)
      return { ticket }
    })
  })
  router.register('pm.ticket.list', async (params) => {
    return pmJsonResult<PmTicketListResult>(async () => {
      const tickets = await getPmCommands().list(params)
      return { tickets, count: tickets.length }
    })
  })
  router.register('pm.ticket.update', async (params) => {
    return pmJsonResult<PmTicketUpdateResult>(async () => {
      const ticket = await getPmCommands().update(params)
      return { ticket }
    })
  })
  router.register('pm.ticket.delete', async (params) => {
    return pmJsonResult<PmTicketDeleteResult>(async () => {
      const { deleted, id } = await getPmCommands().delete(params)
      return { deleted: true as const, id }
    })
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

  // Register FWA protocol handlers for both backends; when no native FWA service
  // is configured, methods return a clear FWA_NOT_CONFIGURED error.
  registerFwaHandlers(
    router,
    options.fwaService,
    (context) => coreRpcContextFromUnknown(context).delegationAdmission,
  )

  // Register agent.* handlers. When no agent service is configured, they fail explicitly.
  registerAgentHandlers(router, options.agentService)
}

function coreRpcContextFromUnknown(value: unknown): CoreRpcContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as { transport?: unknown; connectingId?: unknown; sender?: unknown; delegationAdmission?: unknown }
  return {
    ...(isCoreRpcTransport(record.transport) ? { transport: record.transport } : {}),
    ...(typeof record.connectingId === 'string' && record.connectingId.trim()
      ? { connectingId: record.connectingId.trim() }
      : {}),
    ...(isSender(record.sender) ? { sender: record.sender } : {}),
    ...(isDelegationAdmission(record.delegationAdmission) ? { delegationAdmission: record.delegationAdmission } : {}),
  }
}

function isDelegationAdmission(value: unknown): value is DelegationAdmissionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const d = value as Record<string, unknown>
  return typeof d.address === 'string'
    && typeof d.turn_seq === 'number'
    && typeof d.delegation_id === 'string'
    && typeof d.tool_name === 'string'
    && typeof d.input === 'object'
    && d.input !== null
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

function registerAgentHandlers(router: RpcRouter, agentService: AgentHandlerService | undefined): void {
  if (!agentService) {
    const unavailable = () => {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'agent service not available in this runtime' },
        { service: 'agent', code: 'agent_unavailable' },
      )
    }
  router.register('agent.list', asRpcHandler(unavailable))
    router.register('agent.sync', asRpcHandler(unavailable))
    router.register('agent.compact', asRpcHandler(unavailable))
    router.register('agent.graph.review', asRpcHandler(unavailable))
    router.register('agent.model.list', asRpcHandler(unavailable))
    router.register('agent.model.set', asRpcHandler(unavailable))
    return
  }

  router.register('agent.list', asRpcHandler(async () => agentService.list()))
  router.register('agent.sync', asRpcHandler(async (params: AgentSyncParams) => agentService.sync(params)))
  router.register('agent.compact', asRpcHandler(async (params: AgentCompactParams) => agentService.compact(params)))
  router.register('agent.graph.review', asRpcHandler(async (params: AgentGraphReviewParams) => agentService.graphReview(params)))
  router.register('agent.model.list', asRpcHandler(async () => agentService.modelList()))
  router.register('agent.model.set', asRpcHandler(async (params: import('../../protocol/methods/agent.mts').AgentModelSetParams) => agentService.modelSet(params)))
}

type AttachmentErrorCode = NonNullable<AttachmentResultItem['error']>

function normalizeAttachmentError(raw: string | undefined): AttachmentErrorCode | undefined {
  if (raw === undefined) return undefined
  // Exhaustive switch — the compiler warns when a new code is added to AttachmentErrorCode
  switch (raw) {
    case 'file_not_found': return raw
    case 'invalid_path': return raw
    case 'not_regular_file': return raw
    case 'too_large': return raw
    case 'unsupported_content_type': return raw
    case 'read_failed': return raw
    default: return undefined
  }
}

function projectAttachmentItem(raw: SendAttachmentResult): AttachmentResultItem {
  const item: AttachmentResultItem = {
    path: raw.path,
    status: raw.status,
  }
  if (raw.mime_type !== undefined) item.mime_type = raw.mime_type
  if (raw.size !== undefined) item.size = raw.size
  if (raw.sha256 !== undefined) item.sha256 = raw.sha256
  if (raw.storage_ref !== undefined) item.storage_ref = raw.storage_ref
  const normError = normalizeAttachmentError(raw.error)
  if (normError !== undefined) item.error = normError
  return item
}

function toJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Widen a handler function to RpcHandler to bypass strict typed-router overload checks. */
function asRpcHandler<TParams, TResult>(fn: (params: TParams) => TResult | Promise<TResult>): (params: unknown) => TResult | Promise<TResult> {
  return fn as unknown as (params: unknown) => TResult | Promise<TResult>
}
