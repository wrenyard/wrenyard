import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { FwaSessionStore } from '../../lib/core/fwa/session-store.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'

let db: ForemanDatabase

void describe('session-routing', () => {
  // Session routing tests verify session CRUD, status transitions, ownership, and
  // legacy migration. Transcript-related assertions (appendTranscript / listTranscript)
  // have been removed — transcript storage moved to agent_event table. Session
  // management behavior is unaffected.
  before(() => {
    db = initDb(':memory:')
    bootstrapSchema(db)
  })

  after(() => {
    closeDb()
  })

  void it('creates and finds a session by ticket', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-1',
      ticket_id: 'ticket-1',
      project_id: 'proj-a',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })

    const found = store.findSessionByTicket('ticket-1', 'proj-a')
    assert.ok(found)
    assert.equal(found.id, 'session-1')
    assert.equal(found.status, 'idle')
  })

  void it('returns undefined for unknown ticket', () => {
    const store = new FwaSessionStore(db)
    const found = store.findSessionByTicket('unknown', 'proj')
    assert.equal(found, undefined)
  })

  void it('rejects ticket+project mismatch', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-3',
      ticket_id: 'ticket-3',
      project_id: 'proj-c',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    const found = store.findSessionByTicket('ticket-3', 'wrong-proj')
    assert.equal(found, undefined)
  })

  void it('no broadcast - single session per ticket', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-4',
      ticket_id: 'ticket-4',
      project_id: 'proj-d',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    store.createSession({
      id: 'session-5',
      ticket_id: 'ticket-4',
      project_id: 'proj-d',
      status: 'closed',
      graph_refs: [],
      task_refs: [],
    })
    const found = store.findSessionByTicket('ticket-4', 'proj-d')
    assert.ok(found)
    // Should return the non-closed session, not the newer closed one
    assert.equal(found.id, 'session-4')
  })

  void it('persists status/error/refs and survives service restart', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-restart-test',
      ticket_id: 'ticket-restart',
      project_id: 'proj-restart',
      status: 'running_turn',
      graph_refs: ['tg-1'],
      task_refs: ['tr-1'],
    })
    store.updateSessionStatus('session-restart-test', 'failed', 'test error')

    // Simulate "service restart" by creating a new store instance on the same DB
    const store2 = new FwaSessionStore(db)
    const recovered = store2.getSession('session-restart-test')
    assert.ok(recovered)
    assert.equal(recovered.status, 'failed')
    assert.equal(recovered.last_error, 'test error')
    assert.deepEqual(JSON.parse(recovered.graph_refs), ['tg-1'])
    assert.deepEqual(JSON.parse(recovered.task_refs), ['tr-1'])
  })

  void it('makes inactive sessions queryable', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-inactive-1',
      ticket_id: 'ticket-inactive',
      project_id: 'proj-inactive',
      status: 'failed',
      graph_refs: [],
      task_refs: [],
    })
    store.createSession({
      id: 'session-inactive-2',
      ticket_id: 'ticket-inactive-2',
      project_id: 'proj-inactive-2',
      status: 'closed',
      graph_refs: [],
      task_refs: [],
    })

    const inactive = store.listInactiveSessions()
    assert.ok(inactive.length >= 2)
    const ids = inactive.map((s) => s.id)
    assert.ok(ids.includes('session-inactive-1'))
    assert.ok(ids.includes('session-inactive-2'))
  })

  void it('resolves exactly one active ticket session', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-unique-active',
      ticket_id: 'ticket-unique',
      project_id: 'proj-unique',
      status: 'running_turn',
      graph_refs: [],
      task_refs: [],
    })

    const sessionId = store.resolveActiveTicket('ticket-unique', 'proj-unique')
    assert.equal(sessionId, 'session-unique-active')
  })

  void it('throws on missing ticket for resolveActiveTicket', () => {
    const store = new FwaSessionStore(db)
    assert.throws(
      () => store.resolveActiveTicket('nonexistent', 'proj'),
      /No active session found/,
    )
  })

  void it('rejects duplicate non-closed session for same ticket+project', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-unique-1',
      ticket_id: 'ticket-unique-dup',
      project_id: 'proj-unique-dup',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    // A second non-closed session for the same ticket+project must be rejected
    assert.throws(
      () => store.createSession({
        id: 'session-unique-2',
        ticket_id: 'ticket-unique-dup',
        project_id: 'proj-unique-dup',
        status: 'idle',
        graph_refs: [],
        task_refs: [],
      }),
      /UNIQUE constraint failed|duplicate/u,
    )
    // Closed history for the same ticket+project remains allowed
    store.createSession({
      id: 'session-unique-closed',
      ticket_id: 'ticket-unique-dup',
      project_id: 'proj-unique-dup',
      status: 'closed',
      graph_refs: [],
      task_refs: [],
    })
    const found = store.findSessionByTicket('ticket-unique-dup', 'proj-unique-dup')
    assert.ok(found)
    assert.equal(found.id, 'session-unique-1')
  })

  void it('documents session ownership of created files', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-owner-1',
      ticket_id: 'ticket-owner',
      project_id: 'proj-owner',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    store.recordDocOwnership('session-owner-1', 'src/test.txt')
    assert.ok(store.isDocOwnedBySession('session-owner-1', 'src/test.txt'))
    assert.equal(store.isDocOwnedBySession('session-owner-1', 'other.txt'), false)

    const paths = store.listSessionDocPaths('session-owner-1')
    assert.ok(paths.includes('src/test.txt'))
  })

  void it('resolves same ticket in different projects without ambiguity when project is given', () => {
    const store = new FwaSessionStore(db)
    store.createSession({
      id: 'session-cross-1',
      ticket_id: 'ticket-cross',
      project_id: 'proj-x',
      status: 'running_turn',
      graph_refs: [],
      task_refs: [],
    })
    store.createSession({
      id: 'session-cross-2',
      ticket_id: 'ticket-cross',
      project_id: 'proj-y',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    // Without project, resolveActiveTicket cannot disambiguate
    assert.throws(
      () => store.resolveActiveTicket('ticket-cross'),
      /Ambiguous/u,
    )
    // With project, each resolves to its own session
    const sid1 = store.resolveActiveTicket('ticket-cross', 'proj-x')
    assert.equal(sid1, 'session-cross-1')
    const sid2 = store.resolveActiveTicket('ticket-cross', 'proj-y')
    assert.equal(sid2, 'session-cross-2')
  })

  void it('migrates legacy duplicates on bootstrapSchema', () => {
    const store = new FwaSessionStore(db)

    // Drop the unique index used for active session enforcement
    db.prepare('DROP INDEX IF EXISTS idx_fwa_session_active_unique').run()

    // Insert two active legacy duplicates with ordered timestamps
    store.createSession({
      id: 'session-legacy-old',
      ticket_id: 'ticket-legacy',
      project_id: 'proj-legacy',
      status: 'running_turn',
      graph_refs: [],
      task_refs: [],
    })
    store.createSession({
      id: 'session-legacy-new',
      ticket_id: 'ticket-legacy',
      project_id: 'proj-legacy',
      status: 'idle',
      graph_refs: [],
      task_refs: [],
    })
    // Manually set created_at and updated_at to ensure ordering (old earlier, new later)
    db.prepare("UPDATE fwa_session SET created_at = '2024-01-01T00:00:00.000Z', updated_at = '2024-01-01T00:00:00.000Z' WHERE id = 'session-legacy-old'").run()
    db.prepare("UPDATE fwa_session SET created_at = '2024-06-01T00:00:00.000Z', updated_at = '2024-06-01T00:00:00.000Z' WHERE id = 'session-legacy-new'").run()

    // Re-run bootstrap to reconcile duplicates
    bootstrapSchema(db)

    // The newest (new) should stay active, the older (old) should be closed with reconciliation error
    const oldSession = store.getSession('session-legacy-old')
    assert.ok(oldSession)
    assert.equal(oldSession.status, 'closed')
    assert.ok(oldSession.last_error?.includes('reconciled'), `expected reconciliation error, got: ${oldSession.last_error}`)

    const newSession = store.getSession('session-legacy-new')
    assert.ok(newSession)
    assert.equal(newSession.status, 'idle')

    // The unique index should prevent another active insert
    assert.throws(
      () => store.createSession({
        id: 'session-legacy-third',
        ticket_id: 'ticket-legacy',
        project_id: 'proj-legacy',
        status: 'idle',
        graph_refs: [],
        task_refs: [],
      }),
      /UNIQUE constraint failed|duplicate/u,
    )
  })
})
