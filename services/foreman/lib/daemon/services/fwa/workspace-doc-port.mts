/**
 * Per-session WorkspaceDocPort factory backed by workspaceRoot, sessionId,
 * and FwaSessionStore. Every operation independently rejects absolute/parent
 * paths and enforces canonical realpath containment within workspaceRoot.
 * Create uses exclusive creation (wx flag) so it never overwrites an existing
 * file or symlink. Delete requires durable store ownership check.
 */

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import type { WorkspaceDocPort } from '../../../core/fwa/types.mts'
import type { FwaSessionStore } from '../../../core/fwa/session-store.mts'

export interface WorkspaceDocPortFactoryOptions {
  workspaceRoot: string
  sessionId: string
  store: FwaSessionStore
}

/**
 * Resolve a relative workspace path to an absolute path under workspaceRoot.
 * Rejects absolute paths and any parent-segment traversal. Returns the
 * lexical resolved path (before realpath).
 */
function resolveUnderRoot(workspaceRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`Workspace path must be relative, got absolute: ${path}`)
  }
  const normalized = normalize(path)
  if (normalized.startsWith('..' + sep) || normalized === '..' || normalized.includes(sep + '..' + sep)) {
    throw new Error(`Workspace path must not traverse above root: ${path}`)
  }

  return resolve(workspaceRoot, normalized)
}

/**
 * For existing targets (read, list, delete): realpath the resolved path and
 * verify canonical containment within workspaceRoot.
 */
function resolveExistingPath(workspaceRoot: string, path: string): string {
  const resolved = resolveUnderRoot(workspaceRoot, path)
  const canonicalRoot = realpathSync(workspaceRoot)
  const canonicalTarget = realpathSync(resolved)
  const rel = relative(canonicalRoot, canonicalTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Workspace path '${path}' resolves outside workspace root via symlink or traversal`)
  }
  return canonicalTarget
}

/**
 * For create operations: walk upward from the resolved path to find the nearest
 * existing ancestor, realpath that ancestor, verify containment, then return the
 * original resolved (unrealpath'd) path so that mkdir and openSync(wx) work for
 * arbitrarily deep new directories.
 */
function resolveCreatePath(workspaceRoot: string, path: string): string {
  const resolved = resolveUnderRoot(workspaceRoot, path)
  const canonicalRoot = realpathSync(workspaceRoot)

  let candidate = resolved
  while (true) {
    try {
      // Stat without following symlinks to detect existing paths
      const stat = lstatSync(candidate)
      // Found an existing path — realpath it for containment check
      const canonicalAncestor = realpathSync(candidate)
      if (stat.isSymbolicLink()) {
        // If the ancestor itself is a symlink, verify its target is contained
        // realpathSync already resolved it, so check containment
      }
      const rel = relative(canonicalRoot, canonicalAncestor)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Workspace path '${path}' would resolve outside workspace root via symlink ancestor`)
      }
      // Ancestor is safely inside workspaceRoot; return the unresolved create target
      return resolved
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('outside root') || error.message.includes('EACCES'))) {
        throw error
      }
      // ENOENT or other — doesn't exist yet, continue walking up
    }
    const parent = resolve(candidate, '..')
    if (parent === candidate) break
    candidate = parent
  }

  // Walked all the way up without finding an existing path; workspaceRoot exists
  return resolved
}

/**
 * For write operations: resolve the path, reject if the final component is a
 * symbolic link, then verify canonical containment (realpath for existing files,
 * realpath parent for new paths).
 */
function resolveWritePath(workspaceRoot: string, path: string): string {
  const resolved = resolveUnderRoot(workspaceRoot, path)

  // Reject if the final path component is a symbolic link
  try {
    const stat = lstatSync(resolved)
    if (stat.isSymbolicLink()) {
      throw new Error(`Cannot write to '${path}': target is a symbolic link`)
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('symbolic link')) {
      throw error
    }
    // ENOENT — path doesn't exist yet, which is fine
  }

  // Verify canonical containment
  const canonicalRoot = realpathSync(workspaceRoot)
  try {
    const canonicalTarget = realpathSync(resolved)
    const rel = relative(canonicalRoot, canonicalTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Workspace path '${path}' resolves outside workspace root via symlink or traversal`)
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error.message.includes('outside root') || error.message.includes('EACCES'))) {
      throw error
    }
    // Path doesn't exist — realpath the parent
    const parentResolved = resolve(resolved, '..')
    const canonicalParent = realpathSync(parentResolved)
    const rel = relative(canonicalRoot, canonicalParent)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Workspace path '${path}' would resolve outside workspace root via symlink parent`)
    }
  }

  return resolved
}

