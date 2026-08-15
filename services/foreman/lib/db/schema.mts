import type { ForemanDatabase } from './types.mts'

export function bootstrapSchema(database: ForemanDatabase): void {
  const migrate = database.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      database.prepare(statement).run()
    }
  })
  migrate()
  reconcileMessageIdempotencyResultColumn(database)
  reconcileFwaDuplicateSessions(database)
  createFwaActiveSessionIndex(database)
  migrateCurrentSchema(database)
  migrateFwaTranscriptToAgentEvent(database)
  reconcileTaskgraphRunProjectColumn(database)
  reconcileTaskgraphRunFailureColumns(database)
  reconcileTaskgraphRunTitleColumn(database)
  reconcileTaskgraphNodeSlipColumn(database)
  reconcileTaskDefinitionSourceColumn(database)
  dropFwaTranscriptAfterMigration(database)
  reconcileAgentEventKinds(database)
  reconcileAgentTurnOriginColumns(database)
  createAgentDelegationTable(database)
  createAgentMemoryTable(database)
  createTaskRunTelemetryTable(database)
  recreateTaskIndexes(database)
  recreateWorkflowJournalIndexes(database)
  recreateWorkflowStepSnapshotIndexes(database)
}

function reconcileMessageIdempotencyResultColumn(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(message_idempotency_keys)')
    .all()
    .map((column) => column.name))
  if (!columns.has('result_json')) {
    database.prepare('ALTER TABLE message_idempotency_keys ADD COLUMN result_json TEXT').run()
  }
}

function migrateCurrentSchema(database: ForemanDatabase): void {
  const executionsSql = tableCreateSql(database, 'executions')
  const eventsSql = tableCreateSql(database, 'events')
  const needsExecutions = needsCurrentExecutionsMigration(executionsSql)
  const needsEvents = needsCurrentEventsMigration(eventsSql)
  const needsStatusMetadata = needsStatusMetadataMigration(database)
  const needsRepoLocksRemoval = tableCreateSql(database, 'repo_locks') !== undefined
  const needsLegacySessionTablesRemoval = tableExists(database, 'sessions')
    || tableExists(database, 'session_details')
    || tableExists(database, 'session_turns')
    || tableExists(database, 'daily_turns')
    || tableExists(database, 'daily_sessions')
  if (
    !needsExecutions
    && !needsEvents
    && !needsStatusMetadata
    && !needsRepoLocksRemoval
    && !needsLegacySessionTablesRemoval
  ) return

  database.pragma('foreign_keys = OFF')
  database.pragma('legacy_alter_table = ON')
  try {
    database.transaction(() => {
      if (needsExecutions) rebuildExecutionsForCurrentSchema(database)
      if (needsEvents) rebuildEventsForCurrentSchema(database)
      if (needsStatusMetadata) addStatusMetadataColumns(database)
      if (needsRepoLocksRemoval) dropRepoLocksTable(database)
      if (needsLegacySessionTablesRemoval) dropLegacySessionTables(database)
      recreateExecutionIndexes(database)
      recreateEventIndexes(database)
    })()
  } finally {
    database.pragma('legacy_alter_table = OFF')
    database.pragma('foreign_keys = ON')
  }

  const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length > 0) {
    throw new Error(`Foreman DB migration failed foreign key check: ${JSON.stringify(foreignKeyErrors)}`)
  }
}

function tableCreateSql(database: ForemanDatabase, table: string): string | undefined {
  const row = database.prepare<[string], { sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table)
  return row?.sql ?? undefined
}

function tableExists(database: ForemanDatabase, table: string): boolean {
  return tableCreateSql(database, table) !== undefined
}

function needsOpenCodeClientFamilyMigration(sql: string | undefined): boolean {
  return Boolean(sql?.includes("client_family IN ('claude','codex')") && !sql.includes("'opencode'"))
}

function needsCurrentExecutionsMigration(sql: string | undefined): boolean {
  return Boolean(sql && (needsOpenCodeClientFamilyMigration(sql) || /\bsession_id\b/iu.test(sql)))
}

function needsNullableEventExecutionsMigration(sql: string | undefined): boolean {
  return Boolean(sql && /\bexecution_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+executions\(id\)/iu.test(sql))
}

function needsCurrentEventsMigration(sql: string | undefined): boolean {
  return Boolean(sql && (needsNullableEventExecutionsMigration(sql) || /\bsession_id\b/iu.test(sql)))
}

function needsStatusMetadataMigration(database: ForemanDatabase): boolean {
  const taskColumns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(tasks)')
    .all()
    .map((column) => column.name))
  const workflowColumns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(workflows)')
    .all()
    .map((column) => column.name))
  const executionColumns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(executions)')
    .all()
    .map((column) => column.name))
  return !taskColumns.has('failure_category')
    || !taskColumns.has('suggestion')
    || !taskColumns.has('error_message')
    || !taskColumns.has('notified_via_channel')
    || !taskColumns.has('workflow_id')
    || !taskColumns.has('summary')
    || !workflowColumns.has('failure_category')
    || !workflowColumns.has('suggestion')
    || !workflowColumns.has('error_message')
    || !workflowColumns.has('notified_via_channel')
    || !workflowColumns.has('output')
    || !workflowColumns.has('workspace_root')
    || !workflowColumns.has('execution_project')
    || !workflowColumns.has('working_directory')
    || !workflowColumns.has('worktree')
    || !workflowColumns.has('runtime_compat_marker')
    || !executionColumns.has('requested_agent_runtime')
    || !executionColumns.has('resolved_profile')
}

