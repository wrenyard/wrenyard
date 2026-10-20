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
  RepoWriteLocks,
  type TaskRunWriteLockConflict,
} from './repo-write-locks.mts'

export interface RefusedSessionWriteScope {
  project: string
  taskName: string
  workingDirectory: string
  writePaths: readonly string[]
}

export type RefusedSessionWriteTargetNotifier = (
  sessionId: string,
  scope: RefusedSessionWriteScope,
) => void | Promise<void>

export class TaskRunWriteLockRefusedError extends Error {
  readonly code = 'write_lock_conflict'
  readonly holder: TaskRunWriteLockConflict

  constructor(holder: TaskRunWriteLockConflict) {
    super(formatWriteLockConflictMessage(holder))
    this.name = 'TaskRunWriteLockRefusedError'
    this.holder = holder
  }
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
  /** Shared repo write-lock registry; required for task-run admission in production. */
  repoWriteLocks?: RepoWriteLocks
}

interface OwnedRunLifecycle {
  cancelled: boolean
  lockHeld: boolean
  childAdmissionClosed: boolean
  waitUnsubscribe?: () => void
  settleAdmissionWait?: () => void
  executePromise?: Promise<unknown>
  activeExecutions: Set<string>
  childPromises: Set<Promise<unknown>>
}

export class TaskWorkflowRunner implements TaskWorkflowRunHost {
  private readonly db: ForemanDatabase
  private readonly agentExecutionHost: AgentExecutionHost
  private readonly logger?: SupervisorLogger
  private readonly taskRunner: DaemonTaskRunner
  private readonly taskDispatchResolver?: TaskDispatchResolver
  private readonly repoWriteLocks?: RepoWriteLocks
  private taskSettingsResolver?: TaskRunSettingsResolver
  private taskRouteState?: TaskRouteStateHooks
  private refusedSessionNotifier?: RefusedSessionWriteTargetNotifier
  private readonly refusedSessionWaits = new Map<string, () => void>()
  private readonly ownedRuns = new Map<string, OwnedRunLifecycle>()

