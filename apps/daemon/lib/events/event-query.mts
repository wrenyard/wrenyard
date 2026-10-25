import { get as dbGet, query as dbQuery } from '../db/connection.mts'

export type JsonRecord = Record<string, unknown>

/**
 * Event payload keys the Desktop consumers actually read. Anything else in the
 * stored payload is never parsed or shipped over IPC.
 */
const EVENT_DATA_FIELDS = [
  'role',
  'text',
  'body',
  'message',
  'title',
  'name',
  'input_summary',
  'call_id',
  'status',
  'output_tail',
  'input_tokens',
  'output_tokens',
  'duration_ms',
  'exit_code',
  'exitCode',
  'is_error',
  'summary',
  'profile',
  'cwd',
  'work_dir',
  'workDir',
  'client_family',
  'clientFamily',
  'executionId',
  'taskRunId',
  'usage',
] as const

const EVENT_REF_FIELDS = [
  'taskRunId',
  'taskId',
  'workflowId',
  'executionId',
  'sessionId',
] as const

const EVENT_DATA_PATHS = [
  ...EVENT_DATA_FIELDS.map((field) => `'$.${field}'`),
  ...EVENT_REF_FIELDS.map((field) => `'$.refs.${field}'`),
].join(', ')

interface DbEventRow {
  id: number
  execution_id: string | null
  task_id: string | null
  seq: number
  type: string
  timestamp: string
  status: string | null
  exit_code: number | null
  is_error: number | null
  created_at: string
  /**
   * JSON array of the projected payload values, produced by a single
   * `json_extract` call so SQLite parses each payload once and the process
   * never materializes the full stored object.
   */
  data_fields: string | null
}

/**
 * Read one page of events ordered by id. Only the projected payload fields are
 * returned and the executions table is never consulted, which keeps a
 * 1000-row page cheap.
 */
export function listDbEvents(since = 0, limit = 100): JsonRecord[] {
  const rows = dbQuery<DbEventRow>(
    `SELECT events.id AS id, events.execution_id AS execution_id,
      events.task_id AS task_id,
      events.seq AS seq, events.type AS type, events.timestamp AS timestamp,
      events.status AS status,
      events.exit_code AS exit_code, events.is_error AS is_error,
      events.created_at AS created_at,
      CASE WHEN json_valid(events.data)
        THEN json_extract(events.data, ${EVENT_DATA_PATHS})
      END AS data_fields
    FROM events
    WHERE events.id > ?
    ORDER BY events.id
    LIMIT ?`,
    since,
    limit,
  )
  return rows.map((row) => eventRowToJson(row))
}

/** Current maximum event id, used to start a fresh subscriber at the tail. */
export function maxEventId(): number {
  const row = dbGet<{ id: number | null }>('SELECT MAX(id) AS id FROM events')
  return Number(row?.id ?? 0)
}

function eventRowToJson(row: DbEventRow): JsonRecord {
  return compactRecord({
    id: row.id,
    execution_id: row.execution_id,
    task_id: row.task_id,
    seq: row.seq,
    type: row.type,
    timestamp: row.timestamp,
    data: projectEventData(row.data_fields),
    status: row.status,
    exit_code: row.exit_code,
    is_error: row.is_error === null ? null : row.is_error === 1,
    created_at: row.created_at,
  })
}

function projectEventData(fields: string | null): JsonRecord | undefined {
  if (fields === null) return undefined
  let values: unknown
  try {
    values = JSON.parse(fields)
  } catch {
    return undefined
  }
  if (!Array.isArray(values)) return undefined

  const data: JsonRecord = {}
  for (let index = 0; index < EVENT_DATA_FIELDS.length; index += 1) {
    const value = values[index]
    if (value !== undefined && value !== null) data[EVENT_DATA_FIELDS[index]] = value
  }
  const refs: JsonRecord = {}
  for (let index = 0; index < EVENT_REF_FIELDS.length; index += 1) {
    const value = values[EVENT_DATA_FIELDS.length + index]
    if (value !== undefined && value !== null) refs[EVENT_REF_FIELDS[index]] = value
  }
  if (Object.keys(refs).length > 0) data.refs = refs

  return Object.keys(data).length > 0 ? data : undefined
}

function compactRecord(value: JsonRecord): JsonRecord {
  const next: JsonRecord = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && field !== null) next[key] = field
  }
  return next
}