function dropRepoLocksTable(database: ForemanDatabase): void {
  database.prepare('DROP TABLE IF EXISTS repo_locks').run()
}

function dropLegacySessionTables(database: ForemanDatabase): void {
  database.prepare('DROP TABLE IF EXISTS daily_turns').run()
  database.prepare('DROP TABLE IF EXISTS daily_sessions').run()
  database.prepare('DROP TABLE IF EXISTS session_turns').run()
  database.prepare('DROP TABLE IF EXISTS session_details').run()
  database.prepare('DROP TABLE IF EXISTS sessions').run()
}

function addStatusMetadataColumns(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(tasks)')
    .all()
    .map((column) => column.name))
  if (!columns.has('failure_category')) database.prepare('ALTER TABLE tasks ADD COLUMN failure_category TEXT').run()
  if (!columns.has('suggestion')) database.prepare('ALTER TABLE tasks ADD COLUMN suggestion TEXT').run()
  if (!columns.has('error_message')) database.prepare('ALTER TABLE tasks ADD COLUMN error_message TEXT').run()
  if (!columns.has('notified_via_channel')) database.prepare('ALTER TABLE tasks ADD COLUMN notified_via_channel INTEGER NOT NULL DEFAULT 0').run()
  if (!columns.has('workflow_id')) database.prepare('ALTER TABLE tasks ADD COLUMN workflow_id TEXT REFERENCES workflows(id)').run()
  if (!columns.has('summary')) database.prepare('ALTER TABLE tasks ADD COLUMN summary TEXT').run()

  const workflowColumns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(workflows)')
    .all()
    .map((column) => column.name))
  if (!workflowColumns.has('failure_category')) database.prepare('ALTER TABLE workflows ADD COLUMN failure_category TEXT').run()
  if (!workflowColumns.has('suggestion')) database.prepare('ALTER TABLE workflows ADD COLUMN suggestion TEXT').run()
  if (!workflowColumns.has('error_message')) database.prepare('ALTER TABLE workflows ADD COLUMN error_message TEXT').run()
  if (!workflowColumns.has('notified_via_channel')) database.prepare('ALTER TABLE workflows ADD COLUMN notified_via_channel INTEGER NOT NULL DEFAULT 0').run()
  if (!workflowColumns.has('runtime_compat_marker')) database.prepare('ALTER TABLE workflows ADD COLUMN runtime_compat_marker TEXT').run()
  if (!workflowColumns.has('output')) database.prepare('ALTER TABLE workflows ADD COLUMN output TEXT').run()
  if (!workflowColumns.has('workspace_root')) database.prepare('ALTER TABLE workflows ADD COLUMN workspace_root TEXT').run()
  if (!workflowColumns.has('execution_project')) database.prepare('ALTER TABLE workflows ADD COLUMN execution_project TEXT').run()
  if (!workflowColumns.has('working_directory')) database.prepare('ALTER TABLE workflows ADD COLUMN working_directory TEXT').run()
  if (!workflowColumns.has('worktree')) database.prepare('ALTER TABLE workflows ADD COLUMN worktree TEXT').run()

  const executionColumns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(executions)')
    .all()
    .map((column) => column.name))
  if (!executionColumns.has('requested_agent_runtime')) database.prepare('ALTER TABLE executions ADD COLUMN requested_agent_runtime TEXT').run()
  if (!executionColumns.has('resolved_profile')) database.prepare('ALTER TABLE executions ADD COLUMN resolved_profile TEXT').run()
}

function rebuildExecutionsForCurrentSchema(database: ForemanDatabase): void {
  database.prepare('ALTER TABLE executions RENAME TO executions_schema_old').run()
  database.prepare(EXECUTIONS_TABLE_SQL).run()
  database.prepare(`
    INSERT INTO executions (
      id, task_id, profile, permission, cwd, prompt, status,
      native_session_id, client_family, pid, pgid, started_at, ended_at, exit_code,
      kill_signal, kill_reason, output, raw_result, error, timeout_ms,
      requested_agent_runtime, resolved_profile, created_at, updated_at
    )
    SELECT
      id, task_id, profile, permission, cwd, prompt, status,
      native_session_id, client_family, pid, pgid, started_at, ended_at, exit_code,
      kill_signal, kill_reason, output, raw_result, error, timeout_ms,
      NULL, NULL, created_at, updated_at
    FROM executions_schema_old
  `).run()
  database.prepare('DROP TABLE executions_schema_old').run()
}

function rebuildEventsForCurrentSchema(database: ForemanDatabase): void {
  database.prepare('ALTER TABLE events RENAME TO events_schema_old').run()
  database.prepare(EVENTS_TABLE_SQL).run()
  database.prepare(`
    INSERT INTO events (
      id, execution_id, task_id, seq, type, timestamp, data,
      status, exit_code, is_error, created_at
    )
    SELECT
      id, execution_id, task_id, seq, type, timestamp, data,
      status, exit_code, is_error, created_at
    FROM events_schema_old
  `).run()
  database.prepare('DROP TABLE events_schema_old').run()
}

function recreateExecutionIndexes(database: ForemanDatabase): void {
  for (const statement of EXECUTION_INDEX_STATEMENTS) {
    database.prepare(statement).run()
  }
}

