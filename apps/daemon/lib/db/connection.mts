import Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { foremanStateRoot } from '../config/state.mts'
import { bootstrapSchema } from './schema.mts'
import type { ForemanDatabase, RunResult, TransactionCallback } from './types.mts'

let db: ForemanDatabase | undefined
let openedPath: string | undefined
let detectedAutoVacuumMode: number | undefined

const PREPARED_STATEMENT_CACHE_LIMIT = 512

const preparedStatements = new WeakMap<ForemanDatabase, Map<string, Statement>>()

const SLOW_QUERY_THRESHOLD_MS = 100
const SLOW_QUERY_SQL_MAX_CHARS = 200

type SlowQueryLogger = (info: { op: 'query' | 'get' | 'run'; sql: string; durationMs: number }) => void
let slowQueryLogger: SlowQueryLogger | undefined

/** Registers (or, with null, clears) the observer for synchronous queries at or above the slow threshold. */
export function setSlowQueryLogger(fn: SlowQueryLogger | null): void {
  slowQueryLogger = fn ?? undefined
}

function reportSlowQuery(op: 'query' | 'get' | 'run', sql: string, durationMs: number): void {
  if (!slowQueryLogger || durationMs < SLOW_QUERY_THRESHOLD_MS) return
  try {
    // Only op, truncated SQL, and duration — bound params/values never leave.
    slowQueryLogger({ op, sql: sql.slice(0, SLOW_QUERY_SQL_MAX_CHARS), durationMs })
  } catch {
    // A logging failure must never break a query.
  }
}

/**
 * Wrenyard application data queries must use query/get/run below so statements
 * are prepared and values are passed as bound parameters. getDb() exists for
 * transaction internals, migrations, and schema bootstrap only.
 */
export function initDb(path?: string): ForemanDatabase {
  const nextPath = normalizeDbPath(path ?? defaultDbPath())

  if (db?.open) {
    if (openedPath !== nextPath) {
      throw new Error(`Wrenyard DB already initialized at ${openedPath}`)
    }
    return db
  }

  ensureDbDirectory(nextPath)

  // A fresh file starts in INCREMENTAL mode so free pages can be reclaimed
  // gradually. An existing database that reports NONE (0) is left untouched:
  // converting it requires a full VACUUM, which must not run synchronously on
  // the daemon main thread — that conversion is the startup-only migration in
  // auto-vacuum-convert.mts.
  const freshFile = nextPath === ':memory:' || !existsSync(nextPath)
  const nextDb = new Database(nextPath)

  try {
    ensureDbFileMode(nextPath)
    applyPragmas(nextDb, freshFile)
    bootstrapSchema(nextDb)
    // Auxiliary run ledger: one row per finished auxiliary run, keyed by its
    // action id. Created idempotently so existing databases pick it up at open
    // without touching any other table.
    nextDb.prepare(`CREATE TABLE IF NOT EXISTS auxiliary_runs (
      id            TEXT PRIMARY KEY,
      role          TEXT NOT NULL,
      caller_origin TEXT NOT NULL DEFAULT 'session',
      caller_id     TEXT,
      provider      TEXT,
      model         TEXT,
      effort        TEXT,
      status        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      usage         TEXT,
      summary       TEXT,
      observations  TEXT
    )`).run()
    const auxiliaryRunColumns = nextDb.prepare('PRAGMA table_info(auxiliary_runs)').all() as { name: string }[]
    if (!auxiliaryRunColumns.some((column) => column.name === 'observations')) {
      nextDb.prepare('ALTER TABLE auxiliary_runs ADD COLUMN observations TEXT').run()
    }
    nextDb.prepare(
      'CREATE INDEX IF NOT EXISTS idx_auxiliary_runs_finished ON auxiliary_runs(COALESCE(finished_at, created_at) DESC, created_at DESC)',
    ).run()
  } catch (error) {
    if (nextDb.open) nextDb.close()
    throw error
  }

  openedPath = nextPath
  db = nextDb

  return nextDb
}

export function getDb(): ForemanDatabase {
  if (!db?.open) throw new Error('Wrenyard DB has not been initialized')
  return db
}

export function cachedStatement<Params extends unknown[] = unknown[], Result = unknown>(
  database: ForemanDatabase,
  sql: string,
): Statement<Params, Result> {
  let bySql = preparedStatements.get(database)
  if (!bySql) {
    bySql = new Map()
    preparedStatements.set(database, bySql)
  }
  const cached = bySql.get(sql)
  if (cached) return cached as Statement<Params, Result>
  if (bySql.size >= PREPARED_STATEMENT_CACHE_LIMIT) bySql.clear()
  const statement = database.prepare(sql) as Statement<Params, Result>
  bySql.set(sql, statement)
  return statement
}

