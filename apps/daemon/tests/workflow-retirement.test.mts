import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { WorkflowRunStore } from '../lib/db/stores/workflow-run-store.mts'
import type { ForemanDatabase } from '../lib/db/types.mts'

interface WorkflowRow {
  status: string | null
  error: string | null
  current_phase: string | null
  ended_at: string | null
  updated_at: string | null
}

function createInitializedDb(): ForemanDatabase {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      flow_name TEXT,
      status TEXT NOT NULL,
      error TEXT,
      current_phase TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    )
  `)
  return db as unknown as ForemanDatabase
}

describe('WorkflowRunStore.markAllNonTerminalCancelled', () => {
  it('cancels non-terminal rows with stable metadata', () => {
    const db = createInitializedDb()
    const store = new WorkflowRunStore(db)
    const endedAt = '2026-08-14T00:00:00.000Z'

    const insert = db.prepare(
      `INSERT INTO workflows (id, flow_name, status, error, current_phase, ended_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('wf-running', 'flow-a', 'running', null, 'Phase 1', null, '2026-08-14T00:00:00.000Z')
    insert.run('wf-paused', 'flow-a', 'paused', null, 'Phase 2', null, '2026-08-14T00:00:00.000Z')
    insert.run('wf-interrupted', 'flow-a', 'interrupted', null, 'Phase 3', null, '2026-08-14T00:00:00.000Z')

    const changed = store.markAllNonTerminalCancelled(endedAt)

    assert.equal(changed, 3)
    for (const id of ['wf-running', 'wf-paused', 'wf-interrupted']) {
      const row = db.prepare<unknown[], WorkflowRow>('SELECT * FROM workflows WHERE id = ?').get(id)
      assert.ok(row)
      assert.equal(row.status, 'cancelled')
      assert.equal(row.error, 'Workflow run cancelled')
      assert.equal(row.current_phase, 'Cancelled')
      assert.equal(row.ended_at, endedAt)
      assert.equal(row.updated_at, endedAt)
    }
  })

  it('leaves terminal rows unchanged', () => {
    const db = createInitializedDb()
    const store = new WorkflowRunStore(db)
    const endedAt = '2026-08-14T00:00:00.000Z'

    const insert = db.prepare(
      `INSERT INTO workflows (id, flow_name, status, error, current_phase, ended_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('wf-done', 'flow-b', 'done', null, 'Done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    insert.run('wf-failed', 'flow-b', 'failed', 'boom', 'Failed', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    insert.run('wf-cancelled', 'flow-b', 'cancelled', 'cancelled', 'Cancelled', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')

    const changed = store.markAllNonTerminalCancelled(endedAt)

    assert.equal(changed, 0)
    const expected = [
      ['wf-done', 'done', null, 'Done', '2026-01-01T00:00:00.000Z'],
      ['wf-failed', 'failed', 'boom', 'Failed', '2026-01-02T00:00:00.000Z'],
      ['wf-cancelled', 'cancelled', 'cancelled', 'Cancelled', '2026-01-03T00:00:00.000Z'],
    ]
    for (const [id, status, error, phase, end] of expected) {
      const row = db.prepare<unknown[], WorkflowRow>('SELECT * FROM workflows WHERE id = ?').get(id)
      assert.ok(row)
      assert.equal(row.status, status)
      assert.equal(row.error, error)
      assert.equal(row.current_phase, phase)
      assert.equal(row.ended_at, end)
    }
  })

  it('is idempotent on repetition', () => {
    const db = createInitializedDb()
    const store = new WorkflowRunStore(db)
    const endedAt = '2026-08-14T00:00:00.000Z'

    db.prepare(
      `INSERT INTO workflows (id, flow_name, status, error, current_phase, ended_at, updated_at)
       VALUES ('wf-running', 'flow-c', 'running', NULL, 'Phase 1', NULL, '2026-08-14T00:00:00.000Z')`,
    ).run()

    const first = store.markAllNonTerminalCancelled(endedAt)
    const second = store.markAllNonTerminalCancelled(endedAt)

    assert.equal(first, 1)
    assert.equal(second, 0)
    const row = db.prepare<unknown[], WorkflowRow>('SELECT * FROM workflows WHERE id = ?').get('wf-running')
    assert.ok(row)
    assert.equal(row.status, 'cancelled')
    assert.equal(row.error, 'Workflow run cancelled')
    assert.equal(row.current_phase, 'Cancelled')
    assert.equal(row.ended_at, endedAt)
  })
})
