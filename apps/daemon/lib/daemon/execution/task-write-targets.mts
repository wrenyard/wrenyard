import { resolve } from 'node:path'

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
      }
    }
  }
  return null
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