function recreateTaskIndexes(database: ForemanDatabase): void {
  database.prepare('CREATE INDEX IF NOT EXISTS idx_task_workflow ON tasks(workflow_id)').run()
}

function recreateWorkflowJournalIndexes(database: ForemanDatabase): void {
  for (const statement of WORKFLOW_JOURNAL_INDEX_STATEMENTS) {
    database.prepare(statement).run()
  }
}

function recreateWorkflowStepSnapshotIndexes(database: ForemanDatabase): void {
  for (const statement of WORKFLOW_STEP_SNAPSHOT_INDEX_STATEMENTS) {
    database.prepare(statement).run()
  }
}

function recreateEventIndexes(database: ForemanDatabase): void {
  for (const statement of EVENT_INDEX_STATEMENTS) {
    database.prepare(statement).run()
  }
}

const EXECUTIONS_TABLE_SQL = `CREATE TABLE executions (
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
)`

const EXECUTION_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status)',
  'CREATE INDEX IF NOT EXISTS idx_exec_task   ON executions(task_id)',
] as const

const EVENTS_TABLE_SQL = `CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id    TEXT REFERENCES executions(id),
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
)`

const WORKFLOW_JOURNAL_TABLE_SQL = `CREATE TABLE workflow_journal (
  id                   TEXT PRIMARY KEY,
  workflow_id          TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL,
  entry_type           TEXT NOT NULL,
  step_seq             INTEGER,
  step_kind            TEXT CHECK(step_kind IN ('task','checkpoint','primitive')),
  step_key             TEXT,
  status               TEXT,
  task_id              TEXT,
  checkpoint_id        TEXT,
  replay_policy        TEXT,
  input_hash           TEXT,
  input_json           TEXT,
  payload_json         TEXT,
  payload_blob_ref     TEXT,
  payload_hash         TEXT,
  schema_json          TEXT,
  error_json           TEXT,
  flow_definition_hash TEXT,
  task_definition_hash TEXT,
  runtime_version      TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE(workflow_id, seq)
)`

const WORKFLOW_STEP_SNAPSHOTS_TABLE_SQL = `CREATE TABLE workflow_step_snapshots (
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_seq        INTEGER NOT NULL,
  step_kind       TEXT NOT NULL CHECK(step_kind IN ('task','checkpoint','primitive')),
  step_key        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN
                    ('running','paused','done','failed','cancelled','interrupted')),
  task_id         TEXT,
  checkpoint_id   TEXT,
  input_hash      TEXT,
  input           TEXT,
  output          TEXT,
  expected_schema TEXT,
  response        TEXT,
  summary         TEXT,
  error           TEXT,
  latest_journal_seq INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  ended_at        TEXT,
  PRIMARY KEY(workflow_id, step_seq)
)`

const WORKFLOW_JOURNAL_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_workflow_journal_workflow ON workflow_journal(workflow_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_journal_replay_key ON workflow_journal(workflow_id, step_key)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_journal_checkpoint ON workflow_journal(workflow_id, checkpoint_id)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_journal_type_created ON workflow_journal(entry_type, created_at)',
] as const

const WORKFLOW_STEP_SNAPSHOT_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_workflow_step_snapshots_workflow ON workflow_step_snapshots(workflow_id, step_seq)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_step_snapshots_task ON workflow_step_snapshots(task_id)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_step_snapshots_checkpoint ON workflow_step_snapshots(workflow_id, checkpoint_id)',
] as const

