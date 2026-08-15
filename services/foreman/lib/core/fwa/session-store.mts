/**
 * SQLite persistence for fwa_session metadata, transcript, and
 * session-created workspace document ownership.
 *
 * Uses transactions where state+transcript must stay coherent.
 */

import type { ForemanDatabase } from '../../db/types.mts'
import type { FwaSession, FwaSessionStatus, FwaTranscriptEntry } from './types.mts'

export interface FwaSessionRecord {
  id: string
  ticket_id: string
  project_id: string
  status: FwaSessionStatus
  graph_refs: string
  task_refs: string
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface FwaTranscriptRecord {
  session_id: string
  seq: number
  role: string
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  created_at: string
}

export interface FwaDocRecord {
  session_id: string
  path: string
  created_at: string
}

export class FwaSessionStore {
  private readonly db: ForemanDatabase

  constructor(db: ForemanDatabase) {
    this.db = db
  }

  // -- Session CRUD --

  /**
   * Find a session by ticket+project. Returns only the one active non-closed row.
   * Returns undefined when no match exists.
   */
  findSessionByTicket(ticket_id: string, project_id: string): FwaSessionRecord | undefined {
    return this.db.prepare<[string, string], FwaSessionRecord>(
      `SELECT * FROM fwa_session WHERE ticket_id = ? AND project_id = ? AND status != 'closed' ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(ticket_id, project_id) ?? undefined
  }

  /**
   * Transactionally create a new session or return the existing active one
   * for the given ticket+project. Uses the partial unique invariant: there
   * should be at most one non-closed row per (ticket_id, project_id).
   * Handles an insert uniqueness race by selecting the winning active row.
   * Returns { session, created: true } on insert, { session, created: false } on existing.
   * Throws clear errors if the invariant is violated (multiple active rows).
   */
  createOrGetActive(params: {
    id: string
    ticket_id: string
    project_id: string
    status?: FwaSessionStatus
    graph_refs?: string[]
    task_refs?: string[]
    last_error?: string
    created_at?: string
  }): { session: FwaSessionRecord; created: boolean } {
    // Check for existing active row first
    const existing = this.findSessionByTicket(params.ticket_id, params.project_id)
    if (existing) {
      // Verify no duplicate active rows
      const allActive = this.db.prepare<[string, string], FwaSessionRecord>(
        `SELECT * FROM fwa_session WHERE ticket_id = ? AND project_id = ? AND status != 'closed' ORDER BY created_at DESC`,
      ).all(params.ticket_id, params.project_id)
      if (allActive.length > 1) {
        throw new Error(
          `Invariant violated: ${allActive.length} active sessions for ticket '${params.ticket_id}' project '${params.project_id}'. ` +
          `Sessions: ${allActive.map((s) => `(${s.id}, ${s.status})`).join(', ')}`,
        )
      }
      return { session: existing, created: false }
    }

    // Try insert; handle race by selecting the winning row
    const now = params.created_at ?? new Date().toISOString()
    const graphRefs = params.graph_refs ?? []
    const taskRefs = params.task_refs ?? []
    try {
      this.db.prepare(`
        INSERT INTO fwa_session (id, ticket_id, project_id, status, graph_refs, task_refs, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.id,
        params.ticket_id,
        params.project_id,
        params.status ?? 'idle',
        JSON.stringify(graphRefs),
        JSON.stringify(taskRefs),
        params.last_error ?? null,
        now,
        now,
      )
      return {
        session: {
          id: params.id,
          ticket_id: params.ticket_id,
          project_id: params.project_id,
          status: params.status ?? 'idle',
          graph_refs: JSON.stringify(graphRefs),
          task_refs: JSON.stringify(taskRefs),
          last_error: params.last_error ?? null,
          created_at: now,
          updated_at: now,
        },
        created: true,
      }
    } catch {
      // Insert failed (likely UNIQUE constraint from concurrent insert);
      // the partial unique index prevents a second active row.
      const winner = this.findSessionByTicket(params.ticket_id, params.project_id)
      if (winner) {
        return { session: winner, created: false }
      }
      throw new Error(`Failed to create or get active session for ticket '${params.ticket_id}' project '${params.project_id}'`)
    }
  }

