import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import Database from 'better-sqlite3'

import {
  TaskGraphStore,
  TASKGRAPH_RUNNER_VERSION,
  type TaskGraph,
  type TaskGraphNode,
} from '../../lib/core/taskgraph/index.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import { closeTestDb, initTestDb } from '../helpers/test-db.mts'

afterEach(() => {
  closeTestDb()
})

describe('TaskGraph persistence projections', () => {
  it('bootstraps the five D41 tables', () => {
    const db = initTestDb()
    const rows = db.prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'taskgraph_%'
       ORDER BY name`,
    ).all()
    assert.deepEqual(rows.map((row) => row.name), [
      'taskgraph_graph',
      'taskgraph_journal',
      'taskgraph_node_state',
      'taskgraph_patch',
      'taskgraph_run',
    ])
  })

  it('persists current projections, strict journal sequence, and one-use patch tickets', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const graph = minimalGraph()
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(graph, now)
    store.putNodeState('tg_store', 'start', {
      state: 'done',
      output: {},
      error: null,
      taskRunId: null,
    }, now)
    store.updateRun('tg_store', { state: 'running' }, now)

    const first = store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.created',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'daemon' },
      data: {},
    })
    const second = store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.started',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'runner' },
      data: {},
    })
    assert.deepEqual([first.seq, second.seq], [1, 2])
    assert.equal(store.requireProjection('tg_store').run.state, 'running')
    assert.equal(store.requireProjection('tg_store').nodeStates.start.state, 'done')
    assert.deepEqual(store.listEvents('tg_store', 1, 10).events.map((event) => event.seq), [2])

    const patch = {
      base_revision: 1,
      actor: 'test',
      reason: 'no-op',
      created_at: now,
      ops: [],
    }
    store.storePendingPatch({
      id: 'patch_1',
      taskgraphId: 'tg_store',
      baseRevision: 1,
      status: 'pending',
      patch,
      postGraph: { ...graph, revision: 2 },
      createdAt: now,
    })
    assert.equal(store.readPatch('patch_1')?.status, 'pending')
    assert.equal(store.consumePatch('patch_1', 'applied', now), true)
    assert.equal(store.consumePatch('patch_1', 'applied', now), false)
    assert.equal(store.readPatch('patch_1')?.status, 'applied')
  })

  it('round-trips a create-time title through projections and list summaries', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'pause', 'deploy release v1.2.3')

    const columns = new Set(db
      .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
      .all()
      .map((column) => column.name))
    assert.ok(columns.has('title'))

    const run = store.requireProjection('tg_store').run
    assert.equal(run.title, 'deploy release v1.2.3')
    const summary = store.list({ limit: 10 })[0]
    assert.equal(summary.title, 'deploy release v1.2.3')

    // The actionable-runs SELECT mapping carries the title too.
    store.updateRun('tg_store', { state: 'running' }, now)
    const actionable = store.listActionableRuns()
    assert.equal(actionable.some((entry) => entry.id === 'tg_store' && entry.title === 'deploy release v1.2.3'), true)
  })

  it('omits title from projections and summaries when none was supplied', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    store.createProjection(minimalGraph(), '2026-07-18T00:00:00.000Z')
    const run = store.requireProjection('tg_store').run
    assert.equal(run.title, undefined)
    assert.equal(store.list({ limit: 10 })[0].title, undefined)
  })

  it('additively migrates a legacy taskgraph_run schema to add title, keeping old rows readable', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const now = '2026-07-18T00:00:00.000Z'
    // Legacy taskgraph_run DDL that predates the title column.
    db.exec(`
      CREATE TABLE taskgraph_run (
        id                 TEXT PRIMARY KEY,
        state              TEXT NOT NULL CHECK(state IN ('created','running','paused','done','cancelled')),
        cancel_requested   INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        on_node_failure    TEXT NOT NULL DEFAULT 'pause' CHECK(on_node_failure IN ('pause','cancel')),
        failure_cause      TEXT,
        structure_revision INTEGER NOT NULL,
        runner_version     TEXT NOT NULL,
        project            TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        ended_at           TEXT
      )
    `)
    // Dependent TaskGraph tables in dependency order (matching the schema
    // bootstrap), so legacy graph/node rows can exist in a realistic
    // pre-title database before the migration under test runs.
    db.exec(`
      CREATE TABLE taskgraph_graph (
        taskgraph_id TEXT PRIMARY KEY REFERENCES taskgraph_run(id) ON DELETE CASCADE,
        graph_json   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE taskgraph_node_state (
        taskgraph_id TEXT NOT NULL REFERENCES taskgraph_run(id) ON DELETE CASCADE,
        node_id      TEXT NOT NULL,
        state        TEXT NOT NULL CHECK(state IN
                       ('planned','running','waiting','done','failed','interrupted','cancelled')),
        error_json   TEXT,
        output_json  TEXT,
        task_run_id  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY(taskgraph_id, node_id)
      )
    `)
    db.exec(`
      CREATE TABLE taskgraph_journal (
        taskgraph_id       TEXT NOT NULL REFERENCES taskgraph_run(id) ON DELETE CASCADE,
        seq                INTEGER NOT NULL,
        event_id           TEXT NOT NULL UNIQUE,
        type               TEXT NOT NULL,
        occurred_at        TEXT NOT NULL,
        structure_revision INTEGER NOT NULL,
        source_json        TEXT NOT NULL,
        refs_json          TEXT,
        data_json          TEXT NOT NULL,
        PRIMARY KEY(taskgraph_id, seq)
      )
    `)
    db.exec(`
      CREATE TABLE taskgraph_patch (
        id             TEXT PRIMARY KEY,
        taskgraph_id   TEXT NOT NULL REFERENCES taskgraph_run(id) ON DELETE CASCADE,
        base_revision  INTEGER NOT NULL,
        status         TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')),
        patch_json     TEXT NOT NULL,
        post_graph_json TEXT NOT NULL,
        errors_json    TEXT,
        created_at     TEXT NOT NULL,
        consumed_at    TEXT
      )
    `)
    const legacyGraph: TaskGraph = {
      id: 'tg_legacy',
      revision: 1,
      nodes: {
        start: {
          id: 'start',
          name: 'start',
          action: { type: 'start', params: {} },
          deps: [],
          input: [],
          input_schema: { type: 'object' },
          output_schema: { type: 'object' },
        },
      },
    }
    db.prepare(
      `INSERT INTO taskgraph_run (
        id, state, cancel_requested, on_node_failure, structure_revision,
        runner_version, project, created_at, updated_at
      ) VALUES (?, 'created', 0, 'pause', ?, ?, NULL, ?, ?)`,
    ).run('tg_legacy', 1, TASKGRAPH_RUNNER_VERSION, now, now)
    db.prepare(
      'INSERT INTO taskgraph_graph (taskgraph_id, graph_json, updated_at) VALUES (?, ?, ?)',
    ).run('tg_legacy', JSON.stringify(legacyGraph), now)
    db.prepare(
      `INSERT INTO taskgraph_node_state (
        taskgraph_id, node_id, state, error_json, output_json, task_run_id,
        created_at, updated_at
      ) VALUES (?, ?, 'planned', NULL, NULL, NULL, ?, ?)`,
    ).run('tg_legacy', 'start', now, now)

    bootstrapSchema(db)

    const columns = new Set(db
      .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
      .all()
      .map((column) => column.name))
    assert.ok(columns.has('title'))

    // Idempotent repeated bootstrap: a second startup is a no-op and the
    // migrated legacy row stays readable with a NULL title.
    bootstrapSchema(db)
    const columnsAfterRebootstrap = new Set(db
      .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
      .all()
      .map((column) => column.name))
    assert.ok(columnsAfterRebootstrap.has('title'))

    const store = new TaskGraphStore(db)
    const projection = store.requireProjection('tg_legacy')
    assert.equal(projection.run.state, 'created')
    assert.equal(projection.run.title, undefined)
    assert.equal(projection.graph.nodes.start.name, 'start')
    const summary = store.list({ limit: 10 })[0]
    assert.equal(summary.taskgraph_id, 'tg_legacy')
    assert.equal(summary.title, undefined)
    db.close()
  })
})

describe('TaskGraph run failure policy and termination cause persistence', () => {
  it('defaults runs to the pause policy with a null failure cause', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now)
    const run = store.requireProjection('tg_store').run
    assert.equal(run.onNodeFailure, 'pause')
    assert.equal(run.failureCause, undefined)

    const columns = new Set(db
      .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
      .all()
      .map((column) => column.name))
    assert.ok(columns.has('on_node_failure'))
    assert.ok(columns.has('failure_cause'))
  })

  it('round-trips a persisted cancel policy and structured failure cause', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    assert.equal(store.requireProjection('tg_store').run.onNodeFailure, 'cancel')

    store.updateRun('tg_store', {
      state: 'cancelled',
      cancelRequested: false,
      failureCause: {
        kind: 'node_failed',
        node_id: 'start',
        task_run_id: 'task_1',
        error: { code: 'TASK_RUN_FAILED', message: 'boom' },
        event_id: 'tge_abc',
      },
      endedAt: now,
    }, now)

    const run = store.requireProjection('tg_store').run
    assert.equal(run.state, 'cancelled')
    assert.equal(run.onNodeFailure, 'cancel')
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'start',
      task_run_id: 'task_1',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      event_id: 'tge_abc',
    })
  })

  it('lists the persisted policy and termination evidence in run summaries', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', {
      state: 'cancelled',
      cancelRequested: false,
      failureCause: {
        kind: 'recovery_failed',
        node_id: 'start',
        error: { code: 'TASK_RUN_REATTACH_FAILED', message: 'cannot reattach' },
      },
      endedAt: now,
    }, now)

    const summary = store.list({ limit: 10 })[0]
    assert.equal(summary.state, 'cancelled')
    assert.equal(summary.on_node_failure, 'cancel')
    assert.equal(summary.failure?.kind, 'recovery_failed')
    assert.equal(summary.failure?.node_id, 'start')
    assert.equal(summary.failure?.error.code, 'TASK_RUN_REATTACH_FAILED')
  })

  it('keeps persisted failure evidence immutable after the run is terminal', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    const cause = {
      kind: 'node_failed' as const,
      node_id: 'start',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
    }
    store.updateRun('tg_store', {
      state: 'cancelled',
      cancelRequested: false,
      failureCause: cause,
      endedAt: now,
    }, now)
    // A later unrelated structural update must not erase the terminal cause.
    store.updateRun('tg_store', { structureRevision: 2 }, now)
    const run = store.requireProjection('tg_store').run
    assert.equal(run.state, 'cancelled')
    assert.deepEqual(run.failureCause, cause)
  })

  it('discovers actionable runs for startup reconciliation', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    const graph = minimalGraph()

    store.createProjection({ ...graph, id: 'tg_running' }, now)
    store.updateRun('tg_running', { state: 'running' }, now)

    store.createProjection({ ...graph, id: 'tg_cancel_req' }, now)
    store.updateRun('tg_cancel_req', { state: 'running', cancelRequested: true }, now)

    store.createProjection({ ...graph, id: 'tg_paused_live' }, now)
    store.updateRun('tg_paused_live', { state: 'paused' }, now)
    store.putNodeState('tg_paused_live', 'start', {
      state: 'running', error: null, output: null, taskRunId: 'task_1',
    }, now)

    store.createProjection({ ...graph, id: 'tg_cancel_pending' }, now, undefined, 'cancel')
    store.updateRun('tg_cancel_pending', { state: 'paused', cancelRequested: true }, now)
    store.putNodeState('tg_cancel_pending', 'start', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      output: null,
      taskRunId: null,
    }, now)

    // Idle pause-policy graphs with no live nodes are not actionable.
    store.createProjection({ ...graph, id: 'tg_idle_paused' }, now)
    store.updateRun('tg_idle_paused', { state: 'paused' }, now)
    store.putNodeState('tg_idle_paused', 'start', {
      state: 'failed', error: null, output: null, taskRunId: null,
    }, now)

    const actionable = store.listActionableRuns().map((run) => run.id)
    assert.ok(actionable.includes('tg_running'))
    assert.ok(actionable.includes('tg_cancel_req'))
    assert.ok(actionable.includes('tg_paused_live'))
    assert.ok(actionable.includes('tg_cancel_pending'))
    assert.ok(!actionable.includes('tg_idle_paused'))
  })

  it('is safe under repeated schema initialization (idempotent migration)', () => {
    const db = initTestDb()
    bootstrapSchema(db)
    bootstrapSchema(db)
    const store = new TaskGraphStore(db)
    store.createProjection(minimalGraph(), '2026-07-18T00:00:00.000Z', undefined, 'cancel')
    assert.equal(store.requireProjection('tg_store').run.onNodeFailure, 'cancel')
  })

  it('failNodeForCancellation commits node state, journal, first cause, and cancel intent together', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    const event = store.failNodeForCancellation({
      taskgraphId: 'tg_store',
      nodeId: 'start',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      taskRunId: 'task_1',
      occurredAt: now,
      source: { kind: 'action', id: 'task_1' },
      refs: { node_id: 'start', task_run_id: 'task_1' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom' },
    })

    const projection = store.requireProjection('tg_store')
    assert.equal(projection.run.cancelRequested, true)
    assert.deepEqual(projection.run.failureCause, {
      kind: 'node_failed',
      node_id: 'start',
      task_run_id: 'task_1',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      event_id: event.event_id,
    })
    const node = projection.nodeStates.start
    assert.equal(node.state, 'failed')
    assert.deepEqual(node.error, { code: 'TASK_RUN_FAILED', message: 'boom' })
    const journal = store.listEvents('tg_store', 0, 10).events
    assert.equal(journal.length, 1)
    assert.equal(journal[0].type, 'taskgraph.node.failed')
    assert.equal(journal[0].event_id, event.event_id)
  })

  it('rolls back the cancel-policy failure commit when the enclosing transaction aborts', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    assert.throws(() => {
      store.transaction(() => {
        store.failNodeForCancellation({
          taskgraphId: 'tg_store',
          nodeId: 'start',
          error: { code: 'TASK_RUN_FAILED', message: 'boom' },
          taskRunId: 'task_1',
          occurredAt: now,
          source: { kind: 'action', id: 'task_1' },
          refs: { node_id: 'start', task_run_id: 'task_1' },
          data: { code: 'TASK_RUN_FAILED', message: 'boom' },
        })
        throw new Error('injected rollback')
      })
    }, /injected rollback/u)

    const projection = store.requireProjection('tg_store')
    assert.equal(projection.run.cancelRequested, false)
    assert.equal(projection.run.failureCause, undefined)
    assert.equal(projection.nodeStates.start.state, 'planned')
    assert.equal(store.listEvents('tg_store', 0, 10).events.length, 0)
  })

  it('preserves the first failure cause when a later cancel-policy failure commits', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    const first = store.failNodeForCancellation({
      taskgraphId: 'tg_store',
      nodeId: 'start',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-first' },
      taskRunId: 'task_1',
      occurredAt: now,
      source: { kind: 'action', id: 'task_1' },
      refs: { node_id: 'start', task_run_id: 'task_1' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-first' },
    })
    const second = store.failNodeForCancellation({
      taskgraphId: 'tg_store',
      nodeId: 'work',
      error: { code: 'TASK_RUN_REATTACH_FAILED', message: 'boom-second' },
      taskRunId: 'task_2',
      occurredAt: now,
      source: { kind: 'daemon' },
      refs: { node_id: 'work', task_run_id: 'task_2' },
      data: { code: 'TASK_RUN_REATTACH_FAILED', message: 'boom-second' },
    })

    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'start',
      task_run_id: 'task_1',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-first' },
      event_id: first.event_id,
    })
    // The later failure updated its own node state but never replaced the cause.
    assert.equal(store.requireProjection('tg_store').nodeStates.work.state, 'failed')
    assert.ok(second.event_id !== first.event_id)
  })

  it('repairs a cancel-policy failed node missing intent/evidence using earliest journal evidence, idempotently', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)
    // Crash artifact: failed node state + node.failed journal persisted, but
    // the cancel-policy cause/intent commit never landed.
    store.putNodeState('tg_store', 'start', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      output: null,
      taskRunId: null,
    }, now)
    const evidence = store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.node.failed',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'start' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom' },
    })

    store.repairCancelPolicyFailure('tg_store', now)

    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'start',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
      event_id: evidence.event_id,
    })

    // Idempotent: a second repair leaves the projection untouched.
    store.repairCancelPolicyFailure('tg_store', now)
    assert.equal(store.requireProjection('tg_store').run.cancelRequested, true)
    assert.deepEqual(store.requireProjection('tg_store').run.failureCause, run.failureCause)
  })

  it('repairs a cancel-policy failed node from node error evidence when no journal row exists', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)
    // Crash before the journal write: only the failed node state is durable.
    store.putNodeState('tg_store', 'start', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-no-journal' },
      output: null,
      taskRunId: 'task_1',
    }, now)

    store.repairCancelPolicyFailure('tg_store', now)

    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'start',
      task_run_id: 'task_1',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-no-journal' },
    })
    assert.equal(run.failureCause?.event_id, undefined)
  })

  it('repair is a no-op for a cancel-policy run that already carries intent and cause', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(minimalGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)
    const cause = {
      kind: 'node_failed' as const,
      node_id: 'start',
      error: { code: 'TASK_RUN_FAILED', message: 'boom' },
    }
    store.putNodeState('tg_store', 'start', {
      state: 'failed', error: cause.error, output: null, taskRunId: null,
    }, now)
    store.updateRun('tg_store', { cancelRequested: true, failureCause: cause }, now)

    store.repairCancelPolicyFailure('tg_store', now)
    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    assert.deepEqual(run.failureCause, cause)
  })

  it('selects the globally earliest durable failure by journal seq across failed nodes and large journals', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(multiNodeGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    // Two failed nodes whose node-row timestamps conflict with journal order:
    // 'right' transitioned to failed later than 'left', but its node.failed
    // journal row carries the earlier seq.
    store.putNodeState('tg_store', 'left', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
      output: null,
      taskRunId: null,
    }, '2026-07-18T00:00:01.000Z')
    store.putNodeState('tg_store', 'right', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
      output: null,
      taskRunId: null,
    }, '2026-07-18T00:00:02.000Z')

    // Fill more than one listEvents page so a page/limit-truncated scan would
    // miss every node.failed event.
    for (let index = 0; index < 1001; index += 1) {
      store.appendJournal({
        taskgraphId: 'tg_store',
        type: 'taskgraph.started',
        occurredAt: now,
        structureRevision: 1,
        source: { kind: 'runner' },
        data: { filler: index },
      })
    }
    const rightEvidence = store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.node.failed',
      occurredAt: '2026-07-18T00:00:02.000Z',
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'right' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
    })
    store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.node.failed',
      occurredAt: '2026-07-18T00:00:01.000Z',
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'left' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
    })

    store.repairCancelPolicyFailure('tg_store', now)

    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    // Journal seq ordering wins over node-row timestamps and page truncation.
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'right',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
      event_id: rightEvidence.event_id,
    })
  })

  it('falls back to the persisted failure-transition ordering, not node creation time, when no journal evidence exists', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(multiNodeGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    // Rewrite right's created_at so node creation time conflicts with the
    // failure-transition time: left was created first but transitioned to
    // failed last; right was created later but transitioned to failed first.
    // No taskgraph.node.failed journal row exists for either node.
    db.prepare(
      `UPDATE taskgraph_node_state SET created_at = '2026-07-18T00:00:02.000Z'
       WHERE taskgraph_id = 'tg_store' AND node_id = 'right'`,
    ).run()
    store.putNodeState('tg_store', 'left', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
      output: null,
      taskRunId: null,
    }, '2026-07-18T00:00:03.000Z')
    store.putNodeState('tg_store', 'right', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
      output: null,
      taskRunId: null,
    }, '2026-07-18T00:00:02.000Z')

    store.repairCancelPolicyFailure('tg_store', now)

    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    // Failure-transition ordering (updated_at) selects 'right', not the
    // earlier-created 'left'.
    assert.deepEqual(run.failureCause, {
      kind: 'node_failed',
      node_id: 'right',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
    })
    assert.equal(run.failureCause?.event_id, undefined)
  })

  it('never replaces an existing cause even when earlier journal evidence points elsewhere', () => {
    const db = initTestDb()
    const store = new TaskGraphStore(db)
    const now = '2026-07-18T00:00:00.000Z'
    store.createProjection(multiNodeGraph(), now, undefined, 'cancel')
    store.updateRun('tg_store', { state: 'running' }, now)

    const cause = {
      kind: 'node_failed' as const,
      node_id: 'left',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-left' },
    }
    store.putNodeState('tg_store', 'left', {
      state: 'failed', error: cause.error, output: null, taskRunId: null,
    }, now)
    store.putNodeState('tg_store', 'right', {
      state: 'failed',
      error: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
      output: null,
      taskRunId: null,
    }, now)
    store.updateRun('tg_store', { cancelRequested: true, failureCause: cause }, now)
    store.appendJournal({
      taskgraphId: 'tg_store',
      type: 'taskgraph.node.failed',
      occurredAt: now,
      structureRevision: 1,
      source: { kind: 'action' },
      refs: { node_id: 'right' },
      data: { code: 'TASK_RUN_FAILED', message: 'boom-right' },
    })

    store.repairCancelPolicyFailure('tg_store', now)
    const run = store.requireProjection('tg_store').run
    assert.equal(run.cancelRequested, true)
    assert.deepEqual(run.failureCause, cause)
  })
})

function minimalGraph(): TaskGraph {
  const start: TaskGraphNode = {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  return {
    id: 'tg_store',
    revision: 1,
    nodes: { start },
  }
}

function multiNodeGraph(): TaskGraph {
  const node = (id: string): TaskGraphNode => ({
    id,
    name: id,
    action: { type: 'task', params: { name: 'fake-task', project: 'foreman' } },
    deps: ['start'],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  })
  const start: TaskGraphNode = {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  return {
    id: 'tg_store',
    revision: 1,
    nodes: {
      start,
      left: node('left'),
      right: node('right'),
    },
  }
}