const EVENT_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_event_created_at ON events(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_event_exec       ON events(execution_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_event_type       ON events(type)',
] as const

const MESSAGES_TABLE_SQL = `CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  from_role       TEXT NOT NULL,
  to_role         TEXT NOT NULL,
  conversation_id TEXT,
  body            TEXT NOT NULL,
  format          TEXT,
  created_at      TEXT NOT NULL
)`

const MESSAGE_DELIVERIES_TABLE_SQL = `CREATE TABLE message_deliveries (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  route_id        TEXT NOT NULL,
  transport       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('pending','sent','delivered','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  delivered_at    TEXT
)`

const MESSAGE_DELIVERY_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_message_deliveries_message ON message_deliveries(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_message_deliveries_status ON message_deliveries(status)',
]

const MESSAGE_IDEMPOTENCY_TABLE_SQL = `CREATE TABLE message_idempotency_keys (
  from_role        TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  result_json      TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (from_role, client_message_id)
)` as const

const PM_TICKETS_TABLE_SQL = `CREATE TABLE pm_tickets (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK(kind IN ('main','sub')),
  project_id          TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL CHECK(status IN ('todo','in_progress','done','blocked')),
  parent_id           TEXT REFERENCES pm_tickets(id) ON DELETE RESTRICT,
  assignee_session_id TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK(kind = 'main' AND parent_id IS NULL OR kind = 'sub' AND parent_id IS NOT NULL),
  CHECK(kind = 'main' OR assignee_session_id IS NULL)
)`

const PM_TICKET_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_pm_ticket_project ON pm_tickets(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_pm_ticket_parent ON pm_tickets(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_pm_ticket_status ON pm_tickets(status)',
  'CREATE INDEX IF NOT EXISTS idx_pm_ticket_assignee ON pm_tickets(assignee_session_id)',
  'CREATE INDEX IF NOT EXISTS idx_pm_ticket_updated ON pm_tickets(updated_at)',
] as const

const TASKGRAPH_RUN_TABLE_SQL = `CREATE TABLE taskgraph_run (
  id                 TEXT PRIMARY KEY,
  state              TEXT NOT NULL CHECK(state IN ('created','running','paused','done','cancelled')),
  cancel_requested   INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  on_node_failure    TEXT NOT NULL DEFAULT 'pause' CHECK(on_node_failure IN ('pause','cancel')),
  failure_cause      TEXT,
  structure_revision INTEGER NOT NULL,
  runner_version     TEXT NOT NULL,
  project            TEXT,
  title              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  ended_at           TEXT
)`

const TASKGRAPH_GRAPH_TABLE_SQL = `CREATE TABLE taskgraph_graph (
  taskgraph_id TEXT PRIMARY KEY REFERENCES taskgraph_run(id) ON DELETE CASCADE,
  graph_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)`

const TASKGRAPH_NODE_STATE_TABLE_SQL = `CREATE TABLE taskgraph_node_state (
  taskgraph_id TEXT NOT NULL REFERENCES taskgraph_run(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK(state IN
                 ('planned','running','waiting','done','failed','interrupted','cancelled')),
  error_json   TEXT,
  output_json  TEXT,
  task_run_id  TEXT,
  slip_json    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(taskgraph_id, node_id)
)`

const TASKGRAPH_JOURNAL_TABLE_SQL = `CREATE TABLE taskgraph_journal (
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
)`

const TASKGRAPH_PATCH_TABLE_SQL = `CREATE TABLE taskgraph_patch (
  id             TEXT PRIMARY KEY,
  taskgraph_id   TEXT NOT NULL REFERENCES taskgraph_run(id) ON DELETE CASCADE,
  base_revision  INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')),
  patch_json     TEXT NOT NULL,
  post_graph_json TEXT NOT NULL,
  errors_json    TEXT,
  created_at     TEXT NOT NULL,
  consumed_at    TEXT
)`

const TASKGRAPH_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_taskgraph_run_state ON taskgraph_run(state)',
  'CREATE INDEX IF NOT EXISTS idx_taskgraph_node_state_run ON taskgraph_node_state(taskgraph_id, state)',
  'CREATE INDEX IF NOT EXISTS idx_taskgraph_node_state_task ON taskgraph_node_state(task_run_id)',
  'CREATE INDEX IF NOT EXISTS idx_taskgraph_journal_run ON taskgraph_journal(taskgraph_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_taskgraph_patch_run ON taskgraph_patch(taskgraph_id, status, base_revision)',
] as const

const FWA_SESSION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS fwa_session (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('idle','running_turn','failed','closed')),
  graph_refs      TEXT NOT NULL DEFAULT '[]',
  task_refs       TEXT NOT NULL DEFAULT '[]',
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)`

const FWA_DOCUMENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS fwa_document (
  session_id    TEXT NOT NULL REFERENCES fwa_session(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY(session_id, path)
)`

// ── Agent conversation / turn / event tables (batch 2A) ──

const AGENT_CONVERSATION_TABLE_SQL = `CREATE TABLE agent_conversation (
  address         TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK(kind IN ('fwa','work')),
  status          TEXT NOT NULL CHECK(status IN ('idle','running','failed','closed')),
  model           TEXT NOT NULL,
  next_event_seq  INTEGER NOT NULL DEFAULT 0,
  next_turn_seq   INTEGER NOT NULL DEFAULT 0,
  system_policy   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)`

const AGENT_TURN_TABLE_SQL = `CREATE TABLE agent_turn (
  address     TEXT NOT NULL REFERENCES agent_conversation(address) ON DELETE CASCADE,
  turn_seq    INTEGER NOT NULL,
  message_id  TEXT,
  state       TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','cancelled')),
  prompt_text TEXT,
  origin      TEXT NOT NULL DEFAULT 'human' CHECK(origin IN ('human', 'system_completion')),
  origin_delegation_id TEXT,
  started_at  TEXT,
  ended_at    TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(address, turn_seq)
)`

const AGENT_EVENT_TABLE_SQL = `CREATE TABLE agent_event (
  address           TEXT NOT NULL REFERENCES agent_conversation(address) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  turn_seq          INTEGER,
  kind              TEXT NOT NULL CHECK(kind IN ('message','assistant','tool_call','tool_result','compact','graph_snapshot','graph_patch_proposal','graph_patch_status','delegation_terminal','turn_completed','turn_forked','turn_merged','turn_failed')),
  payload_json      TEXT NOT NULL,
  compact_covers_through_seq INTEGER,
  compact_summary   TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY(address, seq)
)`

const AGENT_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_agent_event_address_seq ON agent_event(address, seq)',
  'CREATE INDEX IF NOT EXISTS idx_agent_event_turn ON agent_event(address, turn_seq)',
  'CREATE INDEX IF NOT EXISTS idx_agent_turn_state ON agent_turn(address, state)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turn_completion_unique ON agent_turn(address, origin_delegation_id) WHERE origin = \'system_completion\' AND origin_delegation_id IS NOT NULL',
]

