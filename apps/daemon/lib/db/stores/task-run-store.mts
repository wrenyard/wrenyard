import type { ForemanDatabase, RunResult } from '../types.mts'
import { toJsonText, toOutputText } from './json.mts'

export type TaskRunStoreStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export type TaskRunTerminalStatus = Exclude<TaskRunStoreStatus, 'queued' | 'running'>
export type TaskRunDefinitionSource = 'builtin' | 'project' | null

export interface RunningTaskRunWrite {
  taskRunId: string
  template: string
  project: string | null
  worktree: string | null
  input: unknown
  workflowId: string | null
  structured: boolean
  startedAt: string
  updatedAt: string
  resumeInterruptedTask: boolean
  /** Authoritative resolved definition provenance; null for pre-migration unknown. */
  definitionSource: TaskRunDefinitionSource
}

export interface AcceptedTaskRunPlaceholder {
  taskRunId: string
  template: string
  project: string | null
  worktree: string | null
  input: unknown
  structured: boolean
  createdAt: string
  /** Authoritative resolved definition provenance; null for pre-migration unknown. */
  definitionSource?: TaskRunDefinitionSource
}

export interface TerminalTaskRunWrite {
  taskRunId: string
  status: TaskRunTerminalStatus
  output?: unknown
  summary?: string | null
  error?: string | null
  endedAt: string
  failureCategory?: string | null
  suggestion?: string | null
  errorMessage?: string | null
}

export class TaskRunStore {
  constructor(private readonly db: ForemanDatabase) {}

  insertAcceptedPlaceholder(write: AcceptedTaskRunPlaceholder): void {
    this.run(
      `INSERT OR IGNORE INTO tasks (
        id, template, project, worktree, input, definition_source, status, structured,
        retry_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 'side-effects', ?, ?)`,
      write.taskRunId,
      write.template,
      write.project,
      write.worktree,
      toJsonText(write.input),
      write.definitionSource ?? null,
      write.structured ? 1 : 0,
      write.createdAt,
      write.createdAt,
    )
  }

  markRunning(write: RunningTaskRunWrite): 'cancelled' | 'interrupted' | null {
    const existing = this.get<{ status: string }>(
      `SELECT status FROM tasks WHERE id = ? AND (status = 'cancelled' OR status = 'interrupted')`,
      write.taskRunId,
    )
    if (existing?.status === 'cancelled') return 'cancelled'
    if (existing?.status === 'interrupted' && !write.resumeInterruptedTask) return 'interrupted'

    this.run(
      `INSERT INTO tasks (
        id, template, project, worktree, input, definition_source, workflow_id, status, structured,
        retry_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, 'side-effects', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template = excluded.template,
        project = excluded.project,
        worktree = excluded.worktree,
        input = excluded.input,
        definition_source = excluded.definition_source,
        workflow_id = excluded.workflow_id,
        output = NULL,
        summary = NULL,
        error = NULL,
        status = 'running',
        structured = excluded.structured,
        execution_id = NULL,
        retry_policy = excluded.retry_policy,
        updated_at = excluded.updated_at,
        ended_at = NULL`,
      write.taskRunId,
      write.template,
      write.project,
      write.worktree,
      toJsonText(write.input),
      write.definitionSource ?? null,
      write.workflowId,
      write.structured ? 1 : 0,
      write.startedAt,
      write.updatedAt,
    )
    return null
  }

  markTerminal(write: TerminalTaskRunWrite): boolean {
    return this.run(
      `UPDATE tasks
      SET status = ?, output = ?, summary = ?, error = ?,
        failure_category = ?, suggestion = ?, error_message = ?,
        ended_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
      write.status,
      toOutputText(write.output),
      write.summary ?? null,
      write.error ?? null,
      write.failureCategory ?? null,
      write.suggestion ?? null,
      write.errorMessage ?? null,
      write.endedAt,
      write.endedAt,
      write.taskRunId,
    ).changes > 0
  }

  attachExecution(taskRunId: string, executionId: string, updatedAt: string): boolean {
    return this.run(
      `UPDATE tasks
      SET status = 'running', execution_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
      executionId,
      updatedAt,
      taskRunId,
    ).changes > 0
  }

  markAllInterrupted(endedAt: string): number {
    return this.run(
      `UPDATE tasks
      SET status = 'interrupted', ended_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running')`,
      endedAt,
      endedAt,
    ).changes
  }

  markNotifiedViaChannel(taskRunId: string, updatedAt: string): boolean {
    return this.run(
      `UPDATE tasks SET notified_via_channel = 1, updated_at = ? WHERE id = ?`,
      updatedAt,
      taskRunId,
    ).changes > 0
  }

  readStatus(taskRunId: string): TaskRunStoreStatus | null {
    const row = this.get<{ status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
      taskRunId,
    )
    switch (row?.status) {
      case 'queued':
      case 'running':
      case 'done':
      case 'failed':
      case 'cancelled':
      case 'interrupted':
        return row.status
      default:
        return null
    }
  }

  private run(sql: string, ...params: unknown[]): RunResult {
    return this.db.prepare<unknown[]>(sql).run(...params)
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare<unknown[], T>(sql).get(...params)
  }
}
