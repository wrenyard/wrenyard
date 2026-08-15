import type { ForemanDatabase, RunResult } from '../types.mts'

export class WorkflowRunStore {
  constructor(private readonly db: ForemanDatabase) {}

  /**
   * Cancel every non-terminal workflow row. Called once during daemon bootstrap
   * after schema init so planned restart cannot wait for a runner that no
   * longer exists. Tables are retained; this is not a destructive migration.
   */
  markAllNonTerminalCancelled(endedAt: string): number {
    return this.run(
      `UPDATE workflows
      SET status = 'cancelled', error = 'Workflow run cancelled', current_phase = 'Cancelled',
        ended_at = ?, updated_at = ?
      WHERE status NOT IN ('done', 'failed', 'cancelled')`,
      endedAt,
      endedAt,
    ).changes
  }

  private run(sql: string, ...params: unknown[]): RunResult {
    return this.db.prepare<unknown[]>(sql).run(...params)
  }
}