const AGENT_DELEGATION_TABLE_SQL = `CREATE TABLE agent_delegation (
  address       TEXT NOT NULL REFERENCES agent_conversation(address) ON DELETE CASCADE,
  turn_seq      INTEGER NOT NULL,
  delegation_id TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'terminal')),
  created_at    TEXT NOT NULL,
  PRIMARY KEY(address, turn_seq, delegation_id),
  FOREIGN KEY(address, turn_seq) REFERENCES agent_turn(address, turn_seq) ON DELETE CASCADE
)`

const AGENT_MEMORY_TABLE_SQL = `CREATE TABLE agent_memory (
  address       TEXT NOT NULL REFERENCES agent_conversation(address) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  version       TEXT NOT NULL,
  corpus_json   TEXT NOT NULL,
  min_event_seq INTEGER NOT NULL,
  max_event_seq INTEGER NOT NULL,
  token_estimate INTEGER,
  created_at    TEXT NOT NULL,
  PRIMARY KEY(address, seq)
)`

/**
 * Durable bounded per-task-run runtime telemetry, keyed by the task run id
 * (a row in `tasks`). Every new task run is initialized atomically to zero
 * counters and tps_complete=1; the counters are only ever incremented by the
 * execution event store for genuinely inserted tool_call / turn_usage events.
 * Legacy task runs that predate this table simply have no row and degrade by
 * omitting telemetry. `tps_complete` is one-way: any persisted usage that is
 * missing, invalid, or wrong-scope permanently disables the run's TPS.
 */
const TASK_RUN_TELEMETRY_TABLE_SQL = `CREATE TABLE task_run_telemetry (
  task_run_id       TEXT PRIMARY KEY REFERENCES tasks(id),
  tool_call_count   INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count >= 0),
  usage_event_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_event_count >= 0),
  output_tokens     INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  agent_turn_ms     INTEGER NOT NULL DEFAULT 0 CHECK(agent_turn_ms >= 0),
  tps_complete      INTEGER NOT NULL DEFAULT 1 CHECK(tps_complete IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
)`

const FWA_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_fwa_session_ticket ON fwa_session(ticket_id, project_id)',
  'CREATE INDEX IF NOT EXISTS idx_fwa_session_status ON fwa_session(status)',
  'CREATE INDEX IF NOT EXISTS idx_fwa_document_session ON fwa_document(session_id)',
] as const

/**
 * Reconcile legacy duplicate non-closed fwa_session rows per (ticket_id, project_id).
 * Keeps the newest created_at/id row and marks older active duplicates as closed
 * with an explanatory last_error and updated_at. Safe for existing and fresh DBs.
 */
function reconcileFwaDuplicateSessions(database: ForemanDatabase): void {
  const duplicates = database.prepare<[], { ticket_id: string; project_id: string; cnt: number }>(
    `SELECT ticket_id, project_id, COUNT(*) as cnt FROM fwa_session WHERE status != 'closed' GROUP BY ticket_id, project_id HAVING cnt > 1`,
  ).all()
  for (const dup of duplicates) {
    const rows = database.prepare<[string, string], { id: string; created_at: string }>(
      `SELECT id, created_at FROM fwa_session WHERE ticket_id = ? AND project_id = ? AND status != 'closed' ORDER BY created_at DESC, id DESC`,
    ).all(dup.ticket_id, dup.project_id)
    // Keep the newest; close all older ones
    for (let i = 1; i < rows.length; i++) {
      database.prepare(
        `UPDATE fwa_session SET status = 'closed', last_error = 'reconciled: duplicate active session merged into newer row', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), rows[i].id)
    }
  }
}

/**
 * Create a partial unique index on (ticket_id, project_id) WHERE status != 'closed'.
 * Run after reconciliation so the insert never creates duplicate active rows.
 */
function createFwaActiveSessionIndex(database: ForemanDatabase): void {
  database.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fwa_session_active_unique ON fwa_session(ticket_id, project_id) WHERE status != 'closed'`,
  ).run()
}

/**
 * Bootstrap migration to add the project column to taskgraph_run for
 * existing databases that predate the schema change. Existing rows
 * remain null/unscoped. The column is already present in the CREATE
 * TABLE statement for fresh databases.
 */
function reconcileTaskgraphRunProjectColumn(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
    .all()
    .map((column) => column.name))
  if (!columns.has('project')) {
    database.prepare('ALTER TABLE taskgraph_run ADD COLUMN project TEXT').run()
  }
}

/**
 * Bootstrap migration to add the on_node_failure policy and failure_cause
 * columns to taskgraph_run for databases that predate the run lifecycle
 * policy. Additive and idempotent: the five-state CHECK constraint and the
 * table body are never rebuilt, and repeated startup is a no-op once the
 * columns exist. Existing rows materialize the historical default ('pause')
 * and a null cause.
 */
function reconcileTaskgraphRunFailureColumns(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
    .all()
    .map((column) => column.name))
  if (!columns.has('on_node_failure')) {
    database.prepare(
      `ALTER TABLE taskgraph_run ADD COLUMN on_node_failure TEXT NOT NULL DEFAULT 'pause'`,
    ).run()
  }
  if (!columns.has('failure_cause')) {
    database.prepare('ALTER TABLE taskgraph_run ADD COLUMN failure_cause TEXT').run()
  }
}

/**
 * Bootstrap migration to add the nullable title column to taskgraph_run for
 * databases that predate create-time run metadata. Additive and idempotent:
 * the column is only added when absent, old rows remain readable with the
 * title omitted, and repeated startup is a no-op once the column exists.
 */
