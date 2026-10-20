import { randomBytes } from 'node:crypto'

import type { ForemanDatabase } from '../../db/types.mts'
import { TaskRunStore } from '../../db/stores/task-run-store.mts'
import { createAgentPrimitive } from '../../core/operations/primitives/agent.mts'
import type {
  AgentExecutionHost,
  StartTaskRunOptions,
  TaskRunAcceptedHandle,
  TaskWorkflowRunHost,
} from '../../core/operations/types.mts'
import {
  type PrimitiveSet,
  type TaskRouteStateHooks,
  type TaskRunSettingsResolver,
} from '../../types.mts'
import { DaemonTaskRunner } from './task-runner.mts'
import type { SupervisorLogger } from './agent-supervisor.mts'
import type { TaskDispatchResolver } from '@wrenyard/task'
import { appendForemanEvent } from '../../events/event-store.mts'
import {
  registerTaskWriteTargets,
  releaseTaskWriteTargets,
} from './task-write-targets.mts'
import { minimalRunFactsForTaskRun, minimalRunFactsJson } from './run-facts.mts'

type StartTaskRunOptionsWithWriteTargets = StartTaskRunOptions & {
  writeTargets?: readonly string[]
}

export interface TaskWorkflowRunnerOptions {
  db: ForemanDatabase
  agentExecutionHost: AgentExecutionHost
  logger?: SupervisorLogger
  /** Daemon-side deterministic task dispatch resolver. Optional only for isolated
   *  runner construction in tests; constrained production definitions require it. */
  taskDispatchResolver?: TaskDispatchResolver
  /** Daemon-side authoritative task settings resolver. Optional only for isolated
   *  runner construction; daemon bootstrap attaches the single TaskSettingsService
   *  resolver after constructing the runner and the service. */
  taskSettingsResolver?: TaskRunSettingsResolver
  /** Optional daemon-owned native-task route-state port bound to the shared
   *  Gateway circuit. Optional so existing runner constructions stay valid. */
  taskRouteState?: TaskRouteStateHooks
}

export class TaskWorkflowRunner implements TaskWorkflowRunHost {
  private readonly db: ForemanDatabase
  private readonly agentExecutionHost: AgentExecutionHost
  private readonly logger?: SupervisorLogger
  private readonly taskRunner: DaemonTaskRunner
  private readonly taskDispatchResolver?: TaskDispatchResolver
  private taskSettingsResolver?: TaskRunSettingsResolver
  private taskRouteState?: TaskRouteStateHooks

  constructor(options: TaskWorkflowRunnerOptions) {
    this.db = options.db
    this.agentExecutionHost = options.agentExecutionHost
    this.logger = options.logger
    this.taskDispatchResolver = options.taskDispatchResolver
    this.taskSettingsResolver = options.taskSettingsResolver
    this.taskRouteState = options.taskRouteState
    this.taskRunner = new DaemonTaskRunner()
  }

  /** Attaches the daemon's authoritative task-settings resolver. Daemon
   *  bootstrap calls this after constructing both the workflow runner and the
   *  TaskSettingsService so execution-time settings resolution reuses the same
   *  service wired into snapshot/preflight. */
  setTaskSettingsResolver(resolver: TaskRunSettingsResolver): void {
    this.taskSettingsResolver = resolver
  }

  /** Attaches the daemon-owned native-task route-state port backed by the
   *  single shared Gateway circuit. Mirrors {@link setTaskSettingsResolver}: the
   *  runner is constructed before the gateway, so bootstrap/hot-switch point the
   *  same runner at the current gateway instance. */
  setTaskRouteState(hooks: TaskRouteStateHooks): void {
    this.taskRouteState = hooks
  }

  async startTaskRun(opts: StartTaskRunOptions): Promise<TaskRunAcceptedHandle> {
    const taskRunId = createTaskRunId()
    const writeOpts = opts as StartTaskRunOptionsWithWriteTargets

    const createdAt = this.insertTaskPlaceholder({
      taskRunId,
      taskName: opts.taskName,
      project: opts.project,
      input: opts.input,
      worktree: opts.worktree,
      source: opts.source,
    })

    if (writeOpts.writeTargets !== undefined && writeOpts.writeTargets.length > 0) {
      registerTaskWriteTargets(taskRunId, {
        taskId: opts.definitionName,
        checkoutPath: opts.workingDirectory,
        targets: writeOpts.writeTargets,
      })
    }

    void this.taskRunner.execute(opts.definitionName, opts.input, {
      workspaceRoot: opts.workspaceRoot,
      currentProject: opts.executionProject,
      executionProject: opts.executionProject,
      workingDirectory: opts.workingDirectory,
      worktreeId: opts.worktree,
      taskId: taskRunId,
      connectingId: opts.connectingId,
      taskContext: opts.taskContext,
      primitives: this.agentPrimitives(),
      taskDispatchResolver: this.taskDispatchResolver,
      taskSettingsResolver: this.taskSettingsResolver,
      ...(this.taskRouteState !== undefined ? { taskRouteState: this.taskRouteState } : {}),
      ...(opts.invocationSettings !== undefined ? { invocationSettings: opts.invocationSettings } : {}),
    }).catch(async (error: unknown) => {
      const message = errorMessage(error)
      this.log('error', `[foreman] task ${taskRunId} unhandled error: ${message}`, error)
      await this.markTaskPlaceholderFailed(
        taskRunId,
        message,
        taskErrorField(error, 'failure_category'),
        taskErrorField(error, 'suggestion'),
        taskErrorField(error, 'error_message'),
      )
    }).finally(() => {
      releaseTaskWriteTargets(taskRunId)
    })

    return {
      id: taskRunId,
      task_run_id: taskRunId,
      // An accepted run is queued until its first execution launches.
      status: 'queued',
      created_at: createdAt,
      hint: `Use task_status with id "${taskRunId}" for status, then task_output with the same id for result. Do not poll repeatedly.`,
    }
  }