  /**
   * Transactional create-or-get-active with an admission callback.
   * Invokes the supplied admission callback with the selected resource id before commit;
   * rolls back a newly created session when admission throws.
   */
  createOrGetActiveWithAdmission(
    params: {
      id: string
      ticket_id: string
      project_id: string
      status?: FwaSessionStatus
      graph_refs?: string[]
      task_refs?: string[]
      last_error?: string
      created_at?: string
    },
    onAdmit: (resourceId: string) => void,
  ): { session: FwaSessionRecord; created: boolean } {
    const now = params.created_at ?? new Date().toISOString()
    const graphRefs = params.graph_refs ?? []
    const taskRefs = params.task_refs ?? []

    // Use the session id as the resource id for delegation admission
    const resourceId = params.id

    return this.db.transaction(() => {
      // Check for existing active row
      const existing = this.findSessionByTicket(params.ticket_id, params.project_id)
      if (existing) {
        // Verify no duplicate active rows
        const allActive = this.db.prepare<[string, string], FwaSessionRecord>(
          `SELECT * FROM fwa_session WHERE ticket_id = ? AND project_id = ? AND status != 'closed' ORDER BY created_at DESC`,
        ).all(params.ticket_id, params.project_id)
        if (allActive.length > 1) {
          throw new Error(
            `Invariant violated: ${allActive.length} active sessions for ticket '${params.ticket_id}' project '${params.project_id}'. ` +
            `Sessions: ${allActive.map((s) => `(${s.id}, ${s.status})`).join(', ')}`,
          )
        }
        return { session: existing, created: false }
      }

      // Try insert
      try {
        this.db.prepare(`
          INSERT INTO fwa_session (id, ticket_id, project_id, status, graph_refs, task_refs, last_error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          params.id,
          params.ticket_id,
          params.project_id,
          params.status ?? 'idle',
          JSON.stringify(graphRefs),
          JSON.stringify(taskRefs),
          params.last_error ?? null,
          now,
          now,
        )

        // Invoke admission callback before commit
        onAdmit(resourceId)

        return {
          session: {
            id: params.id,
            ticket_id: params.ticket_id,
            project_id: params.project_id,
            status: params.status ?? 'idle',
            graph_refs: JSON.stringify(graphRefs),
            task_refs: JSON.stringify(taskRefs),
            last_error: params.last_error ?? null,
            created_at: now,
            updated_at: now,
          },
          created: true,
        }
      } catch (error) {
        // Insert failed — check if it was a UNIQUE constraint race
        const winner = this.findSessionByTicket(params.ticket_id, params.project_id)
        if (winner) {
          return { session: winner, created: false }
        }
        throw error
      }
    })()
  }
  findSessionsByTicket(ticket_id: string, project_id: string): FwaSessionRecord[] {
    return this.db.prepare<[string, string], FwaSessionRecord>(
      `SELECT * FROM fwa_session WHERE ticket_id = ? AND project_id = ? ORDER BY created_at DESC`,
    ).all(ticket_id, project_id)
  }

  /**
   * Resolve exactly one active (non-closed) session for a ticket, optionally scoped
   * to a project. With project_id, resolves one active matching session; without it,
   * searches all active sessions for the ticket across projects. Zero or multiple
   * matches throw clear missing/ambiguous errors.
   */
  resolveActiveTicket(ticket_id: string, project_id?: string): string {
    let sessions: FwaSessionRecord[]
    if (project_id) {
      sessions = this.db.prepare<[string, string], FwaSessionRecord>(
        `SELECT * FROM fwa_session WHERE ticket_id = ? AND project_id = ? AND status != 'closed' ORDER BY created_at DESC`,
      ).all(ticket_id, project_id)
    } else {
      sessions = this.db.prepare<[string], FwaSessionRecord>(
        `SELECT * FROM fwa_session WHERE ticket_id = ? AND status != 'closed' ORDER BY created_at DESC`,
      ).all(ticket_id)
    }
    if (sessions.length === 0) {
      const scope = project_id ? ` in project '${project_id}'` : ''
      throw new Error(`No active session found for ticket '${ticket_id}'${scope}`)
    }
    if (sessions.length > 1) {
      const scope = project_id ? ` in project '${project_id}'` : ''
      throw new Error(
        `Ambiguous ticket '${ticket_id}'${scope}: ${sessions.length} active sessions found. ` +
        `Use --project to disambiguate. Sessions: ${sessions.map((s) => `(${s.id}, ${s.project_id})`).join(', ')}`,
      )
    }
    return sessions[0].id
  }

  getSession(id: string): FwaSessionRecord | undefined {
    return this.db.prepare<[string], FwaSessionRecord>(
      `SELECT * FROM fwa_session WHERE id = ?`,
    ).get(id) ?? undefined
  }

  listSessions(): FwaSessionRecord[] {
    return this.db.prepare<[], FwaSessionRecord>(
      `SELECT * FROM fwa_session ORDER BY created_at DESC`,
    ).all()
  }

  listInactiveSessions(): FwaSessionRecord[] {
    return this.db.prepare<[], FwaSessionRecord>(
      `SELECT * FROM fwa_session WHERE status IN ('idle', 'failed', 'closed') ORDER BY created_at DESC`,
    ).all()
  }

  listNonClosedSessions(): FwaSessionRecord[] {
    return this.db.prepare<[], FwaSessionRecord>(
      `SELECT * FROM fwa_session WHERE status != 'closed' ORDER BY created_at DESC`,
    ).all()
  }

  createSession(params: {
    id: string
    ticket_id: string
    project_id: string
    status: FwaSessionStatus
    graph_refs: string[]
    task_refs: string[]
    last_error?: string
    created_at?: string
  }): void {
    const now = params.created_at ?? new Date().toISOString()
    this.db.prepare(`
      INSERT INTO fwa_session (id, ticket_id, project_id, status, graph_refs, task_refs, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.ticket_id,
      params.project_id,
      params.status,
      JSON.stringify(params.graph_refs),
      JSON.stringify(params.task_refs),
      params.last_error ?? null,
      now,
      now,
    )
  }

  updateSessionStatus(id: string, status: FwaSessionStatus, last_error?: string): void {
    this.db.prepare(`
      UPDATE fwa_session SET status = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(status, last_error ?? null, new Date().toISOString(), id)
  }

  updateSessionRefs(id: string, graph_refs: string[], task_refs: string[]): void {
    this.db.prepare(`
      UPDATE fwa_session SET graph_refs = ?, task_refs = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(graph_refs), JSON.stringify(task_refs), new Date().toISOString(), id)
  }

  // -- Document ownership --

  recordDocOwnership(session_id: string, path: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO fwa_document (session_id, path, created_at)
      VALUES (?, ?, ?)
    `).run(session_id, path, new Date().toISOString())
  }

  isDocOwnedBySession(session_id: string, path: string): boolean {
    const row = this.db.prepare<[string, string], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM fwa_document WHERE session_id = ? AND path = ?`,
    ).get(session_id, path)
    return (row?.cnt ?? 0) > 0
  }

  removeDocOwnership(session_id: string, path: string): void {
    this.db.prepare(`DELETE FROM fwa_document WHERE session_id = ? AND path = ?`).run(session_id, path)
  }

  listSessionDocPaths(session_id: string): string[] {
    return this.db.prepare<[string], { path: string }>(
      `SELECT path FROM fwa_document WHERE session_id = ?`,
    ).all(session_id).map((r) => r.path)
  }
}
