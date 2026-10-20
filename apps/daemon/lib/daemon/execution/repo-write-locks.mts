import { resolve } from 'node:path'
import { runGitSync } from '../../core/vcs/index.mts'

export type RepoWriteLockMode = 'edit' | 'yolo'

export interface RepoWriteLock {
  repoPath: string
  holderExecutionId?: string
  holderTaskRunId?: string
  sessionId?: string
  taskName?: string
  mode: RepoWriteLockMode
  /** null means repo-wide; otherwise every entry is one canonical exact file. */
  targetPaths: readonly string[] | null
  acquiredAt: string
}

export type RepoWriteLockAcquireResult =
  | { acquired: true }
  | { acquired: false; holder: RepoWriteLock }

export interface TaskRunWriteLockAcquireMeta {
  sessionId?: string
  taskName: string
  startedAt?: string
}

export interface TaskRunWriteLockConflict {
  taskRunId?: string
  holderExecutionId?: string
  sessionId?: string
  taskName?: string
  startedAt: string
  repoPath: string
  overlappingTargets: readonly string[]
}

export type TaskRunWriteLockAcquireResult =
  | { acquired: true }
  | { acquired: false; holder: TaskRunWriteLockConflict }

/**
 * Maps a working-directory path to the git top-level that owns its write lock
 * namespace. Tests may inject a deterministic mapping.
 */
export type RepoRootResolver = (repoPath: string) => string

export interface RepoWriteLocksOptions {
  repoRootResolver?: RepoRootResolver
}

/** Bound of the resolver cache; a long-lived daemon can see many worktree paths. */
const RESOLVER_CACHE_LIMIT = 512