function reconcileTaskgraphRunTitleColumn(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_run)')
    .all()
    .map((column) => column.name))
  if (!columns.has('title')) {
    database.prepare('ALTER TABLE taskgraph_run ADD COLUMN title TEXT').run()
  }
}

/**
 * Bootstrap migration to add the nullable slip_json column to
 * taskgraph_node_state for databases that predate node slip snapshots.
 * Additive and idempotent: the column is only added when absent, old rows
 * remain readable with the slip omitted, and repeated startup is a no-op
 * once the column exists.
 */
function reconcileTaskgraphNodeSlipColumn(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(taskgraph_node_state)')
    .all()
    .map((column) => column.name))
  if (!columns.has('slip_json')) {
    database.prepare('ALTER TABLE taskgraph_node_state ADD COLUMN slip_json TEXT').run()
  }
}

/**
 * Bootstrap migration to add the nullable definition_source column to tasks.
 * `definition_source` durably records the authoritative resolved definition
 * provenance ('builtin' | 'project') for stats, independent of the execution
 * target project. Existing rows keep NULL: pre-migration source is unknown
 * and is never backfilled from project/name/id/current registry heuristics.
 * Additive and idempotent; the column is only added when absent.
 */
function reconcileTaskDefinitionSourceColumn(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(tasks)')
    .all()
    .map((column) => column.name))
  if (!columns.has('definition_source')) {
    database.prepare(
      `ALTER TABLE tasks ADD COLUMN definition_source TEXT CHECK(definition_source IN ('builtin','project'))`,
    ).run()
  }
}

/**
 * One-way migration: copy all fwa_transcript rows into agent_event with
 * deterministic (session_id, seq) ordering. Creates agent_conversation
 * rows for each FWA session with the address derived from session id.
 * If agent_event has no rows for a session, its transcript is imported.
 * The retired table is dropped after the one-way migration.
 */
function migrateFwaTranscriptToAgentEvent(database: ForemanDatabase): void {
  const fwaTranscriptExists = tableExists(database, 'fwa_transcript')
  if (!fwaTranscriptExists) return

  const llmConfig = readFwaLlmConfig(database)

  // Get all fwa_session rows
  const fwaSessions = database.prepare<[], { id: string; ticket_id: string; project_id: string; status: string; created_at: string; updated_at: string }>(
    `SELECT * FROM fwa_session`,
  ).all()

  if (fwaSessions.length === 0) return

  let anyMigrated = false

  database.transaction(() => {
    for (const session of fwaSessions) {
      const address = fwaSessionIdToAddress(session.id)

      // Check if this session has already been migrated (agent_event rows exist)
      const existingEvents = database.prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_event WHERE address = ?`,
      ).get(address)
      if (existingEvents && existingEvents.cnt > 0) continue

      // Create agent_conversation row
      database.prepare(
        `INSERT OR IGNORE INTO agent_conversation (address, kind, status, model, next_event_seq, next_turn_seq, system_policy, created_at, updated_at)
         VALUES (?, 'fwa', ?, ?, 1, 1, NULL, ?, ?)`,
      ).run(address, session.status, llmConfig.model, session.created_at, session.updated_at)

      // Migrate transcript entries into agent_event
      const transcriptRows = database.prepare<[string], {
        session_id: string
        seq: number
        role: string
        content: string
        tool_calls: string | null
        tool_call_id: string | null
        tool_name: string | null
        created_at: string
      }>(
        `SELECT * FROM fwa_transcript WHERE session_id = ? ORDER BY seq ASC`,
      ).all(session.id)

      let eventSeq = 1
      let turnSeq = 1

      for (const row of transcriptRows) {
        let kind: string
        let payload: Record<string, unknown>

        if (row.role === 'human') {
          kind = 'message'
          database.prepare(
            `INSERT OR IGNORE INTO agent_turn (address, turn_seq, state, prompt_text, started_at, ended_at, created_at)
             VALUES (?, ?, 'done', ?, ?, ?, ?)`,
          ).run(address, turnSeq, row.content, row.created_at, row.created_at, row.created_at)
          turnSeq++
          eventSeq = row.seq + 1
          payload = {
            role: row.role,
            content: row.content,
            from: 'codex',
          }
        } else if (row.role === 'assistant') {
          kind = 'assistant'
          payload = {
            role: row.role,
            content: row.content,
            ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
          }
        } else if (row.role === 'tool') {
          kind = 'tool_result'
          payload = {
            role: 'tool',
            content: row.content,
            ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
            ...(row.tool_name ? { tool_name: row.tool_name } : {}),
          }
        } else {
          kind = 'message'
          payload = { role: row.role, content: row.content }
        }

        database.prepare(
          `INSERT OR IGNORE INTO agent_event (address, seq, turn_seq, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(address, row.seq + 1, null, kind, JSON.stringify(payload), row.created_at)
      }

      // Update conversation metadata — next_event_seq is last event seq + 1
      const lastEventInStream = transcriptRows.length > 0 ? transcriptRows[transcriptRows.length - 1].seq + 1 : 1
      database.prepare(
        `UPDATE agent_conversation SET next_event_seq = ?, next_turn_seq = ?, updated_at = ? WHERE address = ?`,
      ).run(lastEventInStream + 1, turnSeq, new Date().toISOString(), address)

      anyMigrated = true
    }
  })()

  if (anyMigrated) {
    // Drop the legacy table after migration
    dropFwaTranscriptTable(database)
  }
}

