import { query as dbQuery } from '../db/connection.mts'

export type JsonRecord = Record<string, unknown>

interface DbEventRow {
  id: number
  execution_id: string | null
  task_id: string | null
  seq: number
  type: string
  timestamp: string
  data: string | null
  status: string | null
  exit_code: number | null
  is_error: number | null
  created_at: string
  profile: string | null
  cwd: string | null
  client_family: string | null
}

export function listDbEvents(since = 0, limit = 100): JsonRecord[] {
  const rows = dbQuery<DbEventRow>(
    `SELECT events.id AS id, events.execution_id AS execution_id,
      events.task_id AS task_id,
      events.seq AS seq, events.type AS type, events.timestamp AS timestamp,
      events.data AS data, events.status AS status,
      events.exit_code AS exit_code, events.is_error AS is_error,
      events.created_at AS created_at,
      e.profile AS profile, e.cwd AS cwd, e.client_family AS client_family
    FROM events
    LEFT JOIN executions e ON e.id = events.execution_id
    WHERE events.id > ?
    ORDER BY events.id
    LIMIT ?`,
    since,
    limit,
  )
  return rows.map(eventRowToJson)
}

function eventRowToJson(row: DbEventRow): JsonRecord {
  return compactRecord({
    id: row.id,
    execution_id: row.execution_id,
    task_id: row.task_id,
    seq: row.seq,
    type: row.type,
    timestamp: row.timestamp,
    data: parseJsonValue(row.data) ?? {},
    status: row.status,
    exit_code: row.exit_code,
    is_error: row.is_error === null ? null : row.is_error === 1,
    profile: row.profile,
    cwd: row.cwd,
    client_family: row.client_family,
    created_at: row.created_at,
  })
}

function parseJsonValue(value: string | null): unknown | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function compactRecord(value: JsonRecord): JsonRecord {
  const next: JsonRecord = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && field !== null) next[key] = field
  }
  return next
}
