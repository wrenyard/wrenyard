import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * Startup-only migration: converts a legacy database whose auto_vacuum mode is
 * NONE (0) to INCREMENTAL by running `PRAGMA auto_vacuum = INCREMENTAL` followed
 * by a full `VACUUM`. A full VACUUM rewrites the entire database and can take
 * minutes on a large file, so it runs on a dedicated worker-thread connection
 * — never synchronously on the daemon main thread — and must complete before
 * IPC begins serving.
 *
 * `ensureIncrementalAutoVacuum` is idempotent: it no-ops when the file is
 * missing or already INCREMENTAL. Errors are surfaced to the caller, which
 * should log and continue — a failed conversion must not prevent startup.
 */

const require_ = createRequire(import.meta.url)
// The worker opens better-sqlite3 through the same resolution chain as this
// module so the packaged daemon and workspace installs behave identically.
const BETTER_SQLITE3_PATH = require_.resolve('better-sqlite3')

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads')
try {
  const Database = require(workerData.betterSqlite3Path)
  const db = new Database(workerData.dbPath)
  const mode = db.pragma('auto_vacuum', { simple: true })
  if (mode === 0) {
    db.pragma('auto_vacuum = INCREMENTAL')
    db.prepare('VACUUM').run()
  }
  const finalMode = db.pragma('auto_vacuum', { simple: true })
  db.close()
  parentPort.postMessage({ ok: true, converted: mode === 0, mode: finalMode })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
`

export interface AutoVacuumConvertResult {
  /** True when a NONE database was converted to INCREMENTAL. */
  converted: boolean
  /** The auto_vacuum mode after the check (0 = NONE, 2 = INCREMENTAL). */
  mode: number
}

/**
 * Detect `PRAGMA auto_vacuum` on the target database and, when it is NONE,
 * convert it to INCREMENTAL off the main thread. Safe to await in daemon
 * bootstrap. No-ops for `:memory:`, non-absolute and missing paths.
 */
export function ensureIncrementalAutoVacuum(dbPath: string): Promise<AutoVacuumConvertResult> {
  return new Promise((resolvePromise, reject) => {
    if (dbPath === ':memory:' || !isAbsolute(dbPath) || !existsSync(resolve(dbPath))) {
      resolvePromise({ converted: false, mode: -1 })
      return
    }
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath: resolve(dbPath), betterSqlite3Path: BETTER_SQLITE3_PATH },
    })
    worker.once('message', (message: { ok: boolean; converted?: boolean; mode?: number; error?: string }) => {
      if (message.ok) {
        resolvePromise({ converted: message.converted === true, mode: message.mode ?? -1 })
      } else {
        reject(new Error(message.error ?? 'auto-vacuum conversion failed'))
      }
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`auto-vacuum conversion worker exited with code ${code}`))
    })
  })
}