  constructor(options: TaskWorkflowRunnerOptions) {
    this.db = options.db
    this.agentExecutionHost = options.agentExecutionHost
    this.logger = options.logger
    this.taskDispatchResolver = options.taskDispatchResolver
    this.taskSettingsResolver = options.taskSettingsResolver
    this.taskRouteState = options.taskRouteState
    this.repoWriteLocks = options.repoWriteLocks
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

  /** Delivers a one-shot target-free notice to a session after a refused dispatch. */
  setRefusedSessionWriteTargetNotifier(notifier: RefusedSessionWriteTargetNotifier | undefined): void {
    this.refusedSessionNotifier = notifier
  }

  disposeRefusedSessionWriteTargetNotices(): void {
    for (const unsubscribe of this.refusedSessionWaits.values()) unsubscribe()
    this.refusedSessionWaits.clear()
    this.refusedSessionNotifier = undefined
  }

  async startTaskRun(opts: StartTaskRunOptions): Promise<TaskRunAcceptedHandle> {
    const taskRunId = createTaskRunId()
    const policy = opts.writeConflictPolicy ?? 'refuse'
    const needsAdmission = this.requiresWriteAdmission(opts)

    if (needsAdmission && policy === 'refuse') {
      const startedAt = new Date().toISOString()
      const acquire = this.repoWriteLocks!.tryAcquireTaskRun(
        opts.workingDirectory,
        taskRunId,
        opts.writePaths,
        {
          sessionId: opts.sessionId,
          taskName: opts.taskName,
          startedAt,
        },
      )
      if (!acquire.acquired) {
        if (opts.sessionId !== undefined) {
          this.armRefusedSessionNotice(opts.sessionId, {
            project: opts.project,
            taskName: opts.taskName,
            workingDirectory: opts.workingDirectory,
            writePaths: opts.writePaths!,
          })
        }
        throw new TaskRunWriteLockRefusedError(acquire.holder)
      }

      let createdAt: string
      try {
        createdAt = this.insertTaskPlaceholder({
          taskRunId,
          taskName: opts.taskName,
          project: opts.project,
          input: opts.input,
          worktree: opts.worktree,
          source: opts.source,
        })
      } catch (error) {
        this.repoWriteLocks!.releaseByTaskRun(taskRunId)
        throw error
      }

      this.ownedRuns.set(taskRunId, this.createOwnedRunLifecycle(true))
      const executePromise = this.attachRunExecution(opts, taskRunId)
      this.guardDetachedExecutionChain(taskRunId, executePromise)
      return this.acceptedHandle(taskRunId, createdAt)
    }

    const lifecycle = this.createOwnedRunLifecycle(false)
    this.ownedRuns.set(taskRunId, lifecycle)
    let createdAt: string
    try {
      createdAt = this.insertTaskPlaceholder({
        taskRunId,
        taskName: opts.taskName,
        project: opts.project,
        input: opts.input,
        worktree: opts.worktree,
        source: opts.source,
      })
    } catch (error) {
      this.ownedRuns.delete(taskRunId)
      throw error
    }

    if (needsAdmission && policy === 'wait') {
      const executePromise = this.waitForAdmissionThenExecute(opts, taskRunId)
      lifecycle.executePromise = executePromise
      this.guardDetachedExecutionChain(taskRunId, executePromise)
      return this.acceptedHandle(taskRunId, createdAt)
    }

    const executePromise = this.attachRunExecution(opts, taskRunId)
    lifecycle.executePromise = executePromise
    this.guardDetachedExecutionChain(taskRunId, executePromise)
    return this.acceptedHandle(taskRunId, createdAt)
  }

  async cancelTaskRun(taskRunId: string): Promise<Record<string, unknown>> {
    const owned = this.ownedRuns.get(taskRunId)
    if (owned) {
      owned.cancelled = true
      owned.childAdmissionClosed = true
      owned.settleAdmissionWait?.()
      owned.settleAdmissionWait = undefined
      owned.waitUnsubscribe?.()
      owned.waitUnsubscribe = undefined
      const activeIds = [...owned.activeExecutions]
      await Promise.all(activeIds.map((id) => this.agentExecutionHost.cancelExecution(id).catch(() => undefined)))
      await owned.executePromise?.catch(() => undefined)
    }

    const row = this.get<{ execution_id: string | null; status: string; project: string | null }>(
      `SELECT execution_id, status, project FROM tasks WHERE id = ?`,
      taskRunId,
    )
    if (!row) throw new Error(`Task run '${taskRunId}' not found`)
    if (owned?.cancelled && row.status === 'cancelled') {
      return { ok: true, task_run_id: taskRunId, status: 'cancelled' }
    }
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

      if (owned?.executePromise) {
        await owned.executePromise.catch(() => undefined)
      }

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
    } else if (owned?.executePromise) {
      await owned.executePromise.catch(() => undefined)
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

  private requiresWriteAdmission(opts: StartTaskRunOptions): boolean {
    return (
      this.repoWriteLocks !== undefined
      && opts.writePaths !== undefined
      && opts.writePaths.length > 0
    )
  }

  private createOwnedRunLifecycle(lockHeld: boolean): OwnedRunLifecycle {
    return {
      cancelled: false,
      lockHeld,
      childAdmissionClosed: false,
      activeExecutions: new Set(),
      childPromises: new Set(),
    }
  }

  private attachRunExecution(opts: StartTaskRunOptions, taskRunId: string): Promise<void> {
    const owned = this.ownedRuns.get(taskRunId)
    const lockHeld = owned?.lockHeld ?? false
    const executePromise = this.runTaskWithLifecycleFinalizer(taskRunId, lockHeld, () =>
      this.taskRunner.execute(opts.definitionName, opts.input, this.executionOptions(opts, taskRunId)),
    )
    if (owned) owned.executePromise = executePromise
    return executePromise
  }

  private executionOptions(opts: StartTaskRunOptions, taskRunId: string) {
    return {
      workspaceRoot: opts.workspaceRoot,
      currentProject: opts.executionProject,
      executionProject: opts.executionProject,
      workingDirectory: opts.workingDirectory,
      worktreeId: opts.worktree,
      taskId: taskRunId,
      connectingId: opts.connectingId,
      taskContext: opts.taskContext,
      primitives: this.agentPrimitives(taskRunId),
      taskDispatchResolver: this.taskDispatchResolver,
      taskSettingsResolver: this.taskSettingsResolver,
      ...(this.taskRouteState !== undefined ? { taskRouteState: this.taskRouteState } : {}),
      ...(opts.invocationSettings !== undefined ? { invocationSettings: opts.invocationSettings } : {}),
      taskRunWriteLock: true,
    }
  }

  private async runTaskWithLifecycleFinalizer(
    taskRunId: string,
    lockHeld: boolean,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run()
    } catch (error: unknown) {
      await this.handleUnhandledExecutionError(taskRunId, error)
    } finally {
      await this.finalizeOwnedRunLifecycle(taskRunId, lockHeld)
    }
  }

  private async finalizeOwnedRunLifecycle(taskRunId: string, lockHeld: boolean): Promise<void> {
    const owned = this.ownedRuns.get(taskRunId)
    if (!owned) return
    owned.childAdmissionClosed = true
    while (owned.childPromises.size > 0) {
      const pending = [...owned.childPromises]
      await Promise.all(pending.map((child) => child.catch(() => undefined)))
    }
    if (lockHeld && owned.lockHeld) {
      this.repoWriteLocks?.releaseByTaskRun(taskRunId)
      owned.lockHeld = false
    }
    if (this.ownedRuns.get(taskRunId) === owned) {
      this.ownedRuns.delete(taskRunId)
    }
  }

  private guardDetachedExecutionChain(taskRunId: string, executePromise: Promise<void>): void {
    void executePromise.catch(() => undefined)
  }

  private async waitForAdmissionThenExecute(
    opts: StartTaskRunOptions,
    taskRunId: string,
  ): Promise<void> {
    const owned = this.ownedRuns.get(taskRunId)
    if (!owned || !this.repoWriteLocks) return

    const acquireOrWait = (): Promise<void> => new Promise((resolve) => {
      const ownedState = this.ownedRuns.get(taskRunId)
      if (!ownedState || ownedState.cancelled) {
        resolve()
        return
      }
      ownedState.settleAdmissionWait = resolve

      const startedAt = new Date().toISOString()
      const result = this.repoWriteLocks!.tryAcquireTaskRun(
        opts.workingDirectory,
        taskRunId,
        opts.writePaths,
        {
          sessionId: opts.sessionId,
          taskName: opts.taskName,
          startedAt,
        },
      )
      if (result.acquired) {
        ownedState.lockHeld = true
        resolve()
        return
      }

      ownedState.waitUnsubscribe?.()
      const unsubscribe = this.repoWriteLocks!.subscribeRelease(opts.workingDirectory, () => {
        ownedState.waitUnsubscribe = undefined
        ownedState.settleAdmissionWait = undefined
        void acquireOrWait().then(resolve)
      })
      ownedState.waitUnsubscribe = unsubscribe
    })

    await acquireOrWait()

    const ownedAfterWait = this.ownedRuns.get(taskRunId)
    if (!ownedAfterWait || ownedAfterWait.cancelled || !ownedAfterWait.lockHeld) {
      await this.finalizeOwnedRunLifecycle(taskRunId, ownedAfterWait?.lockHeld ?? false)
      return
    }

    await this.runTaskWithLifecycleFinalizer(taskRunId, true, () =>
      this.taskRunner.execute(opts.definitionName, opts.input, this.executionOptions(opts, taskRunId)),
    )
  }

  private armRefusedSessionNotice(sessionId: string, scope: RefusedSessionWriteScope): void {
    if (!this.repoWriteLocks || !this.refusedSessionNotifier) return

    const key = refusedSessionScopeKey(sessionId, scope)
    if (this.refusedSessionWaits.has(key)) return

    const notifyIfFree = (): boolean => {
      if (this.repoWriteLocks!.findTaskRunConflict(scope.workingDirectory, scope.writePaths) !== undefined) {
        return false
      }
      const unsubscribe = this.refusedSessionWaits.get(key)
      unsubscribe?.()
      this.refusedSessionWaits.delete(key)
      void Promise.resolve(this.refusedSessionNotifier!(sessionId, scope)).catch((error: unknown) => {
        this.log('warn', `[foreman] refused-session write-target notice failed: ${errorMessage(error)}`, error)
      })
      return true
    }

    let unsubscribe: (() => void) | undefined
    const onRelease = (): void => {
      unsubscribe = undefined
      this.refusedSessionWaits.delete(key)
      if (!notifyIfFree()) armWait()
    }
    const armWait = (): void => {
      unsubscribe = this.repoWriteLocks!.subscribeRelease(scope.workingDirectory, onRelease)
      this.refusedSessionWaits.set(key, () => unsubscribe?.())
      // Close the check/subscribe race: a release between the preceding check
      // and subscription may otherwise leave this waiter asleep indefinitely.
      if (notifyIfFree()) {
        unsubscribe?.()
        unsubscribe = undefined
      }
    }

    if (!notifyIfFree()) armWait()
  }

  private acceptedHandle(taskRunId: string, createdAt: string): TaskRunAcceptedHandle {
    return {
      id: taskRunId,
      task_run_id: taskRunId,
      status: 'queued',
      created_at: createdAt,
      hint: `Use task_status with id "${taskRunId}" for status, then task_output with the same id for result. Do not poll repeatedly.`,
    }
  }

  private async handleUnhandledExecutionError(taskRunId: string, error: unknown): Promise<void> {
    if (taskErrorField(error, 'failure_category') === 'task_cancelled') {
      this.log('info', `[foreman] task ${taskRunId} cancelled during execution: ${errorMessage(error)}`, error)
      return
    }
    const message = errorMessage(error)
    this.log('error', `[foreman] task ${taskRunId} unhandled error: ${message}`, error)
    try {
      await this.markTaskPlaceholderFailed(
        taskRunId,
        message,
        taskErrorField(error, 'failure_category'),
        taskErrorField(error, 'suggestion'),
        taskErrorField(error, 'error_message'),
      )
    } catch (reportError: unknown) {
      this.log(
        'error',
        `[foreman] task ${taskRunId} failed to persist unhandled error: ${errorMessage(reportError)}`,
        { originalError: error, reportError },
      )
    }
  }

  private taskRuns(): TaskRunStore {
    return new TaskRunStore(this.db)
  }

  private agentPrimitives(taskRunId: string): Partial<PrimitiveSet> {
    const host = this.agentExecutionHost
    return {
      agent: createAgentPrimitive({
        waitExecution: (executionId) => host.waitExecution(executionId),
        getExecution: (executionId) => host.getExecution(executionId),
        cancelExecution: (executionId) => host.cancelExecution(executionId),
        startExecution: async (opts) => {
          const owned = this.ownedRuns.get(taskRunId)
          if (!owned || owned.cancelled || owned.childAdmissionClosed) {
            throw taskRunCancelledError('Task run cancelled before execution launch')
          }

          let resolveHandle!: (handle: Awaited<ReturnType<AgentExecutionHost['startExecution']>>) => void
          let rejectHandle!: (error: unknown) => void
          const handleReady = new Promise<Awaited<ReturnType<AgentExecutionHost['startExecution']>>>((resolve, reject) => {
            resolveHandle = resolve
            rejectHandle = reject
          })

          const childPromise = (async () => {
            try {
              const handle = await host.startExecution(opts)
              const active = this.ownedRuns.get(taskRunId)
              if (!active || active.cancelled || active.childAdmissionClosed) {
                await host.cancelExecution(handle.executionId).catch(() => undefined)
                try { await handle.wait() } catch { /* child settled */ }
                throw taskRunCancelledError('Task run cancelled during execution launch')
              }
              active.activeExecutions.add(handle.executionId)
              resolveHandle(handle)
              try {
                await handle.wait()
              } finally {
                active.activeExecutions.delete(handle.executionId)
              }
              return handle
            } catch (error: unknown) {
              rejectHandle(error)
              throw error
            }
          })()

          owned.childPromises.add(childPromise)
          void childPromise
            .finally(() => { owned.childPromises.delete(childPromise) })
            .catch(() => undefined)

          return handleReady
        },
      }),
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

function refusedSessionScopeKey(sessionId: string, scope: RefusedSessionWriteScope): string {
  return `${sessionId}\0${scope.workingDirectory}\0${scope.writePaths.join('\0')}`
}

function formatWriteLockConflictMessage(holder: TaskRunWriteLockConflict): string {
  const holderRef = holder.taskRunId ?? holder.holderExecutionId ?? 'unknown'
  const overlap = holder.overlappingTargets.length > 0
    ? holder.overlappingTargets.join(', ')
    : 'repository'
  return (
    `Write lock conflict with holder ${holderRef}` +
    ` (session ${holder.sessionId ?? 'n/a'}, task ${holder.taskName ?? 'n/a'}, since ${holder.startedAt});` +
    ` overlapping: ${overlap}`
  )
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

function taskRunCancelledError(message: string): Error & { failure_category: 'task_cancelled' } {
  const error = new Error(message) as Error & { failure_category: 'task_cancelled' }
  error.failure_category = 'task_cancelled'
  return error
}