function dropFwaTranscriptTable(database: ForemanDatabase): void {
  database.prepare('DROP INDEX IF EXISTS idx_fwa_transcript_session').run()
  database.prepare('DROP TABLE IF EXISTS fwa_transcript').run()
}

/**
 * Post-migration cleanup: if fwa_transcript table still exists but
 * has no rows (or was already in the schema but unused), drop it
 * so fresh schemas never use it. Also drop obsolete index.
 * This is safe to run at every bootstrap because DROP IF EXISTS
 * is idempotent.
 */
function dropFwaTranscriptAfterMigration(database: ForemanDatabase): void {
  database.prepare('DROP INDEX IF EXISTS idx_fwa_transcript_session').run()
  database.prepare('DROP TABLE IF EXISTS fwa_transcript').run()
}

function fwaSessionIdToAddress(sessionId: string): string {
  if (!/^fwa_[0-9a-f]{24}$/.test(sessionId)) return sessionId
  return sessionId.replace(/^fwa_/, 'fwa-')
}

interface FwaLlmConfig {
  model: string
}

function readFwaLlmConfig(_database: ForemanDatabase): FwaLlmConfig {
  // Read from config table if present, otherwise default
  return { model: 'foreman-public/default' }
}

/**
 * Bootstrap migration: add origin and origin_delegation_id columns to
 * agent_turn for typed turn origins. Existing rows default to 'human'.
 */
function reconcileAgentTurnOriginColumns(database: ForemanDatabase): void {
  const columns = new Set(database
    .prepare<[], { name: string }>('PRAGMA table_info(agent_turn)')
    .all()
    .map((column) => column.name))
  if (!columns.has('origin')) {
    database.prepare(
      `ALTER TABLE agent_turn ADD COLUMN origin TEXT NOT NULL DEFAULT 'human' CHECK(origin IN ('human', 'system_completion'))`,
    ).run()
  }
  if (!columns.has('origin_delegation_id')) {
    database.prepare(
      'ALTER TABLE agent_turn ADD COLUMN origin_delegation_id TEXT',
    ).run()
  }
}

/**
 * Rebuild legacy agent_event tables whose CHECK constraint predates typed
 * graph, delegation, and per-turn metric events. SQLite cannot alter a CHECK
 * constraint in place, so preserve every row while replacing only this table
 * and its indexes.
 */
function reconcileAgentEventKinds(database: ForemanDatabase): void {
  const sql = tableCreateSql(database, 'agent_event')
  if (!sql || (sql.includes('turn_completed') && sql.includes('turn_forked') && sql.includes('turn_merged') && sql.includes('turn_failed'))) return

  database.pragma('foreign_keys = OFF')
  database.pragma('legacy_alter_table = ON')
  try {
    database.transaction(() => {
      database.prepare('DROP INDEX IF EXISTS idx_agent_event_address_seq').run()
      database.prepare('DROP INDEX IF EXISTS idx_agent_event_turn').run()
      database.prepare('ALTER TABLE agent_event RENAME TO agent_event_schema_old').run()
      database.prepare(AGENT_EVENT_TABLE_SQL).run()
      database.prepare(`
        INSERT INTO agent_event (
          address, seq, turn_seq, kind, payload_json,
          compact_covers_through_seq, compact_summary, created_at
        )
        SELECT
          address, seq, turn_seq, kind, payload_json,
          compact_covers_through_seq, compact_summary, created_at
        FROM agent_event_schema_old
      `).run()
      database.prepare('DROP TABLE agent_event_schema_old').run()
      for (const statement of AGENT_INDEX_STATEMENTS) {
        database.prepare(statement).run()
      }
    })()
  } finally {
    database.pragma('legacy_alter_table = OFF')
    database.pragma('foreign_keys = ON')
  }

  const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length > 0) {
    throw new Error(`Foreman agent-event migration failed foreign key check: ${JSON.stringify(foreignKeyErrors)}`)
  }
}

/**
 * Create the agent_delegation table for exactly-once delegation
 * admission durability. Safe for existing databases (IF NOT EXISTS).
 */
function createAgentDelegationTable(database: ForemanDatabase): void {
  database.prepare(AGENT_DELEGATION_TABLE_SQL.replace(
    'CREATE TABLE agent_delegation', 'CREATE TABLE IF NOT EXISTS agent_delegation',
  )).run()
  database.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_resource ON agent_delegation(resource_id)',
  ).run()
}

/**
 * Create the agent_memory table for versioned context corpus storage.
 * Safe for existing databases (IF NOT EXISTS).
 */
function createAgentMemoryTable(database: ForemanDatabase): void {
  database.prepare(AGENT_MEMORY_TABLE_SQL.replace(
    'CREATE TABLE agent_memory', 'CREATE TABLE IF NOT EXISTS agent_memory',
  )).run()
  database.prepare(
    'CREATE INDEX IF NOT EXISTS idx_agent_memory_address ON agent_memory(address, seq)',
  ).run()
}

/**
 * Create the task_run_telemetry table for durable per-task-run runtime
 * counters. Safe for existing databases (IF NOT EXISTS); legacy rows are
 * unaffected because the table is keyed by task run id and old task runs
 * simply have no telemetry row.
 */
