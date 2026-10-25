import { randomBytes } from 'node:crypto'
import { query as dbQuery } from '../db/connection.mts'
import type { ForemanEvent } from '../events/event-types.mts'

export interface TaskUsageLive {
  input: number
  cachedInput: number
  output: number
  requests: number
}

/** Identity returned per live usage record: the gateway execution plus its
 *  owning task run when one is known. */
export interface TaskUsageLiveRecord {
  taskRunId?: string
  executionId: string
  usage: TaskUsageLive
}

/**
 * Emission window: at most one task.usage.live event per execution per
 * interval, with a one-shot trailing flush so a request burst that stops
 * inside the window still delivers its final cumulative totals. The flush is
 * a single scheduled send per burst, not a repeating poll.
 */
const LIVE_USAGE_EMIT_INTERVAL_MS = 1_500

const TERMINAL_RUN_EVENT_KINDS = new Set([
  'task.run.completed',
  'task.run.failed',
  'task.run.cancelled',
  'task.run.interrupted',
])

interface LiveUsageEntry {
  usage: TaskUsageLive
  /** Owning task run id, resolved once at registration. */
  taskRunId?: string
  /** Resolved dispatch mode; only 'gateway' executions are ever registered. */
  mode?: 'native' | 'gateway'
  /** Epoch ms of the last emitted task.usage.live event; 0 means never emitted. */
  lastEmitAt: number
  /** Usage accumulated since the last emit; triggers the trailing flush. */
  dirty: boolean
  /** One-shot trailing flush for a throttled burst; cleared on emit/drop. */
  flushTimer: ReturnType<typeof setTimeout> | undefined
}

interface LiveUsageEmitterDeps {
  /** Cheap executionId -> taskRunId lookup (cached by the accumulator). */
  resolveTaskRunId: (executionId: string) => string | undefined
}

/**
 * In-memory cumulative usage for running gateway executions. Membership is
 * explicit: an execution is registered at start with its taskRunId/mode and
 * dropped on every terminal path, so membership itself is the active-set
 * bound — there is no capacity eviction and no tombstone set. Feeds are
 * accepted only for registered active gateway executions, so a late
 * gateway.request.completed observed after the terminal drop is rejected by
 * the membership check rather than remembered forever. Holds no timers beyond
 * the per-entry one-shot trailing flush and no database state of its own.
 */
export class LiveUsageAccumulator {
  private readonly entries = new Map<string, LiveUsageEntry>()
  private readonly executionByTaskRun = new Map<string, string>()
  private readonly deps: LiveUsageEmitterDeps
  private emitFn: ((event: ForemanEvent) => void | Promise<void>) | undefined
  private disposed = false

  constructor(deps: LiveUsageEmitterDeps) {
    this.deps = deps
  }

  /**
   * Bind the persisted append + publish emitter once the event store exists.
   * Until bound, a scheduled flush is a no-op other than clearing dirty state;
   * the daemon binds this immediately after construction in the same startup
   * sequence, before any execution can run.
   */
  bindEmit(emit: (event: ForemanEvent) => void | Promise<void>): void {
    this.emitFn = emit
  }

  /**
   * Register an active gateway execution at its start. Only gateway-mode
   * executions accumulate live usage; native executions are never admitted.
   * Re-registering an already-tracked execution is a no-op.
   */
  register(executionId: string, opts: { taskRunId?: string; mode?: 'native' | 'gateway' } = {}): void {
    if (this.disposed) return
    if (executionId === '') return
    // Only executions launched in gateway mode accumulate live usage; a
    // native or mode-less execution is never admitted.
    if (opts.mode !== 'gateway') return
    if (this.entries.has(executionId)) return
    const taskRunId = opts.taskRunId ?? this.deps.resolveTaskRunId(executionId)
    this.entries.set(executionId, {
      usage: { input: 0, cachedInput: 0, output: 0, requests: 0 },
      ...(taskRunId === undefined ? {} : { taskRunId }),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
      lastEmitAt: 0,
      dirty: false,
      flushTimer: undefined,
    })
    if (taskRunId !== undefined) this.executionByTaskRun.set(taskRunId, executionId)
  }