  async cancelTaskRun(taskRunId: string): Promise<Record<string, unknown>> {
    const row = this.get<{ execution_id: string | null; status: string; project: string | null; worktree: string | null }>(
      `SELECT execution_id, status, project, worktree FROM tasks WHERE id = ?`,
      taskRunId,
    )
    if (!row) throw new Error(`Task run '${taskRunId}' not found`)
    if (isTaskTerminal(row.status)) {
      return {
        ok: false,
        task_run_id: taskRunId,
        status: row.status,
        message: 'Task run is already in a terminal state',
      }
    }

    if (row.execution_id) {
      await this.agentExecutionHost.cancelExecution(row.execution_id)

      // The supervisor now fully terminalizes the linked execution before resolving, but
      // guard against returning a success while that execution is still active.
      const execRow = this.get<{ status: string }>(
        `SELECT status FROM executions WHERE id = ?`,
        row.execution_id,
      )
      if (execRow && !isExecutionTerminalStatus(execRow.status)) {
        return {
          ok: false,
          task_run_id: taskRunId,
          status: execRow.status,
          message: 'Linked execution did not reach a terminal state after cancel',
        }
      }

      // Consume the supervisor's bounded durable result idempotently: when the
      // bounded cancellation already terminalized the linked task, return its
      // authoritative terminal state instead of re-marking it. This keeps
      // repeated cancel and a later normal completion from overwriting the
      // state or duplicating lifecycle events.
      const taskAfterCancel = this.get<{ status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
        taskRunId,
      )
      if (taskAfterCancel && taskAfterCancel.status === 'cancelled') {
        return { ok: true, task_run_id: taskRunId, status: 'cancelled' }
      }
    }

    const now = new Date().toISOString()
    const changed = this.taskRuns().markTerminal({
      taskRunId,
      status: 'cancelled',
      output: undefined,
      summary: undefined,
      error: 'Task run cancelled',
      endedAt: now,
      facts: minimalRunFactsJson({ status: 'cancelled', worktreeId: row.worktree }),
    })
    if (!changed) {
      const current = this.get<{ status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
        taskRunId,
      )
      if (!current) throw new Error(`Task run '${taskRunId}' not found`)
      if (current.status === 'cancelled') {
        return { ok: true, task_run_id: taskRunId, status: 'cancelled' }
      }
      return {
        ok: false,
        task_run_id: taskRunId,
        status: current.status,
        message: 'Task run is already in a terminal state',
      }
    }

    await appendForemanEvent({
      id: `foreman:${taskRunId}:cancelled`,
      kind: 'task.run.cancelled',
      source: 'daemon.execution.runner',
      severity: 'warning',
      refs: { taskId: taskRunId, ...(row.project ? { project: row.project } : {}) },
      data: { status: 'cancelled', error: 'Task run cancelled' },
      occurredAt: now,
    })

    releaseTaskWriteTargets(taskRunId)
    return { ok: true, task_run_id: taskRunId, status: 'cancelled' }
  }

  private taskRuns(): TaskRunStore {
    return new TaskRunStore(this.db)
  }

  private agentPrimitives(): Partial<PrimitiveSet> {
    return {
      agent: createAgentPrimitive(this.agentExecutionHost),
    }
  }

  private insertTaskPlaceholder(params: {
    taskRunId: string
    taskName: string
    project: string
    input: unknown
    worktree?: string
    source?: 'builtin' | 'project'
  }): string {
    const now = new Date().toISOString()
    this.taskRuns().insertAcceptedPlaceholder({
      taskRunId: params.taskRunId,
      template: params.taskName,
      project: params.project || null,
      worktree: params.worktree ?? null,
      input: params.input,
      structured: true,
      definitionSource: params.source ?? null,
      createdAt: now,
    })
    return now
  }

  private async markTaskPlaceholderFailed(
    taskRunId: string,
    message: string,
    failureCategory?: string,
    suggestion?: string,
    detailMessage?: string,
  ): Promise<void> {
    const now = new Date().toISOString()
    this.taskRuns().markTerminal({
      taskRunId,
      status: 'failed',
      error: message,
      endedAt: now,
      failureCategory,
      suggestion,
      errorMessage: detailMessage,
      facts: minimalRunFactsForTaskRun(taskRunId, 'failed'),
    })
    const row = this.get<{ status: string; project: string | null; error: string | null }>(
      'SELECT status, project, error FROM tasks WHERE id = ?', taskRunId,
    )
    // Startup failures may already be terminalized by the supervisor, before
    // the kernel can publish the event that releases task waiters.
    if (row?.status !== 'failed' || this.get(
      "SELECT id FROM events WHERE task_id = ? AND type = 'task.run.failed' LIMIT 1", taskRunId,
    )) return
    await appendForemanEvent({
      id: `foreman:${taskRunId}:failed`,
      kind: 'task.run.failed',
      source: 'daemon.execution.runner',
      severity: 'error',
      refs: { taskId: taskRunId, ...(row.project ? { project: row.project } : {}) },
      data: { status: 'failed', error: row.error ?? message },
      occurredAt: now,
    })
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare<unknown[], T>(sql).get(...params)
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
    this.logger?.[level]?.(message, meta)
  }
}

function createTaskRunId(): string {
  return `task_${randomBytes(4).toString('hex')}`
}

function isTaskTerminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function isExecutionTerminalStatus(status: string): boolean {
  return status === 'done'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'timeout'
    || status === 'interrupted'
}

function taskErrorField(error: unknown, field: string): string | undefined {
  if (error && typeof error === 'object' && field in error) {
    const value = (error as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
