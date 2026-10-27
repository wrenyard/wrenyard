import type { ForemanDatabase, RunResult } from '../types.mts'
import { markStatsProjectionDirty } from '../../events/stats-query.mts'
import { toJsonText } from './json.mts'

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
  facts?: string | null
}

export class TaskRunStore {
  constructor(private readonly db: ForemanDatabase) {}

  insertAcceptedPlaceholder(write: AcceptedTaskRunPlaceholder): void {
    this.run(
      `INSERT OR IGNORE INTO tasks (
        id, template, project, worktree, input, definition_source, status, structured,
        retry_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 'side-effects', ?, ?)`,
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

  /**
   * Register (or re-register) an accepted run. It is `queued` until its first
   * execution launches; {@link markStarted} then moves it to `running`.
   */
  markRunning(write: RunningTaskRunWrite): 'cancelled' | 'interrupted' | null {
    const existing = this.get<{ status: string }>(
      `SELECT status FROM tasks WHERE id = ? AND (status = 'cancelled' OR status = 'interrupted')`,
      write.taskRunId,
    )
    if (existing?.status === 'cancelled') return 'cancelled'

    this.run(
      `INSERT INTO tasks (
        id, template, project, worktree, input, definition_source, workflow_id, status, structured,
        retry_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'side-effects', ?, ?)
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
        status = 'queued',
        started_at = NULL,
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
    const applied = this.run(
      `UPDATE tasks
      SET status = ?, output = ?, summary = ?, error = ?,
        failure_category = ?, suggestion = ?, error_message = ?,
        facts = COALESCE(?, facts),
        ended_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
      write.status,
      toJsonText(write.output),
      write.summary ?? null,
      write.error ?? null,
      write.failureCategory ?? null,
      write.suggestion ?? null,
      write.errorMessage ?? null,
      write.facts ?? null,
      write.endedAt,
      write.endedAt,
      write.taskRunId,
    ).changes > 0
    if (applied) this.projectTerminalInterval(write)
    return applied
  }

  /**
   * Project the terminal task interval (outcome attributed to the ended_at
   * day, duration overlap over created_at→ended_at) into stats_task_interval
   * in the same write boundary. Only runs whose UPDATE matched reach this
   * point, so repeat terminal calls are idempotent via INSERT OR REPLACE;
   * late-arriving client usage may still dirty the run afterwards.
   */
  private projectTerminalInterval(write: TerminalTaskRunWrite): void {
    const row = this.get<{ template: string | null; definition_source: string | null; created_at: string; ended_at: string | null; status: string }>(
      `SELECT template, definition_source, created_at, ended_at, status FROM tasks WHERE id = ?`,
      write.taskRunId,
    )
    if (!row?.ended_at) return
    this.run(
      `INSERT OR REPLACE INTO stats_task_interval (task_id, template, definition_source, status, created_at, effective_end)
       VALUES (?, ?, ?, ?, ?, ?)`,
      write.taskRunId,
      row.template,
      row.definition_source,
      row.status,
      row.created_at,
      row.ended_at,
    )
    markStatsProjectionDirty({ taskTransition: { taskRunId: write.taskRunId, status: row.status } })
  }

  attachExecution(taskRunId: string, executionId: string, updatedAt: string): boolean {
    return this.run(
      `UPDATE tasks
      SET execution_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
      executionId,
      updatedAt,
      taskRunId,
    ).changes > 0
  }

  /** An execution of this run launched: it is running, and its first launch is its start time. */
  markStarted(taskRunId: string, at: string): boolean {
    return this.run(
      `UPDATE tasks
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
      at,
      at,
      taskRunId,
    ).changes > 0
  }

  /** An execution of this run is waiting for admission (a write lock or a slot). */
  markWaiting(taskRunId: string, at: string): boolean {
    return this.run(
      `UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'running'`,
      at,
      taskRunId,
    ).changes > 0
  }

  markAllInterrupted(endedAt: string): number {
    // Bulk terminal transition (daemon stop): project each newly interrupted
    // run's interval before flipping statuses so the projection write reads
    // the same task rows; only rows still queued/running here are affected.
    const candidates = this.db.prepare<unknown[], { id: string; template: string | null; definition_source: string | null; created_at: string }>(
      `SELECT id, template, definition_source, created_at FROM tasks WHERE status IN ('queued', 'running')`,
    ).all()
    const applied = this.run(
      `UPDATE tasks
      SET status = 'interrupted', ended_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running')`,
      endedAt,
      endedAt,
    ).changes
    if (applied > 0) {
      const insert = this.db.prepare<unknown[]>(
        `INSERT OR REPLACE INTO stats_task_interval (task_id, template, definition_source, status, created_at, effective_end)
         VALUES (?, ?, ?, 'interrupted', ?, ?)`,
      )
      for (const row of candidates) {
        insert.run(row.id, row.template, row.definition_source, row.created_at, endedAt)
      }
    }
    return applied
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
