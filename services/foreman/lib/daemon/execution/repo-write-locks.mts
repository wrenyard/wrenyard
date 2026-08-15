import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { AgentRuntimePermission } from '../../core/operations/types.mts'

export type RepoWriteLockMode = 'edit' | 'yolo'

export interface RepoWriteLock {
  repoPath: string
  holderExecutionId: string
  mode: RepoWriteLockMode
  /** null means repo-wide; otherwise every entry is one canonical exact file. */
  targetPaths: readonly string[] | null
  acquiredAt: string
}

export type RepoWriteLockAcquireResult =
  | { acquired: true }
  | { acquired: false; holder: RepoWriteLock }

/**
 * Maps a working-directory path to the git top-level that owns its write lock
 * namespace. Tests may inject a deterministic mapping.
 */
export type RepoRootResolver = (repoPath: string) => string

export interface RepoWriteLocksOptions {
  repoRootResolver?: RepoRootResolver
}

export function defaultRepoRootResolver(): RepoRootResolver {
  const cache = new Map<string, string>()
  return (repoPath: string): string => {
    const canonical = canonicalPath(repoPath)
    const cached = cache.get(canonical)
    if (cached) return cached
    let root = canonical
    try {
      const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: canonical,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      }).trim()
      if (topLevel) root = canonicalPath(topLevel)
    } catch {
      // Not inside a git repo or git is unavailable: fall back to the canonical
      // working directory as the lock namespace.
    }
    cache.set(canonical, root)
    return root
  }
}

export class RepoWriteLocks {
  private readonly locksByRepoPath = new Map<string, Map<string, RepoWriteLock>>()
  private readonly lockByExecutionId = new Map<string, RepoWriteLock>()
  private readonly repoRootResolver: RepoRootResolver

  constructor(options: RepoWriteLocksOptions = {}) {
    this.repoRootResolver = options.repoRootResolver ?? defaultRepoRootResolver()
  }

  tryAcquire(
    repoPath: string,
    executionId: string,
    mode: RepoWriteLockMode,
    targetPaths?: readonly string[],
  ): RepoWriteLockAcquireResult {
    if (this.lockByExecutionId.has(executionId)) return { acquired: true }
    const canonicalRepoPath = this.repoRootResolver(repoPath)
    const canonicalTargets = mode === 'edit' && targetPaths && targetPaths.length > 0
      ? [...new Set(targetPaths.map(canonicalPath))].sort()
      : null
    const repoLocks = this.locksByRepoPath.get(canonicalRepoPath)
    if (repoLocks) {
      for (const holder of repoLocks.values()) {
        if (locksConflict(holder.targetPaths, canonicalTargets)) {
          return { acquired: false, holder }
        }
      }
    }

    const lock: RepoWriteLock = {
      repoPath: canonicalRepoPath,
      holderExecutionId: executionId,
      mode,
      targetPaths: canonicalTargets,
      acquiredAt: new Date().toISOString(),
    }
    const holders = repoLocks ?? new Map<string, RepoWriteLock>()
    holders.set(executionId, lock)
    this.locksByRepoPath.set(canonicalRepoPath, holders)
    this.lockByExecutionId.set(executionId, lock)
    return { acquired: true }
  }

  releaseByExecution(executionId: string): void {
    const lock = this.lockByExecutionId.get(executionId)
    if (!lock) return
    this.lockByExecutionId.delete(executionId)
    const holders = this.locksByRepoPath.get(lock.repoPath)
    holders?.delete(executionId)
    if (holders?.size === 0) this.locksByRepoPath.delete(lock.repoPath)
  }

  releaseAll(): void {
    this.lockByExecutionId.clear()
    this.locksByRepoPath.clear()
  }

  isLocked(repoPath: string): RepoWriteLock | null {
    return this.locksByRepoPath.get(this.repoRootResolver(repoPath))?.values().next().value ?? null
  }
}

function locksConflict(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return true
  const leftSet = new Set(left)
  return right.some((target) => leftSet.has(target))
}

function canonicalPath(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function requiresRepoWriteLock(permission: AgentRuntimePermission): permission is RepoWriteLockMode {
  return permission === 'edit' || permission === 'yolo'
}
