import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { closeDb, initDb } from '../../lib/db/connection.mts'
import { ForemanEventStore } from '../../lib/events/event-store.mts'
import type { ForemanEvent } from '../../lib/events/event-types.mts'

describe('ForemanEventStore', () => {
  afterEach(() => {
    closeDb()
  })

  it('appends and lists daemon fact events by cursor', () => {
    const db = initDb(':memory:')
    const store = new ForemanEventStore(db)

    const stored = store.append(event('evt_1', 'task.run.started'))
    store.append(event('evt_2', 'task.run.completed'))

    assert.equal(stored.cursor, 1)
    assert.deepEqual(store.listSince(0).map((row) => row.event.id), ['evt_1', 'evt_2'])
    assert.deepEqual(store.listSince(stored.cursor).map((row) => row.event.id), ['evt_2'])
  })

  it('streams available daemon fact events', async () => {
    const db = initDb(':memory:')
    const store = new ForemanEventStore(db)
    store.append(event('evt_stream', 'task.run.started'))

    const stream = store.listStream(0, { pollIntervalMs: 1 })
    const first = await stream.next()
    await stream.return(undefined)

    assert.equal(first.done, false)
    assert.equal(first.value.event.id, 'evt_stream')
    assert.equal(first.value.event.kind, 'task.run.started')
  })
})

function event(id: string, kind: ForemanEvent['kind']): ForemanEvent {
  return {
    id,
    kind,
    source: 'test',
    severity: 'info',
    refs: { project: 'workspace' },
    data: { ok: true },
    occurredAt: '2026-07-01T00:00:00.000Z',
  }
}
