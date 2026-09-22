import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { foremanStateRoot } from '../config/state.mts'
import { bootstrapSchema } from './schema.mts'
import type { ForemanDatabase, RunResult, TransactionCallback } from './types.mts'

let db: ForemanDatabase | undefined
let openedPath: string | undefined

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
  return getDb().prepare<unknown[], T>(sql).all(...params)
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare<unknown[], T>(sql).get(...params)
}

export function run(sql: string, ...params: unknown[]): RunResult {
  return getDb().prepare<unknown[]>(sql).run(...params)
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
  const primary = join(foremanStateRoot(), 'wrenyard.db')
  // A pre-existing legacy ~/.local/state/foreman/foreman.db is read for
  // migration fallback only; new databases are created under the wrenyard
  // state root so schema/history migrations keep working unchanged.
  const legacy = join(legacyForemanStateRoot(), 'foreman.db')
  return existsSync(legacy) && !existsSync(primary) ? legacy : primary
}

function legacyForemanStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim()
  const stateHome = xdgStateHome ? resolve(xdgStateHome) : join(homedir(), '.local', 'state')
  return join(stateHome, 'foreman')
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
