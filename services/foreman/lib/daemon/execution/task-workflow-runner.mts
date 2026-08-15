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
} from '../../types.mts'
import { DaemonTaskRunner } from './task-runner.mts'
import type { SupervisorLogger } from './agent-supervisor.mts'
import type { DispatchControl } from '../dispatch-control.mts'
import type { AgentEventStore } from '../../core/agent/agent-event-store.mts'
import { appendForemanEvent } from '../../events/event-store.mts'

export interface TaskWorkflowRunnerOptions {
  db: ForemanDatabase
  agentExecutionHost: AgentExecutionHost
  agentEventStore?: AgentEventStore
  logger?: SupervisorLogger
  /**
   * Optional admission gate. The daemon runtime always supplies it; optionality
   * only preserves isolated runner construction in tests and library use. When
   * present it is invoked as the first action of startTaskRun and must throw a
   * DispatchControlError with code `daemon_planned_restart` (exact message
   * "Foreman daemon is planning restart and is not accepting new tasks or
   * workflows.") to reject new work during a planned restart. Acceptable
   * continuation of already-accepted execution must not call it.
   */
  admissionControl?: DispatchControl['assertAccepting']
}

export class TaskWorkflowRunner implements TaskWorkflowRunHost {
  private readonly db: ForemanDatabase
  private readonly agentExecutionHost: AgentExecutionHost
  private readonly agentEventStore?: AgentEventStore
  private readonly logger?: SupervisorLogger
  private readonly taskRunner: DaemonTaskRunner
  private readonly admissionControl?: () => void

  constructor(options: TaskWorkflowRunnerOptions) {
    this.db = options.db
    this.agentExecutionHost = options.agentExecutionHost
    this.agentEventStore = options.agentEventStore
    this.logger = options.logger
    this.admissionControl = options.admissionControl
    this.taskRunner = new DaemonTaskRunner()
  }

  async startTaskRun(opts: StartTaskRunOptions): Promise<TaskRunAcceptedHandle> {
    this.assertAccepting()
    const taskRunId = createTaskRunId()

    const admission = opts.delegationAdmission
    if (admission && !this.agentEventStore) {
      throw new Error('Delegated task admission requires an AgentEventStore')
    }

    if (admission) {
      // Transactional: wrap task placeholder insertion + delegation admission
      this.db.transaction(() => {
        this.insertTaskPlaceholder({
          taskRunId,
          taskName: opts.taskName,
          project: opts.project,
          input: opts.input,
          worktree: opts.worktree,
          source: opts.source,
        })
        try {
          this.agentEventStore!.admitDelegation({
            address: admission.address,
            turn_seq: admission.turn_seq,
            delegation_id: admission.delegation_id,
            tool_name: admission.tool_name,
            input: admission.input,
            resource_id: taskRunId,
          })
        } catch (error) {
          // Roll back the task row if delegation insert fails
          this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskRunId)
          throw error
        }
      })()
    } else {
      this.insertTaskPlaceholder({
        taskRunId,
        taskName: opts.taskName,
        project: opts.project,
        input: opts.input,
        worktree: opts.worktree,
        source: opts.source,
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
    }).catch((error: unknown) => {
      const message = errorMessage(error)
      this.log('error', `[foreman] task ${taskRunId} unhandled error: ${message}`, error)
      this.markTaskPlaceholderFailed(
        taskRunId,
        message,
        taskErrorField(error, 'failure_category'),
        taskErrorField(error, 'suggestion'),
        taskErrorField(error, 'error_message'),
      )
    })

    return {
      id: taskRunId,
      task_run_id: taskRunId,
      hint: `Use task_status with id "${taskRunId}" for status, then task_output with the same id for result. Do not poll repeatedly.`,
    }
  }

  async cancelTaskRun(taskRunId: string): Promise<Record<string, unknown>> {
    const row = this.get<{ execution_id: string | null; status: string; project: string | null }>(
      `SELECT execution_id, status, project FROM tasks WHERE id = ?`,
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

    return { ok: true, task_run_id: taskRunId, status: 'cancelled' }
  }

  private taskRuns(): TaskRunStore {
    return new TaskRunStore(this.db)
  }

  /**
   * Enforces admission before any create mutation. A planned_restart
   * gate must reject with DispatchControlError code `daemon_planned_restart`
   * and the exact message, so already-accepted execution that reaches its
   * terminal result (and is not routed through a create entry point)
   * is never cancelled or halted by this check.
   */
  private assertAccepting(): void {
    this.admissionControl?.()
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
  }): void {
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
  }

  private markTaskPlaceholderFailed(
    taskRunId: string,
    message: string,
    failureCategory?: string,
    suggestion?: string,
    detailMessage?: string,
  ): void {
    const now = new Date().toISOString()
    this.taskRuns().markTerminal({
      taskRunId,
      status: 'failed',
      error: message,
      endedAt: now,
      failureCategory,
      suggestion,
      errorMessage: detailMessage,
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
