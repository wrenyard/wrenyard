import type { ForemanDatabase } from '../types.mts'
import { compactJsonRecord, toJsonText } from './json.mts'

export interface TaskLifecycleEventWrite {
  taskRunId: string
  kind: 'task.started' | 'task.done' | 'task.failed'
  taskName: string
  project: string
  status: string
  summary?: string | null
  output?: unknown
  error?: string | null
  failureCategory?: string | null
  suggestion?: string | null
  errorMessage?: string | null
  startedAt: string
  finishedAt?: string | null
  timestamp: string
}

export interface ExecutionEventWrite {
  executionId: string
  taskId?: string
  seq: number
  type: string
  data: unknown
  status?: 'done' | 'failed'
  exitCode?: number | null
  isError?: 0 | 1
  timestamp: string
}

export class ExecutionEventStore {
  constructor(private readonly db: ForemanDatabase) {}

  /**
   * Persist one execution event and its telemetry effects in a single
   * transaction. The event row is inserted with `INSERT OR IGNORE` so
   * duplicate delivery, reattach, and replay of an already-persisted
   * (execution_id, seq) row never double count; telemetry is only applied
   * when the row was actually inserted. Retries and resumed attempts that
   * produce genuinely new sequence numbers count exactly once.
   */
  insertExecutionEvent(write: ExecutionEventWrite): void {
    this.db.transaction(() => {
      const result = this.db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO events (
          execution_id, task_id, seq, type, timestamp, data, status, exit_code, is_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        write.executionId,
        write.taskId ?? null,
        write.seq,
        write.type,
        write.timestamp,
        toJsonText(write.data ?? {}),
        write.status ?? null,
        write.exitCode ?? null,
        write.isError ?? null,
        write.timestamp,
      )
      if (result.changes !== 1) return
      this.applyTelemetry(write)
    })()
  }

  maxSequence(executionId: string): number {
    const row = this.db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) AS seq
      FROM events
      WHERE execution_id = ?`,
    ).get(executionId)
    return row?.seq ?? 0
  }

  insertTaskLifecycle(write: TaskLifecycleEventWrite): void {
    const isFailed = write.kind === 'task.failed'
    const data = compactJsonRecord({
      schema_version: 'foreman.task_lifecycle.v1',
      task_id: write.taskRunId,
      task_name: write.taskName,
      project: write.project,
      status: write.status,
      summary: write.summary,
      output: write.kind === 'task.done' ? write.output : undefined,
      error: isFailed ? write.error : undefined,
      failure_category: write.failureCategory,
      suggestion: write.suggestion,
      error_message: write.errorMessage,
      started_at: write.startedAt,
      finished_at: write.finishedAt,
    })

    this.db.transaction(() => {
      this.db.prepare<unknown[]>(
        `INSERT INTO events (
          execution_id, task_id, seq, type, timestamp, data,
          status, exit_code, is_error, created_at
        ) VALUES (NULL, ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        write.taskRunId,
        write.kind,
        write.timestamp,
        toJsonText(data),
        write.status,
        isFailed ? 1 : 0,
        write.timestamp,
      )
      // Every new task run materializes its durable zero/true telemetry row
      // atomically with the task.started lifecycle event.
      this.ensureTelemetryRow(write.taskRunId, write.timestamp)
    })()
  }

  /**
   * Atomically create the bounded per-task-run telemetry row at its zero
   * counters / tps_complete=true defaults. `INSERT OR IGNORE` makes
   * initialization idempotent across lifecycle events and event streaming.
   */
  private ensureTelemetryRow(taskRunId: string, timestamp: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO task_run_telemetry (
        task_run_id, tool_call_count, usage_event_count, output_tokens,
        agent_turn_ms, tps_complete, created_at, updated_at
      ) VALUES (?, 0, 0, 0, 0, 1, ?, ?)`,
    ).run(taskRunId, timestamp, timestamp)
  }

  /**
   * Increment durable counters only for events that were genuinely inserted.
   * tool_call events count once each; tool_result events never count. A valid
   * agent-turn usage event (exact token_scope=agent_turn,
   * duration_scope=agent_turn, tps_contract=agent_turn_v1) sums output_tokens
   * and duration_ms into output_tokens/agent_turn_ms and bumps
   * usage_event_count; any persisted usage that is missing, invalid, or not
   * the exact versioned contract permanently clears tps_complete so the run
   * can never report a fabricated TPS.
   */
  private applyTelemetry(write: ExecutionEventWrite): void {
    const taskRunId = write.taskId
    if (!taskRunId) return
    this.ensureTelemetryRow(taskRunId, write.timestamp)
    if (write.type === 'tool_call') {
      this.db.prepare(
        `UPDATE task_run_telemetry
         SET tool_call_count = tool_call_count + 1, updated_at = ?
         WHERE task_run_id = ?`,
      ).run(write.timestamp, taskRunId)
      return
    }
    if (write.type !== 'turn_usage') return
    const usage = parseAgentTurnUsage(write.data)
    if (usage) {
      this.db.prepare(
        `UPDATE task_run_telemetry
         SET usage_event_count = usage_event_count + 1,
             output_tokens = output_tokens + ?,
             agent_turn_ms = agent_turn_ms + ?,
             updated_at = ?
         WHERE task_run_id = ?`,
      ).run(usage.outputTokens, usage.durationMs, write.timestamp, taskRunId)
      return
    }
    this.db.prepare(
      `UPDATE task_run_telemetry
       SET tps_complete = 0, updated_at = ?
       WHERE task_run_id = ?`,
    ).run(write.timestamp, taskRunId)
  }
}

interface AgentTurnUsage {
  outputTokens: number
  durationMs: number
}

/**
 * A persisted turn_usage event qualifies as complete agent-turn usage only
 * when it carries the exact three-field versioned contract — token_scope
 * exactly 'agent_turn', duration_scope exactly 'agent_turn', and
 * tps_contract exactly 'agent_turn_v1' — with output_tokens an integer >= 0
 * and a finite, positive duration_ms. Absent/invalid output or duration as
 * well as any unversioned or wrong-scope/contract value (for example
 * 'model_output' or a missing tps_contract) disqualify the event, which
 * permanently disables TPS for the task run.
 */
function parseAgentTurnUsage(data: unknown): AgentTurnUsage | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const outputTokens = record.output_tokens
  const durationMs = record.duration_ms
  const validOutputTokens = typeof outputTokens === 'number' && Number.isInteger(outputTokens) && outputTokens >= 0
  const validDurationMs = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
  const validContract = record.token_scope === 'agent_turn'
    && record.duration_scope === 'agent_turn'
    && record.tps_contract === 'agent_turn_v1'
  if (!validOutputTokens || !validDurationMs || !validContract) return undefined
  return { outputTokens, durationMs }
}