/**
 * For delete operations: resolve the path, reject if the final component is a
 * symbolic link, then verify canonical containment.
 */
function resolveDeletePath(workspaceRoot: string, path: string): string {
  const resolved = resolveUnderRoot(workspaceRoot, path)

  // Reject if the final path component is a symbolic link
  try {
    const stat = lstatSync(resolved)
    if (stat.isSymbolicLink()) {
      throw new Error(`Cannot delete '${path}': target is a symbolic link`)
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('symbolic link')) {
      throw error
    }
    // ENOENT — file doesn't exist; will be caught by unlink below
  }

  // Verify canonical containment
  const canonicalRoot = realpathSync(workspaceRoot)
  try {
    const canonicalTarget = realpathSync(resolved)
    const rel = relative(canonicalRoot, canonicalTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Workspace path '${path}' resolves outside workspace root via symlink or traversal`)
    }
    return canonicalTarget
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('outside root')) {
      throw error
    }
    throw new Error(`Workspace path '${path}' does not exist`)
  }
}

/**
 * Create a per-session WorkspaceDocPort that enforces containment and
 * authorization at every operation boundary.
 */
export function createWorkspaceDocPort(options: WorkspaceDocPortFactoryOptions): WorkspaceDocPort {
  const { workspaceRoot, sessionId, store } = options

  return {
    read: async (path: string): Promise<{ content: string } | null> => {
      const canonicalPath = resolveExistingPath(workspaceRoot, path)
      try {
        const content = readFileSync(canonicalPath, 'utf-8')
        return { content }
      } catch {
        return null
      }
    },

    write: async (path: string, content: string): Promise<void> => {
      const resolvedPath = resolveWritePath(workspaceRoot, path)
      mkdirSync(resolve(resolvedPath, '..'), { recursive: true })
      writeFileSync(resolvedPath, content, 'utf-8')
    },

    create: async (path: string, content: string): Promise<{ session_id: string }> => {
      const resolvedPath = resolveCreatePath(workspaceRoot, path)
      mkdirSync(resolve(resolvedPath, '..'), { recursive: true })
      // Use exclusive creation flag (wx) — never overwrites existing file or symlink
      const fd = openSync(resolvedPath, 'wx')
      try {
        writeFileSync(fd, content, 'utf-8')
      } finally {
        closeSync(fd)
      }
      // Record durable ownership only after successful exclusive creation
      // Roll back the new file if ownership persistence fails
      try {
        store.recordDocOwnership(sessionId, path)
      } catch {
        try { unlinkSync(resolvedPath) } catch { /* ignore */ }
        throw new Error('Failed to persist document ownership; creation rolled back')
      }
      return { session_id: sessionId }
    },

    list: async (dir: string): Promise<string[]> => {
      const canonicalPath = resolveExistingPath(workspaceRoot, dir)
      try {
        const entries = readdirSync(canonicalPath)
        return entries
      } catch {
        return []
      }
    },

    delete: async (path: string): Promise<boolean> => {
      // Step 1: Lexical path validation before ownership check
      resolveUnderRoot(workspaceRoot, path)
      // Step 2: Require durable ownership check
      if (!store.isDocOwnedBySession(sessionId, path)) {
        throw new Error(`Cannot delete '${path}': document was not created by this session`)
      }
      // Step 3: Full realpath containment and symlink rejection
      const canonicalPath = resolveDeletePath(workspaceRoot, path)
      try {
        unlinkSync(canonicalPath)
        // Remove ownership only after success
        store.removeDocOwnership(sessionId, path)
        return true
      } catch {
        return false
      }
    },
  }
}
