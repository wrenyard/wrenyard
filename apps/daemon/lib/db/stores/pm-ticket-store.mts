import type { ForemanDatabase } from '../types.mts'
import type {
  PmTicket,
  PmTicketStatus,
  PmTicketKind,
  PmTicketRepository,
  PmTicketFilter,
} from '../../core/pm/index.mts'

export class PmTicketStore implements PmTicketRepository {
  constructor(private readonly db: ForemanDatabase) {}

  get(id: string): PmTicket | undefined {
    const row = this.db.prepare<[string], PmTicketRow>(
      `SELECT id, kind, project_id, title, description, status, parent_id, assignee_session_id, created_at, updated_at FROM pm_tickets WHERE id = ?`,
    ).get(id)
    if (!row) return undefined
    return rowToTicket(row)
  }

  insert(ticket: PmTicket): void {
    this.db.prepare<[string, string, string, string, string | null, string, string | null, string | null, string, string]>(
      `INSERT INTO pm_tickets (id, kind, project_id, title, description, status, parent_id, assignee_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ticket.id,
      ticket.kind,
      ticket.project_id,
      ticket.title,
      ticket.description ?? null,
      ticket.status,
      ticket.parent_id ?? null,
      ticket.assignee?.session_id ?? null,
      ticket.created_at,
      ticket.updated_at,
    )
  }

  list(filter: PmTicketFilter): PmTicket[] {
    const conditions: string[] = ['project_id = ?']
    const params: unknown[] = [filter.project_id]

    if (filter.kind !== undefined) {
      conditions.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.parent_id !== undefined) {
      conditions.push('parent_id = ?')
      params.push(filter.parent_id)
    }
    if (filter.assignee_session_id !== undefined) {
      conditions.push('assignee_session_id = ?')
      params.push(filter.assignee_session_id)
    }

    const rows = this.db.prepare<unknown[], PmTicketRow>(
      `SELECT id, kind, project_id, title, description, status, parent_id, assignee_session_id, created_at, updated_at
       FROM pm_tickets WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC, id DESC`,
    ).all(...params)

    return rows.map(rowToTicket)
  }

  update(ticket: PmTicket): void {
    this.db.prepare<[string, string, string, string | null, string, string | null, string | null, string, string]>(
      `UPDATE pm_tickets SET kind = ?, project_id = ?, title = ?, description = ?, status = ?, parent_id = ?, assignee_session_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      ticket.kind,
      ticket.project_id,
      ticket.title,
      ticket.description ?? null,
      ticket.status,
      ticket.parent_id ?? null,
      ticket.assignee?.session_id ?? null,
      ticket.updated_at,
      ticket.id,
    )
  }

  delete(id: string): void {
    this.db.prepare<[string]>('DELETE FROM pm_tickets WHERE id = ?').run(id)
  }

  countChildren(parentId: string): number {
    const row = this.db.prepare<[string], { count: number }>(
      'SELECT COUNT(*) as count FROM pm_tickets WHERE parent_id = ?',
    ).get(parentId)
    return row?.count ?? 0
  }

  listOpenSubticketIds(parentId: string): string[] {
    const rows = this.db.prepare<[string], { id: string }>(
      "SELECT id FROM pm_tickets WHERE parent_id = ? AND status <> 'done'",
    ).all(parentId)
    return rows.map((r) => r.id)
  }
}

interface PmTicketRow {
  id: string
  kind: string
  project_id: string
  title: string
  description: string | null
  status: string
  parent_id: string | null
  assignee_session_id: string | null
  created_at: string
  updated_at: string
}

function rowToTicket(row: PmTicketRow): PmTicket {
  const ticket: PmTicket = {
    id: row.id,
    kind: row.kind as PmTicketKind,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as PmTicketStatus,
    parent_id: row.parent_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (row.assignee_session_id) {
    ticket.assignee = { session_id: row.assignee_session_id }
  }
  return ticket
}