function createTaskRunTelemetryTable(database: ForemanDatabase): void {
  database.prepare(TASK_RUN_TELEMETRY_TABLE_SQL.replace(
    'CREATE TABLE task_run_telemetry', 'CREATE TABLE IF NOT EXISTS task_run_telemetry',
  )).run()
}

const SCHEMA_STATEMENTS = [
  EXECUTIONS_TABLE_SQL.replace('CREATE TABLE executions', 'CREATE TABLE IF NOT EXISTS executions'),
  ...EXECUTION_INDEX_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS tasks (
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
)`,
  'CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status)',
  'CREATE INDEX IF NOT EXISTS idx_task_ended_at ON tasks(ended_at)',
  `CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  flow_name       TEXT NOT NULL, project TEXT,
  workspace_root  TEXT,
  execution_project TEXT,
  working_directory TEXT,
  worktree        TEXT,
  input           TEXT, output TEXT,
  status          TEXT NOT NULL CHECK(status IN
                    ('running','paused','done','failed','cancelled','interrupted')),
  checkpoint      TEXT,
  current_phase   TEXT, error TEXT,
  failure_category TEXT,
  suggestion      TEXT,
  error_message   TEXT,
  notified_via_channel INTEGER NOT NULL DEFAULT 0,
  runtime_compat_marker TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
)`,
  WORKFLOW_JOURNAL_TABLE_SQL.replace('CREATE TABLE workflow_journal', 'CREATE TABLE IF NOT EXISTS workflow_journal'),
  ...WORKFLOW_JOURNAL_INDEX_STATEMENTS,
  WORKFLOW_STEP_SNAPSHOTS_TABLE_SQL.replace('CREATE TABLE workflow_step_snapshots', 'CREATE TABLE IF NOT EXISTS workflow_step_snapshots'),
  ...WORKFLOW_STEP_SNAPSHOT_INDEX_STATEMENTS,
  EVENTS_TABLE_SQL.replace('CREATE TABLE events', 'CREATE TABLE IF NOT EXISTS events'),
  ...EVENT_INDEX_STATEMENTS,
  MESSAGES_TABLE_SQL.replace('CREATE TABLE messages', 'CREATE TABLE IF NOT EXISTS messages'),
  MESSAGE_DELIVERIES_TABLE_SQL.replace('CREATE TABLE message_deliveries', 'CREATE TABLE IF NOT EXISTS message_deliveries'),
  ...MESSAGE_DELIVERY_INDEX_STATEMENTS,
  MESSAGE_IDEMPOTENCY_TABLE_SQL.replace('CREATE TABLE message_idempotency_keys', 'CREATE TABLE IF NOT EXISTS message_idempotency_keys'),
  PM_TICKETS_TABLE_SQL.replace('CREATE TABLE pm_tickets', 'CREATE TABLE IF NOT EXISTS pm_tickets'),
  ...PM_TICKET_INDEX_STATEMENTS,
  TASKGRAPH_RUN_TABLE_SQL.replace('CREATE TABLE taskgraph_run', 'CREATE TABLE IF NOT EXISTS taskgraph_run'),
  TASKGRAPH_GRAPH_TABLE_SQL.replace('CREATE TABLE taskgraph_graph', 'CREATE TABLE IF NOT EXISTS taskgraph_graph'),
  TASKGRAPH_NODE_STATE_TABLE_SQL.replace('CREATE TABLE taskgraph_node_state', 'CREATE TABLE IF NOT EXISTS taskgraph_node_state'),
  TASKGRAPH_JOURNAL_TABLE_SQL.replace('CREATE TABLE taskgraph_journal', 'CREATE TABLE IF NOT EXISTS taskgraph_journal'),
  TASKGRAPH_PATCH_TABLE_SQL.replace('CREATE TABLE taskgraph_patch', 'CREATE TABLE IF NOT EXISTS taskgraph_patch'),
  ...TASKGRAPH_INDEX_STATEMENTS,
  AGENT_CONVERSATION_TABLE_SQL.replace('CREATE TABLE agent_conversation', 'CREATE TABLE IF NOT EXISTS agent_conversation'),
  AGENT_TURN_TABLE_SQL.replace('CREATE TABLE agent_turn', 'CREATE TABLE IF NOT EXISTS agent_turn'),
  AGENT_EVENT_TABLE_SQL.replace('CREATE TABLE agent_event', 'CREATE TABLE IF NOT EXISTS agent_event'),
  ...AGENT_INDEX_STATEMENTS,
  AGENT_DELEGATION_TABLE_SQL.replace('CREATE TABLE agent_delegation', 'CREATE TABLE IF NOT EXISTS agent_delegation'),
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_resource ON agent_delegation(resource_id)',
  AGENT_MEMORY_TABLE_SQL.replace('CREATE TABLE agent_memory', 'CREATE TABLE IF NOT EXISTS agent_memory'),
  'CREATE INDEX IF NOT EXISTS idx_agent_memory_address ON agent_memory(address, seq)',
  TASK_RUN_TELEMETRY_TABLE_SQL.replace('CREATE TABLE task_run_telemetry', 'CREATE TABLE IF NOT EXISTS task_run_telemetry'),
  FWA_SESSION_TABLE_SQL,
  FWA_DOCUMENT_TABLE_SQL,
  ...FWA_INDEX_STATEMENTS,
] as const
