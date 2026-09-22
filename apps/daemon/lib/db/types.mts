import type Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

export type ForemanDatabase = DatabaseType
export type RunResult = Database.RunResult
export type TransactionCallback<T> = (db: ForemanDatabase) => T
