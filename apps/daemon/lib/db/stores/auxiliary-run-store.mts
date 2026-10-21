import type { ForemanDatabase, RunResult } from '../types.mts'
import type { RunRecord } from '@wrenyard/protocol'
import { toJsonText } from './json.mts'

/** One persisted auxiliary run row, as read back for the stats ledger. */
export interface AuxiliaryRunRow {
  id: string
  role: string
  caller_origin: string
  caller_id: string | null
  provider: string | null
  model: string | null
  effort: string | null
  status: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  usage: string | null
  summary: string | null
  observations: string | null
}

/**
 * Durable store for finished auxiliary runs. Each run writes exactly one row
 * (INSERT OR REPLACE on id) so a repeated action id never duplicates, and the
 * recent-run ledger reads them back in recency order to union with task runs.
 * Nothing here touches the tasks or executions tables.
 */
export class AuxiliaryRunStore {
  constructor(private readonly db: ForemanDatabase) {}

  insert(record: RunRecord): void {
    const provider = record.route?.provider ?? null
    const model = record.route?.model ?? null
    const effort = record.route?.effort ?? null
    this.run(
      `INSERT OR REPLACE INTO auxiliary_runs (
        id, role, caller_origin, caller_id, provider, model, effort, status,
        created_at, started_at, finished_at, usage, summary, observations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.role ?? null,
      record.caller?.origin ?? 'unknown',
      record.caller?.id ?? null,
      provider,
      model,
      effort,
      record.status,
      record.timing.createdAt,
      record.timing.startedAt ?? null,
      record.timing.finishedAt ?? null,
      record.usage === undefined ? null : toJsonText(record.usage),
      record.summary ?? null,
      record.observations === undefined || record.observations.length === 0
        ? null
        : toJsonText(record.observations),
    )
  }

  readRecent(limit: number): AuxiliaryRunRow[] {
    return this.query<AuxiliaryRunRow>(
      `SELECT id, role, caller_origin, caller_id, provider, model, effort, status,
              created_at, started_at, finished_at, usage, summary, observations
       FROM auxiliary_runs
       ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
       LIMIT ?`,
      limit,
    )
  }

  private run(sql: string, ...params: unknown[]): RunResult {
    return this.db.prepare<unknown[]>(sql).run(...params)
  }

  private query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare<unknown[], T>(sql).all(...params) as T[]
  }
}
