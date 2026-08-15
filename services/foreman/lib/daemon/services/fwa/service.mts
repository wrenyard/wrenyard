/**
 * In-daemon native FWA service/registry.
 * A real durable ticket-bound orchestrator using in-process services
 * and truthful workspace operations, with no stubs or dropped turns.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDb } from '../../../db/connection.mts'
import { ForemanEventBus, getForemanEventBus } from '../../../events/event-bus.mts'
import type { ForemanEvent, ForemanEventSink } from '../../../events/event-types.mts'
import { FwaSessionStore } from '../../../core/fwa/session-store.mts'
import { FWARuntime, type PersistCallbacks } from '../../../core/fwa/runtime.mts'
import { ForgeChatModel, type ForgeChatModelConfig, type RawForgeExecutor } from '../../../core/fwa/forge-chat-model.mts'
import { AgentEventStore } from '../../../core/agent/agent-event-store.mts'
import { AgentGraphProjector } from '../../../core/agent/agent-graph-projector.mts'
import { createAllFwaTools, type ToolPorts } from '../../../core/fwa/tools.mts'
import type { FwaSession, FwaSessionStatus, FwaNativeConfig, TaskGraphPort, TaskServicePort, MessagePort, WorkspaceDocPort, FwaInspectableStatus, FwaInspectableQueue, FwaTranscriptEntry } from '../../../core/fwa/types.mts'
import type { MessageService } from '../../../message/message-service.mts'
import { TaskGraphService, TaskGraphTemplateError, toServiceCreateParams } from '../../../core/taskgraph/index.mts'
import { TaskService } from '../../../core/task/service.mts'
import { sessionIdToAddress } from '../../../message/address.mts'
import { createWorkspaceDocPort } from './workspace-doc-port.mts'
import type { DelegationAdmissionDescriptor } from '../../../server/handlers/core.mts'

export interface FwaServiceOptions {
  config: FwaNativeConfig
  messageService: MessageService
  taskgraphService: TaskGraphService
  store: FwaSessionStore
  rawExecutor: RawForgeExecutor
  taskService: TaskService
  workspaceRoot: string
  agentEventStore: AgentEventStore
}

export interface FwaAssignParams {
  ticket_id: string
  project_id: string
  prompt: string
}

export interface FwaServiceSession {
  sessionId: string
  runtime: FWARuntime
  ticket_id: string
  project_id: string
}

export class FwaService implements ForemanEventSink {
  private readonly config: FwaNativeConfig
  private readonly messageService: MessageService
  private readonly taskgraphService: TaskGraphService
  private readonly store: FwaSessionStore
  private readonly rawExecutor: RawForgeExecutor
  private readonly taskService: TaskService
  private readonly workspaceRoot: string
  private readonly agentEventStore: AgentEventStore
  private readonly graphProjector: AgentGraphProjector
  private readonly sessions = new Map<string, FwaServiceSession>()
  private readonly unsubscribe: () => void
  private readonly RECONCILE_PAGE_SIZE = 100
  private closed = false

  constructor(options: FwaServiceOptions) {
    this.config = options.config
    this.messageService = options.messageService
    this.taskgraphService = options.taskgraphService
    this.store = options.store
    this.rawExecutor = options.rawExecutor
    this.taskService = options.taskService
    this.workspaceRoot = options.workspaceRoot
    this.agentEventStore = options.agentEventStore
    this.graphProjector = new AgentGraphProjector(this.agentEventStore)

    // Collect all non-closed sessions
    const nonClosedRecords = this.store.listNonClosedSessions()
    for (const record of nonClosedRecords) {
      const address = sessionIdToAddress(record.id)

      // Ensure conversation exists in agent_event store
      this.agentEventStore.createOrGetConversation({
        address,
        kind: 'fwa',
        model: this.config.llm.model,
      })

      this.hydrateSession(address, record)
    }

    this.unsubscribe = getForemanEventBus().subscribe(this)
  }

  /**
   * After recovery, enqueue all queued agent_turn rows for this address
   * FIFO so the runtime can claim and process them. Skips turns that were
   * already recovered (running→queued) since recoverStaleTurns already
   * reset them; those will be picked up by claimNextTurn.
   */
  private hydrateSession(
    address: string,
    record: ReturnType<FwaSessionStore['listNonClosedSessions']>[number],
  ): void {
    const queuedTurns = this.agentEventStore.listQueuedTurns(address)
    const graphRefs: string[] = record.graph_refs ? JSON.parse(record.graph_refs) : []
    const taskRefs: string[] = record.task_refs ? JSON.parse(record.task_refs) : []
    const restoredTranscript: FwaTranscriptEntry[] = this.readModelTranscriptFromStore(address)

    const runtime = this.buildRuntime(
      record.id,
      record.project_id,
      restoredTranscript,
      graphRefs,
      taskRefs,
      'idle',
      record.last_error,
      record.created_at,
      record.updated_at,
    )
    runtime.setSessionMeta(record.ticket_id, record.project_id)
    this.sessions.set(record.id, {
      sessionId: record.id,
      runtime,
      ticket_id: record.ticket_id,
      project_id: record.project_id,
    })

    for (const turn of queuedTurns) {
      runtime.enqueue({
        seq: turn.turn_seq,
        trigger: 'message' as const,
        prompt: turn.prompt_text ?? '',
        created_at: turn.created_at,
      }).catch((error) => {
        this.store.updateSessionStatus(record.id, 'failed', error instanceof Error ? error.message : String(error))
      })
    }
  }

  /**
   * Read transcript from agent_event store, converting to FwaTranscriptEntry format.
   * Public semantics: message, non-error assistant, and tool_result events are
   * readable regardless of turn completion state.
   */
  private readTranscriptFromStore(address: string): FwaTranscriptEntry[] {
    const eventsResult = this.agentEventStore.getVisibleAfterCompact(address, 0, 10000)
    return eventsResult.events
      .filter((event) => event.kind === 'message' || event.kind === 'assistant' || event.kind === 'tool_result')
      .filter((event) => (event.payload as Record<string, unknown>).error !== true)
      .map((e) => {
      const payload = e.payload as Record<string, unknown>
      return {
        seq: e.seq,
        role: (payload.role as FwaTranscriptEntry['role']) ?? 'human',
        content: (payload.content as string) ?? '',
        tool_calls: payload.tool_calls as FwaTranscriptEntry['tool_calls'],
        tool_call_id: payload.tool_call_id as string | undefined,
        tool_name: payload.tool_name as string | undefined,
        created_at: e.created_at,
      }
      })
  }

  /**
   * Read model-restoration transcript from agent_event store.
   * Applies completed-turn membership for model context reconstruction only.
   * Private: not used for public transcript queries.
   */
  private readModelTranscriptFromStore(address: string): FwaTranscriptEntry[] {
    const completedTurnSeqs = this.agentEventStore.getCompletedTurnSeqs(address)
    const eventsResult = this.agentEventStore.getVisibleAfterCompact(address, 0, 10000)
    return eventsResult.events
      .filter((event) => event.kind === 'message' || event.kind === 'assistant' || event.kind === 'tool_result')
      .filter((event) => (event.payload as Record<string, unknown>).error !== true)
      .filter((event) => event.turn_seq != null && completedTurnSeqs.has(event.turn_seq))
      .map((e) => {
      const payload = e.payload as Record<string, unknown>
      return {
        seq: e.seq,
        role: (payload.role as FwaTranscriptEntry['role']) ?? 'human',
        content: (payload.content as string) ?? '',
        tool_calls: payload.tool_calls as FwaTranscriptEntry['tool_calls'],
        tool_call_id: payload.tool_call_id as string | undefined,
        tool_name: payload.tool_name as string | undefined,
        created_at: e.created_at,
      }
      })
  }

  async handle(event: ForemanEvent): Promise<void> {
    if (this.closed) return
    if (event.source === 'foreman.taskgraph') {
      const refs = event.refs as { taskgraphId?: string; taskRunId?: string } | undefined
      if (refs?.taskgraphId) {
        for (const [, session] of this.sessions) {
          const graphRefs = session.runtime.getGraphRefs()
          if (graphRefs.includes(refs.taskgraphId)) {
            if (refs.taskRunId) {
              const currentTaskRefs = session.runtime.getTaskRefs()
              if (!currentTaskRefs.includes(refs.taskRunId)) {
                await session.runtime.mergeRefs([], [refs.taskRunId])
              }
            }
            await this.reconcileTaskRefs(session.runtime, refs.taskgraphId)
            const address = sessionIdToAddress(session.sessionId)
            const prompt = `TaskGraph ${refs.taskgraphId} event: ${event.kind}`
            const { turn_seq: turnSeq } = this.agentEventStore.appendMessageEvent({
              address,
              from: address,
              text: prompt,
            })
            session.runtime.enqueue({
              seq: turnSeq,
              trigger: 'event',
              prompt,
              created_at: new Date().toISOString(),
            }).catch((error) => {
              this.store.updateSessionStatus(session.sessionId, 'failed', error instanceof Error ? error.message : String(error))
            })
          }
        }
      }
    }
  }

  async assign(params: FwaAssignParams, delegationAdmission?: DelegationAdmissionDescriptor): Promise<FwaSession> {
    if (this.closed) throw new Error('FWA service is closed')
    const { ticket_id, project_id, prompt } = params
    const candidateId = `fwa_${randomBytes(12).toString('hex')}`

    let record: import('../../../core/fwa/session-store.mts').FwaSessionRecord
    let created: boolean

    if (delegationAdmission) {
      // When delegation admission is provided (internal Work call), use
      // transactional session creation with admission callback.
      const result = this.store.createOrGetActiveWithAdmission(
        {
          id: candidateId,
          ticket_id,
          project_id,
          status: 'idle',
          graph_refs: [],
          task_refs: [],
        },
        (resourceId) => {
          this.agentEventStore.admitDelegation({
            address: delegationAdmission.address,
            turn_seq: delegationAdmission.turn_seq,
            delegation_id: delegationAdmission.delegation_id,
            tool_name: delegationAdmission.tool_name,
            input: delegationAdmission.input,
            resource_id: resourceId,
          })
        },
      )
      record = result.session
      created = result.created

      // If session existed (not created), admit separately
      if (!created) {
        this.agentEventStore.admitDelegation({
          address: delegationAdmission.address,
          turn_seq: delegationAdmission.turn_seq,
          delegation_id: delegationAdmission.delegation_id,
          tool_name: delegationAdmission.tool_name,
          input: delegationAdmission.input,
          resource_id: record.id,
        })
      }
    } else {
      // Use existing create-or-get-active store operation (non-delegation path)
      const result = this.store.createOrGetActive({
        id: candidateId,
        ticket_id,
        project_id,
        status: 'idle',
        graph_refs: [],
        task_refs: [],
      })
      record = result.session
      created = result.created
    }

    const sessionId = record.id
    const address = sessionIdToAddress(sessionId)

    // Ensure agent_conversation exists
    this.agentEventStore.createOrGetConversation({
      address,
      kind: 'fwa',
      model: this.config.llm.model,
    })

    let session = this.sessions.get(sessionId)
    if (session) {
      session.runtime.setSessionMeta(ticket_id, project_id)
    } else {
      // Rebuild runtime from persisted state
      const transcript = created ? [] : this.readModelTranscriptFromStore(address)
      const graphRefs: string[] = record.graph_refs ? JSON.parse(record.graph_refs) : []
      const taskRefs: string[] = record.task_refs ? JSON.parse(record.task_refs) : []
      const runtime = this.buildRuntime(
        sessionId,
        project_id,
        transcript,
        graphRefs,
        taskRefs,
        record.status,
        record.last_error,
        record.created_at,
        record.updated_at,
      )
      runtime.setSessionMeta(ticket_id, project_id)
      session = { sessionId, runtime, ticket_id, project_id }
      this.sessions.set(sessionId, session)
    }

    // Atomically write message event and queued turn, then enqueue
    const { event_seq: eventSeq, turn_seq: turnSeq } = this.agentEventStore.appendMessageEvent({
      address,
      from: 'codex',
      text: prompt,
    })

    session.runtime.enqueue({
      seq: turnSeq,
      trigger: 'assign',
      prompt,
      created_at: new Date().toISOString(),
    }).catch((error) => {
      this.store.updateSessionStatus(sessionId, 'failed', error instanceof Error ? error.message : String(error))
    })

    return this.sessionToFwa(sessionId, session)
  }

  private buildRuntime(
    sessionId: string,
    projectId: string,
    restoredTranscript?: FwaTranscriptEntry[],
    restoredGraphRefs?: string[],
    restoredTaskRefs?: string[],
    restoredStatus?: FwaSessionStatus,
    restoredLastError?: string | null,
    restoredCreatedAt?: string,
    restoredUpdatedAt?: string,
  ): FWARuntime {
    const modelConfig: ForgeChatModelConfig = {
      model: this.config.llm.model,
      turnTimeoutMs: this.config.llm.turn_timeout_ms,
      httpTimeoutMs: this.config.llm.http_timeout_ms ?? 120_000,
      maxRetries: this.config.llm.max_retries ?? 2,
      retryBackoffMs: this.config.llm.retry_backoff_ms ?? 500,
    }
    const model = new ForgeChatModel({ config: modelConfig, rawExecutor: this.rawExecutor })

    const systemPolicy = readFileSync(resolve(this.workspaceRoot, 'FWA.md'), 'utf-8')

    const persistCallbacks: PersistCallbacks = {
      onTranscriptEntry: async () => {},
      onTypedEvent: async (entry) => {
        const address = sessionIdToAddress(sessionId)
        const rawSeq = this.agentEventStore.appendEvent({
          address,
          turn_seq: entry.turnSeq,
          kind: entry.kind as 'assistant' | 'tool_call' | 'tool_result',
          payload: entry.payload,
        })
        if (entry.payload.error !== true) {
          this.graphProjector.observe({
            address,
            turnSeq: entry.turnSeq,
            kind: entry.kind as 'assistant' | 'tool_call' | 'tool_result',
            payload: entry.payload,
            rawSeq,
          })
        }
      },
      onStatusTransition: async (status, lastError, turnSeq, state) => {
        this.store.updateSessionStatus(sessionId, status, lastError)
        if (turnSeq === undefined || turnSeq < 1 || state === undefined) return
        const address = sessionIdToAddress(sessionId)
        if (state === 'running') {
          const claimed = this.agentEventStore.claimNextTurn(address)
          if (!claimed || claimed.turn_seq !== turnSeq) {
            throw new Error(`durable FIFO mismatch for ${address}: expected turn ${turnSeq}, claimed ${claimed?.turn_seq ?? 'none'}`)
          }
        } else if (state === 'done') {
          this.agentEventStore.completeTurn(address, turnSeq)
        } else if (state === 'failed') {
          this.agentEventStore.completeTurn(address, turnSeq, lastError ?? 'turn failed')
        } else if (state === 'cancelled') {
          this.agentEventStore.cancelTurn(address, turnSeq)
        }
        if (state === 'done' || state === 'failed' || state === 'cancelled') {
          await getForemanEventBus().publish({
            id: `foreman:${sessionId}:turn:${turnSeq}:${state}`,
            kind: state === 'done' ? 'fwa.turn.completed' : 'fwa.turn.failed',
            source: 'foreman.fwa',
            severity: state === 'done' ? 'success' : state === 'failed' ? 'error' : 'warning',
            refs: { sessionId, project: projectId },
            data: { turnSeq, state, error: lastError },
            occurredAt: new Date().toISOString(),
          })
        }
      },
      onRefs: async (graphRefs, taskRefs) => {
        this.store.updateSessionRefs(sessionId, graphRefs, taskRefs)
      },
    }

    let runtimeRef: FWARuntime | null = null

    // Construct per-session workspace port from the new factory
    const workspacePort = createWorkspaceDocPort({
      workspaceRoot: this.workspaceRoot,
      sessionId,
      store: this.store,
    })

    // Per-session scoped TaskGraphPort: delegates to the shared service
    // but enforces session graph_refs ownership and project scope.
    const scopedTaskGraphPort: TaskGraphPort = {
      create: async (params) => {
        const injected = { ...params, project: projectId }
        try {
          return await this.taskgraphService.create(toServiceCreateParams(injected))
        } catch (error) {
          if (error instanceof TaskGraphTemplateError) {
            throw new Error(error.message)
          }
          throw error
        }
      },
      signal: async (params) => {
        const graphRefs = runtimeRef?.getGraphRefs() ?? []
        if (!graphRefs.includes(params.taskgraph_id)) {
          throw new Error(`project_scope: taskgraph '${params.taskgraph_id}' is not owned by this session`)
        }
        return this.taskgraphService.signal(params as Parameters<TaskGraphService['signal']>[0])
      },
      patch: async (params) => {
        const graphRefs = runtimeRef?.getGraphRefs() ?? []
        if (!graphRefs.includes(params.taskgraph_id)) {
          throw new Error(`project_scope: taskgraph '${params.taskgraph_id}' is not owned by this session`)
        }
        return this.taskgraphService.patch(params as Parameters<TaskGraphService['patch']>[0])
      },
      status: async (params) => {
        const graphRefs = runtimeRef?.getGraphRefs() ?? []
        if (!graphRefs.includes(params.taskgraph_id)) {
          throw new Error(`project_scope: taskgraph '${params.taskgraph_id}' is not owned by this session`)
        }
        return this.taskgraphService.status(params as Parameters<TaskGraphService['status']>[0])
      },
      events: async (params) => {
        const graphRefs = runtimeRef?.getGraphRefs() ?? []
        if (!graphRefs.includes(params.taskgraph_id)) {
          throw new Error(`project_scope: taskgraph '${params.taskgraph_id}' is not owned by this session`)
        }
        return this.taskgraphService.events(params as Parameters<TaskGraphService['events']>[0])
      },
      inspect: async (params) => {
        const graphRefs = runtimeRef?.getGraphRefs() ?? []
        if (!graphRefs.includes(params.taskgraph_id)) {
          throw new Error(`project_scope: taskgraph '${params.taskgraph_id}' is not owned by this session`)
        }
        return this.taskgraphService.inspect(params as Parameters<TaskGraphService['inspect']>[0])
      },
    }

    // Per-session scoped TaskServicePort: enforces session task_refs
    // ownership and project scope for output/status/cancel/getTaskRun.
    // Uses a centralized authorizeTaskRun helper that requires task_refs
    // ownership, fetches authoritative status, validates _meta.project
    // (nonempty string), and applies segment-safe exact-or-descendant guard.
    // For run, describe, and list, guards the requested project with the
    // same exact-or-descendant check before delegating.

    // Segment-safe exact-or-descendant project scope check:
    // targetProject === sessionProject or starts with sessionProject + '/'.
    const isExactOrDescendant = (sessionProject: string, targetProject: string): boolean => {
      return targetProject === sessionProject || targetProject.startsWith(sessionProject + '/')
    }

    // Centralized authorization for task_run operations: requires task_refs
    // ownership, authoritative nonempty _meta.project, and segment-safe
    // exact-or-descendant scope. Returns the validated project.
    const authorizeTaskRun = async (taskRunId: string): Promise<string> => {
      const taskRefs = runtimeRef?.getTaskRefs() ?? []
      if (!taskRefs.includes(taskRunId)) {
        throw new Error(`project_scope: task_run '${taskRunId}' is not owned by this session`)
      }
      const statusResult = await this.taskService.status(taskRunId)
      if (!statusResult || typeof statusResult !== 'object') {
        throw new Error(`project_scope: task_run '${taskRunId}' has no authoritative status`)
      }
      const resultAny = statusResult as any
      const metaProject = resultAny._meta?.project
      if (!metaProject || typeof metaProject !== 'string') {
        throw new Error(`project_scope: task_run '${taskRunId}' missing or invalid _meta.project`)
      }
      if (!isExactOrDescendant(projectId, metaProject)) {
        throw new Error(`project_scope: task_run '${taskRunId}' authoritative project '${metaProject}' does not match session project '${projectId}'`)
      }
      return metaProject
    }

    const scopedTaskServicePort: TaskServicePort = {
      run: async (params) => {
        const effectiveProject = params.project ?? projectId
        if (!isExactOrDescendant(projectId, effectiveProject)) {
          throw new Error(`project_scope: requested project '${effectiveProject}' does not match session project '${projectId}'`)
        }
        const result = await this.taskService.run({
          taskId: params.taskId,
          project: effectiveProject,
          input: params.input,
        })
        if ('task_run_id' in result) {
          return { task_run_id: result.task_run_id, status: 'created' }
        }
        throw new Error(`Task run rejected: ${JSON.stringify(result)}`)
      },
      describe: async (params) => {
        const effectiveProject = params.project ?? projectId
        if (!isExactOrDescendant(projectId, effectiveProject)) {
          throw new Error(`project_scope: requested project '${effectiveProject}' does not match session project '${projectId}'`)
        }
        return this.taskService.describe(params.task_id, effectiveProject)
      },
      output: async (params) => {
        await authorizeTaskRun(params.task_run_id)
        return this.taskService.output(params.task_run_id) ?? {}
      },
      status: async (params) => {
        await authorizeTaskRun(params.task_run_id)
        return this.taskService.status(params.task_run_id) ?? {}
      },
      cancel: async (params) => {
        await authorizeTaskRun(params.task_run_id)
        return this.taskService.cancel(params.task_run_id)
      },
      list: async (project) => {
        const effectiveProject = project ?? projectId
        if (!isExactOrDescendant(projectId, effectiveProject)) {
          throw new Error(`project_scope: requested project '${effectiveProject}' does not match session project '${projectId}'`)
        }
        return this.taskService.list(effectiveProject)
      },
      getTaskRun: async (params) => {
        const metaProject = await authorizeTaskRun(params.task_run_id)
        const result = await this.taskService.status(params.task_run_id)
        return { task_run_id: params.task_run_id, project: metaProject, ...(result as any) }
      },
    }

    const messagePort: MessagePort = {
      reply: async (params) => {
        const result = await this.messageService.send({
          from: sessionIdToAddress(sessionId),
          to: params.to,
          text: params.text,
        })
        return { ok: !('ok' in result) || result.ok }
      },
    }

    const toolPorts: ToolPorts = {
      taskgraph: scopedTaskGraphPort,
      task: scopedTaskServicePort,
      message: messagePort,
      workspace: workspacePort,
      sessionProject: projectId,
      sessionId,
      workspaceRoot: this.workspaceRoot,
      onRefs: async (graphRefs, taskRefs) => {
        if (runtimeRef) {
          await runtimeRef.mergeRefs(graphRefs, taskRefs)
        }
      },
    }
    const tools = createAllFwaTools(toolPorts)

    const runtime = new FWARuntime({
      model,
      tools,
      sessionId,
      systemPolicy,
      persistCallbacks,
      restoredTranscript,
      restoredGraphRefs,
      restoredTaskRefs,
      restoredStatus,
      restoredLastError: restoredLastError ?? undefined,
      restoredCreatedAt,
      restoredUpdatedAt,
    })
    runtimeRef = runtime
    return runtime
  }

  async list(): Promise<{ sessions: FwaSession[] }> {
    const result: FwaSession[] = []
    for (const [, session] of this.sessions) {
      result.push(this.sessionToFwa(session.sessionId, session))
    }
    const inactiveRecords = this.store.listInactiveSessions()
    for (const record of inactiveRecords) {
      if (!this.sessions.has(record.id)) {
        const address = sessionIdToAddress(record.id)
        result.push({
          id: record.id,
          message_address: sessionIdToAddress(record.id),
          ticket_id: record.ticket_id,
          project_id: record.project_id,
          status: record.status,
          queue_depth: this.agentEventStore.getQueueDepth(address),
          graph_refs: record.graph_refs ? JSON.parse(record.graph_refs) : [],
          task_refs: record.task_refs ? JSON.parse(record.task_refs) : [],
          created_at: record.created_at,
          updated_at: record.updated_at,
        })
      }
    }
    return { sessions: result }
  }

  async status(sessionId: string): Promise<FwaInspectableStatus> {
    const address = sessionIdToAddress(sessionId)
    const conv = this.agentEventStore.getConversation(address)
    const queueDepth = this.agentEventStore.getQueueDepth(address)
    const activeTurn = this.agentEventStore.getActiveTurn(address)

    const session = this.sessions.get(sessionId)
    if (session) {
      for (const graphRef of session.runtime.getGraphRefs()) {
        await this.reconcileTaskRefs(session.runtime, graphRef)
      }
      const inspectStatus = session.runtime.inspectStatus()
      return {
        ...inspectStatus,
        queue_depth: queueDepth,
        active_turn_seq: activeTurn?.turn_seq ?? null,
        status: conv
          ? conv.status === 'running'
            ? 'running_turn'
            : conv.status
          : inspectStatus.status,
      }
    }
    const record = this.store.getSession(sessionId)
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return {
      session_id: record.id,
      message_address: sessionIdToAddress(record.id),
      ticket_id: record.ticket_id,
      project_id: record.project_id,
      status: record.status,
      queue_depth: queueDepth,
      active_turn_seq: activeTurn?.turn_seq ?? null,
      last_error: record.last_error,
      graph_refs: record.graph_refs ? JSON.parse(record.graph_refs) : [],
      task_refs: record.task_refs ? JSON.parse(record.task_refs) : [],
      created_at: record.created_at,
      updated_at: record.updated_at,
    }
  }

  // ─── FwaSendPort implementation ───────────────────────────────────

  /**
   * Check if a session id exists and is non-closed (for FwaSendPort.hasLiveSession).
   */
  hasLiveSession(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) return true
    const record = this.store.getSession(sessionId)
    return !!record && record.status !== 'closed'
  }

  /**
   * Send a message to a specific FWA session by its storage id.
   * Atomically writes message event and queued turn, then enqueues.
   * Returns target_seq and queue_depth (for FwaSendPort.sendToSession).
   */
  async sendToSession(
    sessionId: string,
    text: string,
    from: string,
    messageId: string,
  ): Promise<{ accepted: boolean; target_seq?: number; queue_depth?: number }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      // Session not in memory — hydrate it
      const record = this.store.getSession(sessionId)
      if (!record || record.status === 'closed') {
        return { accepted: false }
      }
      const address = sessionIdToAddress(sessionId)
      this.agentEventStore.createOrGetConversation({
        address,
        kind: 'fwa',
        model: this.config.llm.model,
      })
      const transcript = this.readModelTranscriptFromStore(address)
      const graphRefs: string[] = record.graph_refs ? JSON.parse(record.graph_refs) : []
      const taskRefs: string[] = record.task_refs ? JSON.parse(record.task_refs) : []
      const runtime = this.buildRuntime(
        sessionId,
        record.project_id,
        transcript,
        graphRefs,
        taskRefs,
        record.status,
        record.last_error,
        record.created_at,
        record.updated_at,
      )
      runtime.setSessionMeta(record.ticket_id, record.project_id)
      const newSession = { sessionId, runtime, ticket_id: record.ticket_id, project_id: record.project_id }
      this.sessions.set(sessionId, newSession)

      const address2 = sessionIdToAddress(sessionId)
      const { event_seq: eventSeq, turn_seq: turnSeq } = this.agentEventStore.appendMessageEvent({
        address: address2,
        from,
        text,
        message_id: messageId,
      })
      runtime.enqueue({
        seq: turnSeq,
        trigger: 'message',
        prompt: text,
        created_at: new Date().toISOString(),
      }).catch((error) => {
        this.store.updateSessionStatus(sessionId, 'failed', error instanceof Error ? error.message : String(error))
      })
      return { accepted: true, target_seq: eventSeq, queue_depth: this.agentEventStore.getQueueDepth(address2) }
    }

    const address = sessionIdToAddress(sessionId)
    const { event_seq: eventSeq, turn_seq: turnSeq } = this.agentEventStore.appendMessageEvent({
      address,
      from,
      text,
      message_id: messageId,
    })

    session.runtime.enqueue({
      seq: turnSeq,
      trigger: 'message',
      prompt: text,
      created_at: new Date().toISOString(),
    }).catch((error) => {
      this.store.updateSessionStatus(sessionId, 'failed', error instanceof Error ? error.message : String(error))
    })

    return { accepted: true, target_seq: eventSeq, queue_depth: this.agentEventStore.getQueueDepth(address) }
  }

  async transcript(sessionId: string): Promise<{ entries: FwaTranscriptEntry[] }> {
    const address = sessionIdToAddress(sessionId)
    const entries = this.readTranscriptFromStore(address)
    return { entries }
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe()
    for (const [, session] of this.sessions) {
      await session.runtime.shutdown()
    }
    this.sessions.clear()
  }

  private sessionToFwa(sessionId: string, session: FwaServiceSession): FwaSession {
    const status = session.runtime.getStatus() as FwaSessionStatus
    const queue = session.runtime.inspectQueue()
    const inspectStatus = session.runtime.inspectStatus()
    return {
      id: session.sessionId,
      message_address: sessionIdToAddress(session.sessionId),
      ticket_id: session.ticket_id,
      project_id: session.project_id,
      status,
      queue_depth: queue.pending.length,
      active_turn_seq: inspectStatus.active_turn_seq ?? undefined,
      last_error: inspectStatus.last_error ?? undefined,
      graph_refs: session.runtime.getGraphRefs(),
      task_refs: session.runtime.getTaskRefs(),
      created_at: inspectStatus.created_at,
      updated_at: inspectStatus.updated_at,
    }
  }

  private async reconcileTaskRefs(runtime: FWARuntime, graphRef: string): Promise<void> {
    try {
      let afterSeq: number | undefined
      let hasMore = true
      const taskRunIds: string[] = []

      while (hasMore) {
        const result = await this.taskgraphService.events({
          taskgraph_id: graphRef,
          after_seq: afterSeq,
          limit: this.RECONCILE_PAGE_SIZE,
        })
        for (const event of result.events) {
          const runId = event.refs?.task_run_id
          if (runId && !taskRunIds.includes(runId)) {
            taskRunIds.push(runId)
          }
        }
        afterSeq = result.next_seq
        hasMore = result.has_more
      }

      if (taskRunIds.length > 0) {
        await runtime.mergeRefs([], taskRunIds)
      }
    } catch {
      // Per-graph failure isolated
    }
  }

  // -- Port adapters --

  private readonly taskgraphPort: TaskGraphPort = {
    create: async (params) => {
      try {
        return await this.taskgraphService.create(toServiceCreateParams(params))
      } catch (error) {
        if (error instanceof TaskGraphTemplateError) {
          throw new Error(error.message)
        }
        throw error
      }
    },
    signal: async (params) => this.taskgraphService.signal(params as Parameters<TaskGraphService['signal']>[0]),
    patch: async (params) => this.taskgraphService.patch(params as Parameters<TaskGraphService['patch']>[0]),
    status: async (params) => this.taskgraphService.status(params as Parameters<TaskGraphService['status']>[0]),
    events: async (params) => this.taskgraphService.events(params as Parameters<TaskGraphService['events']>[0]),
    inspect: async (params) => this.taskgraphService.inspect(params as Parameters<TaskGraphService['inspect']>[0]),
  }

  private readonly taskServicePort: TaskServicePort = {
    run: async (params) => {
      const result = await this.taskService.run({
        taskId: params.taskId,
        project: params.project ?? '',
        input: params.input,
      })
      if ('task_run_id' in result) {
        return { task_run_id: result.task_run_id, status: 'created' }
      }
      throw new Error(`Task run rejected: ${JSON.stringify(result)}`)
    },
    describe: async (params) => {
      return this.taskService.describe(params.task_id, params.project)
    },
    output: async (params) => {
      return this.taskService.output(params.task_run_id) ?? {}
    },
    status: async (params) => {
      return this.taskService.status(params.task_run_id) ?? {}
    },
    cancel: async (params) => {
      return this.taskService.cancel(params.task_run_id)
    },
    list: async (project) => {
      return this.taskService.list(project)
    },
  }

}