export function defaultRepoRootResolver(): RepoRootResolver {
  const cache = new Map<string, string>()
  return (repoPath: string): string => {
    const canonical = canonicalPath(repoPath)
    const cached = cache.get(canonical)
    if (cached !== undefined) {
      // Refresh recency so the least recently used key is evicted first.
      cache.delete(canonical)
      cache.set(canonical, cached)
      return cached
    }
    let root = canonical
    const { stdout, code } = runGitSync(canonical, ['rev-parse', '--show-toplevel'])
    if (code === 0) {
      const topLevel = stdout.trim()
      if (topLevel) root = canonicalPath(topLevel)
    }
    // A non-zero exit (not inside a git repo, or git unavailable) falls back to
    // the canonical working directory as the lock namespace.
    cache.set(canonical, root)
    while (cache.size > RESOLVER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return root
  }
}

export class RepoWriteLocks {
  private readonly locksByRepoPath = new Map<string, Map<string, RepoWriteLock>>()
  private readonly lockByExecutionId = new Map<string, RepoWriteLock>()
  private readonly lockByTaskRunId = new Map<string, RepoWriteLock>()
  private readonly releaseListenersByRepo = new Map<string, Set<() => void>>()
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

  tryAcquireTaskRun(
    repoPath: string,
    taskRunId: string,
    targets: readonly string[] | undefined,
    meta: TaskRunWriteLockAcquireMeta,
  ): TaskRunWriteLockAcquireResult {
    if (targets === undefined || targets.length === 0) {
      return { acquired: true }
    }
    if (this.lockByTaskRunId.has(taskRunId)) {
      return { acquired: true }
    }

    const canonicalRepoPath = this.repoRootResolver(repoPath)
    const canonicalTargets = normalizeTaskRunTargets(repoPath, canonicalRepoPath, targets)
    const repoLocks = this.locksByRepoPath.get(canonicalRepoPath)
    if (repoLocks) {
      for (const holder of repoLocks.values()) {
        if (locksConflict(holder.targetPaths, canonicalTargets)) {
          return {
            acquired: false,
            holder: conflictHolderFromLock(holder, canonicalTargets),
          }
        }
      }
    }

    const acquiredAt = meta.startedAt ?? new Date().toISOString()
    const lock: RepoWriteLock = {
      repoPath: canonicalRepoPath,
      holderTaskRunId: taskRunId,
      sessionId: meta.sessionId,
      taskName: meta.taskName,
      mode: 'edit',
      targetPaths: canonicalTargets,
      acquiredAt,
    }
    const holders = repoLocks ?? new Map<string, RepoWriteLock>()
    holders.set(taskRunId, lock)
    this.locksByRepoPath.set(canonicalRepoPath, holders)
    this.lockByTaskRunId.set(taskRunId, lock)
    return { acquired: true }
  }

  findTaskRunConflict(
    repoPath: string,
    targets: readonly string[] | undefined,
  ): TaskRunWriteLockConflict | undefined {
    if (targets === undefined || targets.length === 0) return undefined

    const canonicalRepoPath = this.repoRootResolver(repoPath)
    const canonicalTargets = normalizeTaskRunTargets(repoPath, canonicalRepoPath, targets)
    const repoLocks = this.locksByRepoPath.get(canonicalRepoPath)
    if (!repoLocks) return undefined

    for (const holder of repoLocks.values()) {
      if (locksConflict(holder.targetPaths, canonicalTargets)) {
        return conflictHolderFromLock(holder, canonicalTargets)
      }
    }
    return undefined
  }

  releaseByExecution(executionId: string): void {
    const lock = this.lockByExecutionId.get(executionId)
    if (!lock) return
    this.removeLock(lock, executionId)
  }

  releaseByTaskRun(taskRunId: string): void {
    const lock = this.lockByTaskRunId.get(taskRunId)
    if (!lock) return
    this.removeLock(lock, taskRunId)
  }

  subscribeRelease(repoPath: string, listener: () => void): () => void {
    const canonicalRepoPath = this.repoRootResolver(repoPath)
    let listeners = this.releaseListenersByRepo.get(canonicalRepoPath)
    if (!listeners) {
      listeners = new Set()
      this.releaseListenersByRepo.set(canonicalRepoPath, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.releaseListenersByRepo.get(canonicalRepoPath)
      current?.delete(listener)
      if (current?.size === 0) {
        this.releaseListenersByRepo.delete(canonicalRepoPath)
      }
    }
  }

  /** Alias for {@link subscribeRelease}; listeners receive no target-path details. */
  waitForChange(repoPath: string, listener: () => void): () => void {
    return this.subscribeRelease(repoPath, listener)
  }

  releaseAll(): void {
    const reposToNotify = new Set<string>([
      ...this.locksByRepoPath.keys(),
      ...this.releaseListenersByRepo.keys(),
    ])
    this.lockByExecutionId.clear()
    this.lockByTaskRunId.clear()
    this.locksByRepoPath.clear()
    for (const repoPath of reposToNotify) {
      this.notifyReleaseListeners(repoPath)
    }
  }

  isLocked(repoPath: string): RepoWriteLock | null {
    return this.locksByRepoPath.get(this.repoRootResolver(repoPath))?.values().next().value ?? null
  }

  private removeLock(lock: RepoWriteLock, holderKey: string): void {
    if (lock.holderExecutionId !== undefined) {
      this.lockByExecutionId.delete(lock.holderExecutionId)
    }
    if (lock.holderTaskRunId !== undefined) {
      this.lockByTaskRunId.delete(lock.holderTaskRunId)
    }
    const holders = this.locksByRepoPath.get(lock.repoPath)
    holders?.delete(holderKey)
    if (holders?.size === 0) {
      this.locksByRepoPath.delete(lock.repoPath)
    }
    this.notifyReleaseListeners(lock.repoPath)
  }

  private notifyReleaseListeners(repoPath: string): void {
    const listeners = this.releaseListenersByRepo.get(repoPath)
    if (!listeners || listeners.size === 0) return
    const pending = [...listeners]
    listeners.clear()
    this.releaseListenersByRepo.delete(repoPath)
    for (const listener of pending) {
      try {
        listener()
      } catch {
        // A failing subscriber must not block release or other subscribers.
      }
    }
  }
}

function normalizeTaskRunTargets(
  repoPath: string,
  canonicalRepoPath: string,
  targets: readonly string[],
): readonly string[] | null {
  const canonical = [...new Set(targets.map((target) => canonicalPath(resolve(repoPath, target))))].sort()
  if (canonical.some((target) => target === canonicalRepoPath)) {
    return null
  }
  return canonical
}

function conflictHolderFromLock(
  holder: RepoWriteLock,
  requestedTargets: readonly string[] | null,
): TaskRunWriteLockConflict {
  return {
    taskRunId: holder.holderTaskRunId,
    holderExecutionId: holder.holderExecutionId,
    sessionId: holder.sessionId,
    taskName: holder.taskName,
    startedAt: holder.acquiredAt,
    repoPath: holder.repoPath,
    overlappingTargets: overlappingTargets(holder.targetPaths, requestedTargets),
  }
}

function overlappingTargets(
  left: readonly string[] | null,
  right: readonly string[] | null,
): readonly string[] {
  if (left === null && right === null) return []
  if (left === null) return right ?? []
  if (right === null) return left
  const leftSet = new Set(left)
  return right.filter((target) => leftSet.has(target))
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