  /**
   * Accumulate one completed gateway request and, when the per-execution
   * throttle window has elapsed, emit a persisted task.usage.live event.
   * Feeds for executions that were never registered (or already dropped) are
   * rejected by membership, so no tombstone state is retained.
   */
  async feed(executionId: string, usage: { input?: number; cachedInput?: number; output?: number } | undefined): Promise<void> {
    if (executionId === '' || usage === undefined) return
    const entry = this.entries.get(executionId)
    if (entry === undefined) return
    entry.usage.input += usage.input ?? 0
    entry.usage.cachedInput += usage.cachedInput ?? 0
    entry.usage.output += usage.output ?? 0
    entry.usage.requests += 1

    const now = Date.now()
    const elapsed = now - entry.lastEmitAt
    if (elapsed >= LIVE_USAGE_EMIT_INTERVAL_MS) {
      await this.flush(executionId, entry, now)
      return
    }
    // Inside the throttle window: mark the burst dirty and arm a one-shot
    // flush so the final cumulative totals are delivered even when no
    // further request arrives. Only one timer per execution is ever live.
    entry.dirty = true
    if (entry.flushTimer === undefined) {
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = undefined
        // The entry may have been dropped by a terminal event meanwhile;
        // re-check membership before emitting.
        if (this.entries.get(executionId) === entry && entry.dirty) {
          void this.flush(executionId, entry)
        }
      }, LIVE_USAGE_EMIT_INTERVAL_MS - elapsed)
      entry.flushTimer.unref?.()
    }
  }

  /** Emit the current cumulative sample for one execution. */
  private async flush(executionId: string, entry: LiveUsageEntry, now = Date.now()): Promise<void> {
    entry.lastEmitAt = now
    entry.dirty = false
    const taskRunId = entry.taskRunId ?? this.deps.resolveTaskRunId(executionId)
    const event: ForemanEvent = {
      id: `task_usage_live_${randomBytes(12).toString('hex')}`,
      kind: 'task.usage.live',
      source: 'wrenyard.task',
      severity: 'info',
      refs: {
        executionId,
        ...(taskRunId === undefined ? {} : { taskRunId }),
      },
      data: {
        executionId,
        usage: { ...entry.usage },
        ...(taskRunId === undefined ? {} : { taskRunId }),
      },
      occurredAt: new Date().toISOString(),
    }
    await this.emitFn?.(event)
  }

  /** Drop an execution's accumulated state (terminal path reached). */
  drop(executionId: string): void {
    const entry = this.entries.get(executionId)
    if (entry === undefined) return
    if (entry.flushTimer !== undefined) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = undefined
    }
    this.entries.delete(executionId)
    const taskRunId = entry.taskRunId ?? this.deps.resolveTaskRunId(executionId)
    if (taskRunId !== undefined) this.executionByTaskRun.delete(taskRunId)
  }

  /** Drop by task run id; a no-op when the run was never registered. */
  dropByTaskRunId(taskRunId: string): void {
    const executionId = this.executionByTaskRun.get(taskRunId)
    if (executionId === undefined) return
    this.drop(executionId)
  }

  /** Foreman event sink: clears state on terminal task.run.* events. */
  handleEvent(event: ForemanEvent): void {
    if (!TERMINAL_RUN_EVENT_KINDS.has(event.kind)) return
    if (typeof event.refs.executionId === 'string') this.drop(event.refs.executionId)
    const taskRunId = event.refs.taskRunId ?? event.refs.taskId
    if (typeof taskRunId === 'string') this.dropByTaskRunId(taskRunId)
  }

  /** Current accumulated usage for one execution, when still tracked. */
  snapshot(executionId: string): TaskUsageLive | undefined {
    const entry = this.entries.get(executionId)
    return entry === undefined ? undefined : { ...entry.usage }
  }

  /** Snapshot with identity for every still-tracked execution. */
  list(): TaskUsageLiveRecord[] {
    const records: TaskUsageLiveRecord[] = []
    for (const [executionId, entry] of this.entries) {
      records.push({
        executionId,
        ...(entry.taskRunId === undefined ? {} : { taskRunId: entry.taskRunId }),
        usage: { ...entry.usage },
      })
    }
    return records
  }

  /** Active membership check used by batched readers. */
  has(executionId: string): boolean {
    return this.entries.has(executionId)
  }

  /** Shutdown disposal: clears every pending flush timer and all membership. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      if (entry.flushTimer !== undefined) clearTimeout(entry.flushTimer)
    }
    this.entries.clear()
    this.executionByTaskRun.clear()
  }
}

interface UsageAggregateRow {
  execution_id: string | null
  task_run_id: string | null
  input: number | null
  cached_input: number | null
  output: number | null
  requests: number | null
}

/**
 * Batched initial-value query for `task.usage.liveList`: aggregate every
 * persisted gateway.request.completed row for the requested active gateway
 * execution ids in a single IN-list query served by idx_event_gateway_exec.
 * Identity (taskRunId) is resolved from the dispatch/task rows of the same
 * executions. Callers must batch the whole list; never invoke per id in a
 * loop. Requests are keyed by execution id — never by historical per-request
 * SQL in a hot path.
 */
export function queryTaskUsageLive(executionIds: string[]): Record<string, TaskUsageLiveRecord> {
  const ids = [...new Set(executionIds.filter((id) => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return {}

  const executionField = `json_extract(data, '$.data.executionId')`
  const rows = dbQuery<UsageAggregateRow>(
    `SELECT ${executionField} AS execution_id,
       (SELECT t.id FROM tasks t WHERE t.execution_id = ${executionField} LIMIT 1) AS task_run_id,
       SUM(COALESCE(json_extract(data, '$.data.usage.input'), 0)) AS input,
       SUM(COALESCE(json_extract(data, '$.data.usage.cachedInput'), 0)) AS cached_input,
       SUM(COALESCE(json_extract(data, '$.data.usage.output'), 0)) AS output,
       COUNT(*) AS requests
     FROM events
     WHERE type = 'gateway.request.completed'
       AND ${executionField} IN (${ids.map(() => '?').join(', ')})
     GROUP BY ${executionField}`,
    ...ids,
  )

  const result: Record<string, TaskUsageLiveRecord> = {}
  for (const row of rows) {
    if (row.execution_id === null) continue
    result[row.execution_id] = {
      executionId: row.execution_id,
      ...(row.task_run_id === null ? {} : { taskRunId: row.task_run_id }),
      usage: {
        input: row.input ?? 0,
        cachedInput: row.cached_input ?? 0,
        output: row.output ?? 0,
        requests: row.requests ?? 0,
      },
    }
  }
  return result
}
