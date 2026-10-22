import { resolve } from 'node:path'
import { get as dbGet } from '../../db/connection.mts'

export interface TaskWriteTargetRegistration {
  taskId: string
  checkoutPath: string
  targets: readonly string[]
}

export interface TaskWriteConflict {
  runId: string
  taskId: string
  targets: readonly string[]
  overlap: readonly string[]
  /** ISO timestamp the holder run's first execution actually launched. */
  startedAt?: string
  /** ISO timestamp of the holder run's latest recorded event, when any exist. */
  lastActivityAt?: string
  /** ISO timestamp the holder run's effective run time limit ends at
   *  (startedAt + its persisted execution timeout), when both are known. */
  timeLimitEndsAt?: string
}

const registrations = new Map<string, TaskWriteTargetRegistration>()

export function registerTaskWriteTargets(
  runId: string,
  entry: { taskId: string; checkoutPath: string; targets: readonly string[] },
): void {
  const checkoutPath = canonicalPath(entry.checkoutPath)
  const targets = [...new Set(entry.targets.map(canonicalPath))]
  registrations.set(runId, { taskId: entry.taskId, checkoutPath, targets })
}

export function releaseTaskWriteTargets(runId: string): void {
  registrations.delete(runId)
}

export function findTaskWriteConflict(params: {
  checkoutPath: string
  targets: readonly string[]
}): TaskWriteConflict | null {
  const checkoutPath = canonicalPath(params.checkoutPath)
  const candidates = [...new Set(params.targets.map(canonicalPath))]
  for (const [runId, entry] of registrations) {
    if (entry.checkoutPath !== checkoutPath) continue
    const overlap = new Set<string>()
    for (const left of candidates) {
      for (const right of entry.targets) {
        if (pathsOverlap(left, right)) overlap.add(left)
      }
    }
    if (overlap.size > 0) {
      return {
        runId,
        taskId: entry.taskId,
        targets: entry.targets,
        overlap: [...overlap],
        ...holderRunTimingFacts(runId),
      }
    }
  }
  return null
}

interface HolderRunTimingRow {
  started_at: string | null
  execution_id: string | null
  timeout_ms: number | null
}

/**
 * Read-only timing facts of the conflicting run, derived from rows the daemon
 * already records: `tasks.started_at`, the linked execution's `timeout_ms`
 * (the effective run time limit in ms), and the latest `events.timestamp`
 * recorded for the run. Every fact is omitted when its source row is absent;
 * nothing is fabricated.
 */
function holderRunTimingFacts(runId: string): Pick<
  TaskWriteConflict,
  'startedAt' | 'lastActivityAt' | 'timeLimitEndsAt'
> {
  let row: HolderRunTimingRow | undefined
  try {
    row = dbGet<HolderRunTimingRow>(
      `SELECT t.started_at, t.execution_id, e.timeout_ms
      FROM tasks t
      LEFT JOIN executions e ON e.id = t.execution_id
      WHERE t.id = ?`,
      runId,
    )
  } catch {
    return {}
  }
  if (!row) return {}

  const facts: Pick<TaskWriteConflict, 'startedAt' | 'lastActivityAt' | 'timeLimitEndsAt'> = {}
  const startedMs = Date.parse(row.started_at ?? '')
  if (Number.isFinite(startedMs) && row.started_at) facts.startedAt = row.started_at

  try {
    const activity = dbGet<{ last: string | null }>(
      `SELECT MAX(timestamp) AS last
      FROM events
      WHERE task_id = ? OR (execution_id IS NOT NULL AND execution_id = ?)`,
      runId,
      row.execution_id,
    )
    if (activity?.last) facts.lastActivityAt = activity.last
  } catch {
    // A failed read contributes no last-activity fact.
  }

  if (Number.isFinite(startedMs) && row.timeout_ms !== null && row.timeout_ms > 0) {
    facts.timeLimitEndsAt = new Date(startedMs + row.timeout_ms).toISOString()
  }
  return facts
}

function pathsOverlap(left: string, right: string): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  if (a === b) return true
  const sep = process.platform === 'win32' ? '\\' : '/'
  const aUnderB = a.startsWith(`${b}${sep}`)
  const bUnderA = b.startsWith(`${a}${sep}`)
  return aUnderB || bUnderA
}

function canonicalPath(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
