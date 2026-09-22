import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import test from 'node:test'
import { closeDb, initDb } from '../lib/db/connection.mts'
import { foremanStateRoot } from '../lib/config/state.mts'

function tableColumnNames(db: Database.Database, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => column.name)
}

function tableColumnInfo(db: Database.Database, table: string, name: string): { notnull: number } | undefined {
  return db.prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(${table})`).all()
    .find((column) => column.name === name)
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare<[string], { name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table)
  return Boolean(row)
}

test('wrenyard state root defaults to wrenyard and honors primary env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-state-root-'))
  try {
    assert.equal(foremanStateRoot({ WRENYARD_STATE_HOME: dir }), dir)
    assert.equal(foremanStateRoot({ XDG_STATE_HOME: dir }), join(dir, 'wrenyard'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb does not create persistent repo lock storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-no-repo-locks-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const db = initDb(dbPath)
    assert.equal(tableExists(db, 'repo_locks'), false)
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb removes legacy persistent repo lock storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-drop-repo-locks-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    initDb(dbPath)
    closeDb()

    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE repo_locks (
        repo_path              TEXT PRIMARY KEY,
        holder_execution_id    TEXT NOT NULL REFERENCES executions(id),
        mode                   TEXT NOT NULL CHECK(mode IN ('edit','yolo')),
        acquired_at            TEXT NOT NULL
      );
    `)
    oldDb.close()

    const db = initDb(dbPath)
    assert.equal(tableExists(db, 'repo_locks'), false)
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb migrates executions and drops legacy session tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE executions (
        id                TEXT PRIMARY KEY,
        task_id           TEXT REFERENCES tasks(id),
        session_id        TEXT REFERENCES sessions(id),
        profile           TEXT NOT NULL,
        permission        TEXT NOT NULL CHECK(permission IN ('readonly','edit','yolo')),
        cwd               TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN
                          ('queued','starting','running','done','failed','cancelled','timeout','interrupted')),
        native_session_id TEXT,
        client_family     TEXT CHECK(client_family IN ('claude','codex')),
        pid               INTEGER, pgid INTEGER,
        started_at        TEXT, ended_at TEXT,
        exit_code         INTEGER, kill_signal TEXT,
        kill_reason       TEXT CHECK(kill_reason IN ('cancel','timeout','shutdown','crash','spawn-error')),
        output            TEXT, raw_result TEXT, error TEXT,
        timeout_ms        INTEGER,
        created_at        TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id                  TEXT PRIMARY KEY,
        client_family       TEXT NOT NULL CHECK(client_family IN ('claude','codex')),
        native_session_id   TEXT,
        profile             TEXT NOT NULL,
        cwd                 TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','active','invalid')),
        turn_count          INTEGER NOT NULL DEFAULT 0,
        active_turn         INTEGER DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    oldDb.close()

    const db = initDb(dbPath)
    const now = new Date().toISOString()
    assert.equal(tableExists(db, 'sessions'), false)
    assert.equal(tableColumnNames(db, 'executions').includes('session_id'), false)
    assert.doesNotThrow(() => {
      db.prepare(`
        INSERT INTO executions (
          id, profile, permission, cwd, prompt, status, client_family, created_at, updated_at
        ) VALUES (
          'exec_opencode', 'opencode-test', 'readonly', '/tmp', 'prompt', 'queued', 'opencode', ?, ?
        )
      `).run(now, now)
    })
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb migrates a deployed opencode-only client_family CHECK without metadata loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-deployed-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    // Seed the exact deployed opencode-era schema: a client_family CHECK that
    // accepts claude/codex/opencode but omits cursor, plus the
    // requested_agent_runtime and resolved_profile metadata columns.
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        template        TEXT NOT NULL,
        project         TEXT,
        worktree        TEXT,
        input           TEXT, output TEXT, summary TEXT, error TEXT,
        workflow_id     TEXT REFERENCES workflows(id),
        failure_category TEXT,
        suggestion      TEXT,
        error_message   TEXT,
        notified_via_channel INTEGER NOT NULL DEFAULT 0,
        definition_source TEXT CHECK(definition_source IN ('builtin','project')),
        status          TEXT NOT NULL CHECK(status IN
                          ('queued','running','done','failed','cancelled','interrupted')),
        structured      INTEGER DEFAULT 0,
        execution_id    TEXT REFERENCES executions(id),
        retry_policy    TEXT NOT NULL DEFAULT 'side-effects'
                          CHECK(retry_policy IN ('idempotent','side-effects','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE executions (
        id                TEXT PRIMARY KEY,
        task_id           TEXT REFERENCES tasks(id),
        profile           TEXT NOT NULL,
        permission        TEXT NOT NULL CHECK(permission IN ('readonly','edit','yolo')),
        cwd               TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN
                          ('queued','starting','running','done','failed','cancelled','timeout','interrupted')),
        native_session_id TEXT,
        client_family     TEXT CHECK(client_family IN ('claude','codex','opencode')),
        pid               INTEGER, pgid INTEGER,
        started_at        TEXT, ended_at TEXT,
        exit_code         INTEGER, kill_signal TEXT,
        kill_reason       TEXT CHECK(kill_reason IN ('cancel','timeout','shutdown','crash','spawn-error')),
        output            TEXT, raw_result TEXT, error TEXT,
        timeout_ms        INTEGER,
        requested_agent_runtime TEXT,
        resolved_profile  TEXT,
        created_at        TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    const now = new Date().toISOString()
    oldDb.prepare(
      `INSERT INTO executions (
        id, profile, permission, cwd, prompt, status, native_session_id, client_family,
        requested_agent_runtime, resolved_profile, created_at, updated_at
      ) VALUES (?, ?, 'readonly', '/tmp', 'deployed prompt', 'done', 'native-deployed-1', 'opencode', 'forge/fast', 'cb-deployed', ?, ?)`,
    ).run('exec_deployed', 'deployed-profile', now, now)
    oldDb.close()

    const db = initDb(dbPath)

    // The rebuilt CHECK must now accept cursor.
    const migrated = db.prepare<[string], { requested_agent_runtime: string | null; resolved_profile: string | null }>(
      `SELECT requested_agent_runtime, resolved_profile FROM executions WHERE id = ?`,
    ).get('exec_deployed')
    assert.ok(migrated, 'expected migrated execution row')
    assert.equal(migrated.requested_agent_runtime, 'forge/fast', 'requested_agent_runtime must survive losslessly')
    assert.equal(migrated.resolved_profile, 'cb-deployed', 'resolved_profile must survive losslessly')

    assert.doesNotThrow(() => {
      db.prepare(`
        INSERT INTO executions (
          id, profile, permission, cwd, prompt, status, client_family, created_at, updated_at
        ) VALUES (
          'exec_cursor', 'cursor-test', 'readonly', '/tmp', 'prompt', 'queued', 'cursor', ?, ?
        )
      `).run(now, now)
    }, 'migrated client_family CHECK must accept cursor')
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb adds DB-backed task and workflow status metadata columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-status-metadata-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        template        TEXT NOT NULL,
        project         TEXT,
        worktree        TEXT,
        input           TEXT, output TEXT, error TEXT,
        status          TEXT NOT NULL CHECK(status IN
                          ('queued','running','done','failed','cancelled','interrupted')),
        structured      INTEGER DEFAULT 0,
        execution_id    TEXT,
        retry_policy    TEXT NOT NULL DEFAULT 'side-effects'
                          CHECK(retry_policy IN ('idempotent','side-effects','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE workflows (
        id              TEXT PRIMARY KEY,
        flow_name       TEXT NOT NULL, project TEXT,
        input           TEXT,
        status          TEXT NOT NULL CHECK(status IN
                          ('running','paused','done','failed','cancelled','interrupted')),
        checkpoint      TEXT,
        current_phase   TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
    `)
    oldDb.close()

    const db = initDb(dbPath)
    assert.deepEqual(
      ['failure_category', 'suggestion', 'error_message', 'notified_via_channel', 'workflow_id', 'summary']
        .filter((column) => !tableColumnNames(db, 'tasks').includes(column)),
      [],
    )
    assert.deepEqual(
      [
        'failure_category',
        'suggestion',
        'error_message',
        'notified_via_channel',
        'output',
        'workspace_root',
        'execution_project',
        'working_directory',
        'worktree',
      ]
        .filter((column) => !tableColumnNames(db, 'workflows').includes(column)),
      [],
    )
    assert.deepEqual(
      [
        'workflow_id',
        'seq',
        'entry_type',
        'step_seq',
        'step_kind',
        'step_key',
        'status',
        'task_id',
        'checkpoint_id',
        'replay_policy',
        'input_hash',
        'input_json',
        'payload_json',
        'payload_blob_ref',
        'payload_hash',
        'schema_json',
        'error_json',
        'flow_definition_hash',
        'task_definition_hash',
        'runtime_version',
        'created_at',
      ]
        .filter((column) => !tableColumnNames(db, 'workflow_journal').includes(column)),
      [],
    )
    assert.deepEqual(
      [
        'workflow_id',
        'step_seq',
        'step_kind',
        'step_key',
        'status',
        'task_id',
        'checkpoint_id',
        'input_hash',
        'input',
        'output',
        'expected_schema',
        'response',
        'summary',
        'error',
        'latest_journal_seq',
        'created_at',
        'updated_at',
        'ended_at',
      ]
        .filter((column) => !tableColumnNames(db, 'workflow_step_snapshots').includes(column)),
      [],
    )
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb adds tasks.definition_source nullable and keeps existing rows NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-definition-source-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        template        TEXT NOT NULL,
        project         TEXT,
        worktree        TEXT,
        input           TEXT, output TEXT, error TEXT,
        status          TEXT NOT NULL CHECK(status IN
                          ('queued','running','done','failed','cancelled','interrupted')),
        structured      INTEGER DEFAULT 0,
        execution_id    TEXT,
        retry_policy    TEXT NOT NULL DEFAULT 'side-effects'
                          CHECK(retry_policy IN ('idempotent','side-effects','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
    `)
    const now = new Date().toISOString()
    oldDb.prepare(
      `INSERT INTO tasks (id, template, project, status, retry_policy, created_at, updated_at)
       VALUES ('legacy_run', 'legacy', 'app', 'done', 'side-effects', ?, ?)`,
    ).run(now, now)
    oldDb.close()

    const db = initDb(dbPath)
    assert.ok(
      tableColumnNames(db, 'tasks').includes('definition_source'),
      'tasks should gain the definition_source column',
    )
    const definitionSourceInfo = tableColumnInfo(db, 'tasks', 'definition_source')
    assert.equal(definitionSourceInfo?.notnull, 0, 'definition_source must stay nullable')

    // Existing rows are pre-migration unknown: definition_source stays NULL
    // and must never be backfilled from project/name/id.
    const legacy = db.prepare<[], { definition_source: string | null }>(
      `SELECT definition_source FROM tasks WHERE id = 'legacy_run'`,
    ).get()
    assert.equal(legacy?.definition_source, null)
    closeDb()
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh initDb schema constrains tasks.definition_source to builtin|project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-definition-source-fresh-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const db = initDb(dbPath)
    const now = new Date().toISOString()
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO tasks (id, template, definition_source, status, retry_policy, created_at, updated_at)
         VALUES ('builtin_run', 'explore', 'builtin', 'done', 'side-effects', ?, ?)`,
      ).run(now, now)
    })
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO tasks (id, template, definition_source, status, retry_policy, created_at, updated_at)
         VALUES ('project_run', 'edit', 'project', 'done', 'side-effects', ?, ?)`,
      ).run(now, now)
    })
    assert.throws(
      () => {
        db.prepare(
          `INSERT INTO tasks (id, template, definition_source, status, retry_policy, created_at, updated_at)
           VALUES ('bad_run', 'edit', 'workspace', 'done', 'side-effects', ?, ?)`,
        ).run(now, now)
      },
      /CHECK/,
    )
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb migrates events.execution_id to nullable for task lifecycle events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-events-nullable-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id    TEXT NOT NULL REFERENCES executions(id),
        task_id         TEXT REFERENCES tasks(id),
        seq             INTEGER NOT NULL,
        type            TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        data            TEXT,
        status          TEXT,
        exit_code       INTEGER,
        is_error        INTEGER,
        created_at      TEXT NOT NULL,
        UNIQUE(execution_id, seq)
      );
    `)
    oldDb.close()

    const db = initDb(dbPath)
    assert.equal(tableColumnInfo(db, 'events', 'execution_id')?.notnull, 0)
    assert.equal(tableColumnNames(db, 'events').includes('session_id'), false)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (
        id, template, status, structured, retry_policy, created_at, updated_at
      ) VALUES (
        'task_done', 'demo', 'done', 1, 'side-effects', ?, ?
      )
    `).run(now, now)
    assert.doesNotThrow(() => {
      db.prepare(`
        INSERT INTO events (
          execution_id, task_id, seq, type, timestamp, data,
          status, exit_code, is_error, created_at
        ) VALUES (
          NULL, 'task_done', 0, 'task.done', ?, '{"summary":"done"}',
          'done', NULL, 0, ?
        )
      `).run(now, now)
    })
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh initDb schema exposes nullable task_run_attempt_dispatch.auto_routing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-auto-routing-fresh-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const db = initDb(dbPath)
    assert.ok(
      tableColumnNames(db, 'task_run_attempt_dispatch').includes('auto_routing'),
      'fresh dispatch schema must include auto_routing',
    )
    assert.equal(
      tableColumnInfo(db, 'task_run_attempt_dispatch', 'auto_routing')?.notnull,
      0,
      'auto_routing must stay nullable',
    )

    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, template, status, retry_policy, created_at, updated_at)
       VALUES ('task_auto_fresh', 'task', 'done', 'side-effects', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
       VALUES ('exec_auto_fresh', 'task_auto_fresh', 'p', 'readonly', '/tmp', 'p', 'done', ?, ?)`,
    ).run(now, now)
    const decisionJson = JSON.stringify({
      snapshot_id: 'snap-fresh',
      selected_rank: 0,
      supply_class: 'standard',
      quota_tier: 'healthy',
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 3,
      routing_output_usd_per_million: 2,
      effective_cap_usd_per_million: 4,
      score: 0.9,
      reasons: ['lowest reference price'],
    })
    db.prepare(
      `INSERT INTO task_run_attempt_dispatch (execution_id, task_run_id, model, model_id, auto_routing, created_at, updated_at)
       VALUES (?, ?, 'sonnet', 'claude-sonnet-4', ?, ?, ?)`,
    ).run('exec_auto_fresh', 'task_auto_fresh', decisionJson, now, now)
    const row = db.prepare<[], { auto_routing: string | null }>(
      `SELECT auto_routing FROM task_run_attempt_dispatch WHERE execution_id = 'exec_auto_fresh'`,
    ).get()
    assert.equal(row?.auto_routing, decisionJson, 'fresh schema stores auto_routing JSON text verbatim')
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initDb idempotently migrates nullable auto_routing onto legacy dispatch rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-db-auto-routing-legacy-'))
  const dbPath = join(dir, 'wrenyard.db')
  try {
    const now = new Date().toISOString()
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE workflows (
        id              TEXT PRIMARY KEY,
        flow_name       TEXT NOT NULL, project TEXT,
        input           TEXT,
        status          TEXT NOT NULL CHECK(status IN
                          ('running','paused','done','failed','cancelled','interrupted')),
        checkpoint      TEXT,
        current_phase   TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        template        TEXT NOT NULL,
        project         TEXT,
        worktree        TEXT,
        input           TEXT, output TEXT, summary TEXT, error TEXT,
        workflow_id     TEXT REFERENCES workflows(id),
        failure_category TEXT,
        suggestion      TEXT,
        error_message   TEXT,
        notified_via_channel INTEGER NOT NULL DEFAULT 0,
        definition_source TEXT CHECK(definition_source IN ('builtin','project')),
        status          TEXT NOT NULL CHECK(status IN
                          ('queued','running','done','failed','cancelled','interrupted')),
        structured      INTEGER DEFAULT 0,
        execution_id    TEXT REFERENCES executions(id),
        retry_policy    TEXT NOT NULL DEFAULT 'side-effects'
                          CHECK(retry_policy IN ('idempotent','side-effects','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE executions (
        id                TEXT PRIMARY KEY,
        task_id           TEXT REFERENCES tasks(id),
        profile           TEXT NOT NULL,
        permission        TEXT NOT NULL CHECK(permission IN ('readonly','edit','yolo')),
        cwd               TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN
                          ('queued','starting','running','done','failed','cancelled','timeout','interrupted')),
        native_session_id TEXT,
        client_family     TEXT CHECK(client_family IN ('claude','codex','opencode','cursor')),
        pid               INTEGER, pgid INTEGER,
        started_at        TEXT, ended_at TEXT,
        exit_code         INTEGER, kill_signal TEXT,
        kill_reason       TEXT CHECK(kill_reason IN ('cancel','timeout','shutdown','crash','spawn-error')),
        output            TEXT, raw_result TEXT, error TEXT,
        timeout_ms        INTEGER,
        requested_agent_runtime TEXT,
        resolved_profile  TEXT,
        created_at        TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_run_attempt_dispatch (
        execution_id TEXT PRIMARY KEY REFERENCES executions(id),
        task_run_id  TEXT NOT NULL REFERENCES tasks(id),
        requested_agent_runtime TEXT,
        profile TEXT, client TEXT, provider TEXT, model TEXT, model_id TEXT,
        mode TEXT, protocol TEXT,
        speed_effective_tps REAL, speed_source TEXT, speed_sample_count INTEGER,
        speed_checked_at TEXT, speed_expected_tps_met INTEGER,
        speed_degradation_reason TEXT, intelligence TEXT,
        reference_pricing_input REAL, reference_pricing_output REAL,
        reference_pricing_cache REAL, reference_pricing_cache_write REAL,
        reference_pricing_source TEXT, reference_pricing_checked_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    oldDb.prepare(
      `INSERT INTO tasks (id, template, status, retry_policy, created_at, updated_at)
       VALUES ('task_auto_legacy', 'task', 'done', 'side-effects', ?, ?)`,
    ).run(now, now)
    oldDb.prepare(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at)
       VALUES ('exec_auto_legacy', 'task_auto_legacy', 'p', 'readonly', '/tmp', 'p', 'done', ?, ?)`,
    ).run(now, now)
    oldDb.prepare(
      `INSERT INTO task_run_attempt_dispatch (execution_id, task_run_id, model, model_id, created_at, updated_at)
       VALUES ('exec_auto_legacy', 'task_auto_legacy', 'sonnet', 'claude-sonnet-4', ?, ?)`,
    ).run(now, now)
    oldDb.close()

    const db = initDb(dbPath)
    assert.ok(
      tableColumnNames(db, 'task_run_attempt_dispatch').includes('auto_routing'),
      'legacy dispatch table must gain the auto_routing column',
    )
    assert.equal(
      tableColumnInfo(db, 'task_run_attempt_dispatch', 'auto_routing')?.notnull,
      0,
      'auto_routing must stay nullable',
    )
    const legacy = db.prepare<[], { model_id: string; auto_routing: string | null }>(
      `SELECT model_id, auto_routing FROM task_run_attempt_dispatch WHERE execution_id = 'exec_auto_legacy'`,
    ).get()
    assert.equal(legacy?.model_id, 'claude-sonnet-4', 'legacy dispatch row must survive the migration')
    assert.equal(legacy?.auto_routing, null, 'legacy rows keep NULL auto_routing')
    closeDb()

    // A second bootstrap is an idempotent no-op: the column stays and the row
    // remains readable with NULL auto_routing.
    const db2 = initDb(dbPath)
    assert.ok(
      tableColumnNames(db2, 'task_run_attempt_dispatch').includes('auto_routing'),
      'repeated initDb must not duplicate or drop auto_routing',
    )
    const again = db2.prepare<[], { model_id: string; auto_routing: string | null }>(
      `SELECT model_id, auto_routing FROM task_run_attempt_dispatch WHERE execution_id = 'exec_auto_legacy'`,
    ).get()
    assert.equal(again?.model_id, 'claude-sonnet-4', 'legacy row survives a second bootstrap')
    assert.equal(again?.auto_routing, null, 'legacy row stays NULL after a second bootstrap')
    closeDb()
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})
