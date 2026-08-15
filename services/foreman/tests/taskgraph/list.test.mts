import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  TaskGraphStore,
  type TaskGraph,
  type TaskGraphNode,
} from '../../lib/core/taskgraph/index.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'

let db: ForemanDatabase
let store: TaskGraphStore

beforeEach(() => {
  db = initTestDb()
  store = new TaskGraphStore(db)
})

afterEach(() => {
  closeTestDb()
})

function createGraph(graphId: string, revision = 1): TaskGraph {
  const start: TaskGraphNode = {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  return { id: graphId, revision, nodes: { start } }
}

describe('TaskGraphStore.list', () => {
  it('returns an empty list when no runs exist', () => {
    const result = store.list({ limit: 10 })
    assert.deepEqual(result, [])
  })

  it('returns all runs ordered by updated_at DESC, id DESC', () => {
    const g1 = createGraph('tg_a')
    const g2 = createGraph('tg_b')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z')

    const result = store.list({ limit: 10 })
    assert.equal(result.length, 2)
    assert.equal(result[0].taskgraph_id, 'tg_b')
    assert.equal(result[1].taskgraph_id, 'tg_a')
  })

  it('includes both active and terminal state runs', () => {
    const g1 = createGraph('tg_active')
    const g2 = createGraph('tg_terminal')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z')
    store.updateRun('tg_terminal', { state: 'done', endedAt: '2026-07-03T00:00:00.000Z' }, '2026-07-03T00:00:00.000Z')

    const result = store.list({ limit: 10 })
    assert.equal(result.length, 2)
    const terminal = result.find((r) => r.taskgraph_id === 'tg_terminal')
    assert.ok(terminal)
    assert.equal(terminal.state, 'done')
    assert.equal(terminal.ended_at, '2026-07-03T00:00:00.000Z')
  })

  it('filters by single state', () => {
    const g1 = createGraph('tg_a')
    const g2 = createGraph('tg_b')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z')
    store.updateRun('tg_b', { state: 'running' }, '2026-07-03T00:00:00.000Z')

    const result = store.list({ states: ['running'], limit: 10 })
    assert.equal(result.length, 1)
    assert.equal(result[0].taskgraph_id, 'tg_b')
  })

  it('filters by multiple states', () => {
    const g1 = createGraph('tg_a')
    const g2 = createGraph('tg_b')
    const g3 = createGraph('tg_c')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z')
    store.createProjection(g3, '2026-07-03T00:00:00.000Z')
    store.updateRun('tg_b', { state: 'running' }, '2026-07-04T00:00:00.000Z')
    store.updateRun('tg_c', { state: 'done', endedAt: '2026-07-05T00:00:00.000Z' }, '2026-07-05T00:00:00.000Z')

    const result = store.list({ states: ['running', 'done'], limit: 10 })
    assert.equal(result.length, 2)
    assert.ok(result.some((r) => r.taskgraph_id === 'tg_b'))
    assert.ok(result.some((r) => r.taskgraph_id === 'tg_c'))
  })

  it('filters by project', () => {
    const g1 = createGraph('tg_proj')
    const g2 = createGraph('tg_no_proj')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z', 'my-project')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z')

    const result = store.list({ project: 'my-project', limit: 10 })
    assert.equal(result.length, 1)
    assert.equal(result[0].taskgraph_id, 'tg_proj')
    assert.equal(result[0].project, 'my-project')
  })

  it('combines state and project filters', () => {
    const g1 = createGraph('tg_a')
    const g2 = createGraph('tg_b')
    const g3 = createGraph('tg_c')
    store.createProjection(g1, '2026-07-01T00:00:00.000Z', 'p1')
    store.createProjection(g2, '2026-07-02T00:00:00.000Z', 'p1')
    store.createProjection(g3, '2026-07-03T00:00:00.000Z', 'p2')
    store.updateRun('tg_b', { state: 'running' }, '2026-07-04T00:00:00.000Z')

    const result = store.list({ project: 'p1', states: ['created', 'running'], limit: 10 })
    assert.equal(result.length, 2)
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.createProjection(createGraph(`tg_${i}`), `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
    }

    assert.equal(store.list({ limit: 2 }).length, 2)
    assert.equal(store.list({ limit: 10 }).length, 5)
  })

  it('omits nullable fields when not present', () => {
    const g = createGraph('tg_no_extra')
    store.createProjection(g, '2026-07-01T00:00:00.000Z')

    const result = store.list({ limit: 10 })
    assert.equal(result.length, 1)
    const r = result[0]
    assert.equal(r.taskgraph_id, 'tg_no_extra')
    assert.equal(r.state, 'created')
    assert.equal(r.cancel_requested, undefined)
    assert.equal(r.project, undefined)
    assert.equal(r.title, undefined)
    assert.equal(r.ended_at, undefined)
    assert.ok(r.created_at)
    assert.ok(r.updated_at)
  })

  it('includes the create-time title in summaries when present', () => {
    const g = createGraph('tg_titled')
    store.createProjection(g, '2026-07-01T00:00:00.000Z', undefined, 'pause', 'deploy release v1.2.3')

    const result = store.list({ limit: 10 })
    assert.equal(result.length, 1)
    const r = result[0]
    assert.equal(r.taskgraph_id, 'tg_titled')
    assert.equal(r.title, 'deploy release v1.2.3')
  })

  it('omits title from summaries for legacy runs', () => {
    const g = createGraph('tg_untitled')
    store.createProjection(g, '2026-07-01T00:00:00.000Z')

    const result = store.list({ limit: 10 })
    assert.equal(result.length, 1)
    const r = result[0]
    assert.equal(r.taskgraph_id, 'tg_untitled')
    assert.equal(r.title, undefined)
  })
})
