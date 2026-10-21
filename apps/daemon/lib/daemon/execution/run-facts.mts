import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { foremanStateRoot } from '../../config/state.mts'
import { runGit } from '../../core/vcs/git.mts'
import { get as dbGet } from '../../db/connection.mts'

interface RunBaseline {
  head: string
  cwd: string
}

const baselines = new Map<string, RunBaseline>()

export async function captureRunBaseline(taskRunId: string, cwd: string): Promise<RunBaseline | null> {
  try {
    const result = await runGit(cwd, ['rev-parse', 'HEAD'])
    if (result.code !== 0) return null
    const head = result.stdout.trim()
    if (!head) return null
    const baseline = { head, cwd }
    baselines.set(taskRunId, baseline)
    return baseline
  } catch {
    return null
  }
}

function takeRunBaseline(taskRunId: string): RunBaseline | undefined {
  const baseline = baselines.get(taskRunId)
  if (baseline) baselines.delete(taskRunId)
  return baseline
}

export interface CollectRunFactsInput {
  taskRunId: string
  status: string
  failureCategory?: string | null
  startedAt?: string | null
  endedAt?: string | null
  timedOut: boolean
  checkoutPath?: string | null
  worktreeId?: string | null
}

export interface CollectedRunFacts {
  status: string
  failure_category?: string
  duration_ms: number | null
  timed_out: boolean
  checkout_path?: string
  worktree_id?: string
  changed_files: string[]
  commits: Array<{ sha: string; subject: string }>
  artifact_files: Array<{ path: string; bytes: number }>
}

export interface TaskRowFactsContext {
  startedAt?: string | null
  worktree?: string | null
  executionStatus?: string | null
  killReason?: string | null
}

function durationMs(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
}

function uniqueSortedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const path of paths) {
    const trimmed = path.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen].sort()
}

function pathsFromPorcelain(output: string): string[] {
  const paths: string[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const payload = line.length >= 4 ? line.slice(3).trim() : line.trim()
    if (!payload) continue
    const renameSep = ' -> '
    if (payload.includes(renameSep)) {
      paths.push(payload.split(renameSep).pop()!.trim())
    } else {
      paths.push(payload)
    }
  }
  return paths
}

async function collectChangedFilesWithBaseline(cwd: string, head: string): Promise<string[]> {
  const lines: string[] = []
  try {
    const diffResult = await runGit(cwd, ['diff', '--name-only', head])
    if (diffResult.code === 0) {
      lines.push(...diffResult.stdout.split('\n'))
    }
  } catch {
    // diff failure contributes no paths
  }
  try {
    const untrackedResult = await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])
    if (untrackedResult.code === 0) {
      lines.push(...untrackedResult.stdout.split('\n'))
    }
  } catch {
    // untracked listing failure contributes no paths
  }
  return uniqueSortedPaths(lines)
}

async function collectCommitsWithBaseline(cwd: string, head: string): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const result = await runGit(cwd, ['log', '--format=%H%x1f%s', `${head}..HEAD`])
    if (result.code !== 0) return []
    const commits: Array<{ sha: string; subject: string }> = []
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      const sep = line.indexOf('\x1f')
      if (sep <= 0) continue
      commits.push({ sha: line.slice(0, sep), subject: line.slice(sep + 1) })
    }
    return commits
  } catch {
    return []
  }
}

async function collectChangedFilesWithoutBaseline(cwd: string): Promise<string[]> {
  try {
    const result = await runGit(cwd, ['status', '--porcelain'])
    if (result.code !== 0) return []
    return uniqueSortedPaths(pathsFromPorcelain(result.stdout))
  } catch {
    return []
  }
}

async function listArtifactFiles(taskRunId: string): Promise<Array<{ path: string; bytes: number }>> {
  const id = taskRunId.trim()
  if (!id || id === '.' || id === '..' || /[\0/\\]/u.test(id)) return []
  const directory = join(resolve(foremanStateRoot()), 'artifacts', id)
  try {
    const names = await readdir(directory)
    const files: Array<{ path: string; bytes: number }> = []
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const fullPath = join(directory, name)
      try {
        const info = await stat(fullPath)
        if (!info.isFile()) continue
        files.push({ path: name, bytes: info.size })
      } catch {
        // skip unreadable entries
      }
    }
    return files
  } catch {
    return []
  }
}

export async function collectRunFacts(input: CollectRunFactsInput): Promise<CollectedRunFacts> {
  const facts: CollectedRunFacts = {
    status: input.status,
    duration_ms: durationMs(input.startedAt, input.endedAt),
    timed_out: input.timedOut,
    changed_files: [],
    commits: [],
    artifact_files: [],
  }
  if (input.failureCategory) facts.failure_category = input.failureCategory
  if (input.checkoutPath) facts.checkout_path = input.checkoutPath
  if (input.worktreeId) facts.worktree_id = input.worktreeId

  try {
    const baseline = takeRunBaseline(input.taskRunId)
    const cwd = input.checkoutPath ?? baseline?.cwd ?? null
    if (cwd) {
      try {
        if (baseline) {
          facts.changed_files = await collectChangedFilesWithBaseline(cwd, baseline.head)
          facts.commits = await collectCommitsWithBaseline(cwd, baseline.head)
        } else {
          facts.changed_files = await collectChangedFilesWithoutBaseline(cwd)
        }
      } catch {
        // per-step fallback: keep empty lists
      }
    }
    try {
      facts.artifact_files = await listArtifactFiles(input.taskRunId)
    } catch {
      // per-step fallback
    }
  } catch {
    // whole-function fallback: return the partial facts object
  }

  return facts
}

export async function collectTerminalRunFactsJson(input: CollectRunFactsInput): Promise<string | null> {
  try {
    const facts = await collectRunFacts(input)
    return JSON.stringify(facts)
  } catch {
    return null
  }
}

export function readTaskRowFactsContext(taskRunId: string): TaskRowFactsContext {
  try {
    const row = dbGet<{
      started_at: string | null
      worktree: string | null
      execution_status: string | null
      kill_reason: string | null
    }>(
      `SELECT
        t.started_at, t.worktree,
        e.status AS execution_status, e.kill_reason
      FROM tasks t
      LEFT JOIN executions e ON e.id = t.execution_id
      WHERE t.id = ?`,
      taskRunId,
    )
    if (!row) return {}
    return {
      startedAt: row.started_at,
      worktree: row.worktree,
      executionStatus: row.execution_status,
      killReason: row.kill_reason,
    }
  } catch {
    return {}
  }
}

export function isTaskRunTimedOut(ctx: TaskRowFactsContext, taskStatus?: string): boolean {
  return ctx.executionStatus === 'timeout'
    || ctx.killReason === 'timeout'
    || taskStatus === 'timeout'
}

export function minimalRunFactsJson(params: {
  status: string
  worktreeId?: string | null
}): string {
  return JSON.stringify({
    status: params.status,
    timed_out: false,
    ...(params.worktreeId ? { worktree_id: params.worktreeId } : {}),
    duration_ms: null,
    changed_files: [],
    commits: [],
    artifact_files: [],
  })
}

export function minimalRunFactsForTaskRun(taskRunId: string, status: string): string {
  try {
    const row = dbGet<{ worktree: string | null }>(
      'SELECT worktree FROM tasks WHERE id = ?',
      taskRunId,
    )
    return minimalRunFactsJson({ status, worktreeId: row?.worktree ?? null })
  } catch {
    return minimalRunFactsJson({ status })
  }
}
