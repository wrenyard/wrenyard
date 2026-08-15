import { getDb } from '../db/connection.mts'
import type { ForemanDatabase } from '../db/types.mts'
import { compactJsonRecord, toJsonText } from '../db/stores/json.mts'
import { getForemanEventBus } from './event-bus.mts'
import type { ForemanEvent, ForemanEventSeverity } from './event-types.mts'

const FOREMAN_EVENT_SCHEMA_VERSION = 'foreman.event.v1'

export interface StoredForemanEvent {
  cursor: number
  event: ForemanEvent
}

export interface EventListOptions {
  limit?: number
  kinds?: string[]
}

export interface EventStreamOptions extends EventListOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
}

interface EventRow {
  id: number
  execution_id: string | null
  task_id: string | null
  type: string
  timestamp: string
  data: string | null
  is_error: number | null
}

interface EventPayload {
  schema_version?: string
  event_id?: string
  source?: string
  severity?: ForemanEventSeverity
  refs?: ForemanEvent['refs']
  data?: Record<string, unknown>
}

export class ForemanEventStore {
  constructor(private readonly db: ForemanDatabase) {}

  append(event: ForemanEvent): StoredForemanEvent {
    const payload = compactJsonRecord({
      schema_version: FOREMAN_EVENT_SCHEMA_VERSION,
      event_id: event.id,
      source: event.source,
      severity: event.severity,
      refs: event.refs,
      data: event.data,
    })
    const executionId = this.existingId('executions', event.refs.executionId)
    const taskId = this.existingId('tasks', event.refs.taskId)
    const seq = executionId ? this.nextExecutionSequence(executionId) : 0
    const result = this.db.prepare<unknown[]>(
      `INSERT INTO events (
        execution_id, task_id, seq, type, timestamp, data,
        status, exit_code, is_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      executionId,
      taskId,
      seq,
      event.kind,
      event.occurredAt,
      toJsonText(payload),
      event.severity === 'error' ? 1 : 0,
      event.occurredAt,
    )

    return {
      cursor: Number(result.lastInsertRowid),
      event,
    }
  }

  listSince(cursor: number, options: EventListOptions = {}): StoredForemanEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000))
    const kindFilter = options.kinds?.filter((kind) => kind.trim())
    const params: unknown[] = [cursor]
    let where = `id > ?`
    if (kindFilter?.length) {
      where += ` AND type IN (${kindFilter.map(() => '?').join(', ')})`
      params.push(...kindFilter)
    }
    params.push(limit)

    const rows = this.db.prepare<unknown[], EventRow>(
      `SELECT id, execution_id, task_id, type, timestamp, data, is_error
      FROM events
      WHERE ${where}
      ORDER BY id ASC
      LIMIT ?`,
    ).all(...params)

    return rows
      .map((row) => this.eventFromRow(row))
      .filter((event): event is StoredForemanEvent => event !== null)
  }

  async *listStream(cursor: number, options: EventStreamOptions = {}): AsyncGenerator<StoredForemanEvent> {
    let nextCursor = cursor
    const pollIntervalMs = options.pollIntervalMs ?? 500
    while (!options.signal?.aborted) {
      const batch = this.listSince(nextCursor, options)
      if (batch.length > 0) {
        for (const stored of batch) {
          nextCursor = stored.cursor
          yield stored
        }
        continue
      }
      await sleep(pollIntervalMs, options.signal)
    }
  }

  private nextExecutionSequence(executionId: string): number {
    const row = this.db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE execution_id = ?`,
    ).get(executionId)
    return row?.seq ?? 1
  }

  private existingId(table: 'executions' | 'tasks', id: string | undefined): string | null {
    if (!id) return null
    const row = this.db.prepare<[string], { id: string }>(
      `SELECT id FROM ${table} WHERE id = ?`,
    ).get(id)
    return row?.id ?? null
  }

  private eventFromRow(row: EventRow): StoredForemanEvent | null {
    const payload = parsePayload(row.data)
    if (payload?.schema_version !== FOREMAN_EVENT_SCHEMA_VERSION) return null
    const event: ForemanEvent = {
      id: typeof payload.event_id === 'string' ? payload.event_id : `foreman:event:${row.id}`,
      kind: row.type,
      source: typeof payload.source === 'string' ? payload.source : 'foreman.daemon',
      severity: payload.severity ?? (row.is_error ? 'error' : 'info'),
      refs: {
        ...(payload.refs ?? {}),
        ...(row.execution_id ? { executionId: row.execution_id } : {}),
        ...(row.task_id ? { taskId: row.task_id } : {}),
      },
      data: payload.data,
      occurredAt: row.timestamp,
    }
    return { cursor: row.id, event }
  }
}

export function getForemanEventStore(): ForemanEventStore {
  return new ForemanEventStore(getDb())
}

export async function appendForemanEvent(event: ForemanEvent): Promise<StoredForemanEvent> {
  const stored = getForemanEventStore().append(event)
  await getForemanEventBus().publish(event)
  return stored
}

function parsePayload(data: string | null): EventPayload | null {
  if (!data) return null
  try {
    const parsed = JSON.parse(data) as unknown
    return parsed && typeof parsed === 'object' ? parsed as EventPayload : null
  } catch {
    return null
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