export function query<T>(sql: string, ...params: unknown[]): T[] {
  const startedAt = performance.now()
  const rows = cachedStatement<unknown[], T>(getDb(), sql).all(...params)
  reportSlowQuery('query', sql, performance.now() - startedAt)
  return rows
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  const startedAt = performance.now()
  const row = cachedStatement<unknown[], T>(getDb(), sql).get(...params)
  reportSlowQuery('get', sql, performance.now() - startedAt)
  return row
}

export function run(sql: string, ...params: unknown[]): RunResult {
  const startedAt = performance.now()
  const result = cachedStatement<unknown[]>(getDb(), sql).run(...params)
  reportSlowQuery('run', sql, performance.now() - startedAt)
  return result
}

export function closeDb(): void {
  if (db?.open) db.close()
  db = undefined
  openedPath = undefined
  detectedAutoVacuumMode = undefined
}

export function tx<T>(fn: TransactionCallback<T>): T {
  const database = getDb()
  return database.transaction(() => fn(database))()
}

function defaultDbPath(): string {
  return join(foremanStateRoot(), 'wrenyard.db')
}

function normalizeDbPath(path: string): string {
  if (path === ':memory:') return path
  return resolve(path)
}

function ensureDbDirectory(path: string): void {
  if (path === ':memory:') return
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodBestEffort(dir, 0o700)
}

function ensureDbFileMode(path: string): void {
  if (path === ':memory:') return
  chmodBestEffort(path, 0o600)
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (error) {
    if (!isIgnorableWindowsChmodError(error)) throw error
  }
}

function isIgnorableWindowsChmodError(error: unknown): boolean {
  if (process.platform !== 'win32' || !error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EINVAL'
}

function applyPragmas(database: ForemanDatabase, freshFile: boolean): void {
  // Set the page layout before WAL initializes the file header; afterwards a
  // NONE database needs a full VACUUM to adopt incremental reclamation.
  if (freshFile) {
    database.pragma('auto_vacuum = INCREMENTAL')
  }
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  const mode = database.pragma('auto_vacuum', { simple: true })
  detectedAutoVacuumMode = typeof mode === 'number' ? mode : undefined
}

/** The auto_vacuum mode detected when the database was opened (0 = NONE). */
export function detectedAutoVacuum(): number | undefined {
  return detectedAutoVacuumMode
}

/**
 * Shutdown fence for suspended cleanup work.
 *
 * Daemon close drains the serialized cleanup chain cooperatively and releases
 * the database afterwards. Until the drain deadline expires the database stays
 * fully usable, so a normal (non-timeout) cleanup always finalizes its audit
 * row. If the deadline wins, the fence is armed and every later statement from
 * a suspended cleanup path — audit finalization included — is refused instead
 * of running against a released or closed connection.
 */
let suspendedCleanupFence = false

/** Arm or clear the suspended-cleanup fence. */
export function setSuspendedCleanupFence(armed: boolean): void {
  suspendedCleanupFence = armed
}

/**
 * Refuse a cleanup statement once the fence is armed or the process database is
 * already closed. Throws so the caller abandons the suspended run rather than
 * executing SQL against a released database.
 */
export function assertCleanupDbUsable(operation: string): void {
  if (suspendedCleanupFence || (db !== undefined && !db.open)) {
    throw new Error(`cleanup ${operation} refused: database is fenced or released during shutdown`)
  }
}

const INCREMENTAL_VACUUM_DEFAULT_CHUNK = 64

/**
 * Reclaim free pages in bounded chunks with an event-loop yield between each
 * `PRAGMA incremental_vacuum(N)` step so a long reclamation never blocks the
 * daemon. Safe under WAL: incremental_vacuum only touches the freelist.
 * Returns the total number of pages reclaimed.
 */
export async function runIncrementalVacuum(
  database: ForemanDatabase,
  pageChunk: number = INCREMENTAL_VACUUM_DEFAULT_CHUNK,
  shouldStop?: () => boolean,
): Promise<number> {
  let reclaimed = 0
  for (;;) {
    const moved = database.pragma(`incremental_vacuum(${pageChunk})`) as unknown[]
    const count = Array.isArray(moved) ? moved.length : 0
    reclaimed += count
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    // Cooperative stop at the yield boundary: a shutdown drain deadline can
    // expire while reclamation is suspended here.
    if (shouldStop?.() === true) break
    if (count < pageChunk) break
  }
  return reclaimed
}
