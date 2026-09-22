import { closeDb, initDb } from '../../lib/db/connection.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'

export function initTestDb(): ForemanDatabase {
  closeDb()
  return initDb(':memory:')
}

export function closeTestDb(): void {
  closeDb()
}
