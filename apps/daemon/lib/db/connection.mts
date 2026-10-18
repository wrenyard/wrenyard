import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { foremanStateRoot } from '../config/state.mts'
import { bootstrapSchema } from './schema.mts'
import type { ForemanDatabase, RunResult, TransactionCallback } from './types.mts'

let db: ForemanDatabase | undefined
let openedPath: string | undefined

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

  const nextDb = new Database(nextPath)

  try {
    ensureDbFileMode(nextPath)
    applyPragmas(nextDb)
    bootstrapSchema(nextDb)
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

export function query<T>(sql: string, ...params: unknown[]): T[] {
  const startedAt = performance.now()
  const rows = getDb().prepare<unknown[], T>(sql).all(...params)
  reportSlowQuery('query', sql, performance.now() - startedAt)
  return rows
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  const startedAt = performance.now()
  const row = getDb().prepare<unknown[], T>(sql).get(...params)
  reportSlowQuery('get', sql, performance.now() - startedAt)
  return row
}

export function run(sql: string, ...params: unknown[]): RunResult {
  const startedAt = performance.now()
  const result = getDb().prepare<unknown[]>(sql).run(...params)
  reportSlowQuery('run', sql, performance.now() - startedAt)
  return result
}

export function closeDb(): void {
  if (db?.open) db.close()
  db = undefined
  openedPath = undefined
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

function applyPragmas(database: ForemanDatabase): void {
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
}
