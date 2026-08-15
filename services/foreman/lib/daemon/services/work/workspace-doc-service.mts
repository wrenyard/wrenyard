/**
 * Workspace doc service — daemon-owned filesystem authority for workspace.doc.* methods.
 *
 * Provides typed domain methods for listing, reading, creating, and updating
 * Markdown files under the workspace root with path safety enforcement.
 *
 * Path safety is enforced by allowlisting only Markdown files under specific
 * workspace directories and rejecting symlink escapes, parent traversal,
 * absolute paths, and non-Markdown extensions.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { INVALID_PARAMS, ProtocolError } from '../../../protocol/errors.mts'
import type { WorkspaceDocListResult, WorkspaceDocReadResult, WorkspaceDocCreateResult, WorkspaceDocUpdateResult } from '../../../protocol/methods/workspace-doc.mts'

const MARKDOWN_EXT = '.md'

export class WorkspaceDocService {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    // Canonicalize workspaceRoot to handle symlinks (e.g. macOS /var -> /private/var)
    this.workspaceRoot = realpathSync(resolve(workspaceRoot))
  }

  async list(params: { directory?: string }): Promise<WorkspaceDocListResult> {
    const rawDir = params.directory?.trim() ?? ''
    // Validate optional directory as a safe allowed documentation prefix
    const listDir = rawDir || 'docs'
    if (rawDir) {
      // Reject absolute, parent traversal, and disallowed prefixes
      if (rawDir.startsWith('/') || rawDir.match(/^[A-Za-z]:[/\\]/u)) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Absolute path rejected: ${rawDir}` },
          { service: 'workspace.doc', code: 'absolute_path' },
        )
      }
      const normDir = normalize(rawDir)
      if (normDir.startsWith('..') || normDir.includes(`..${sep}`)) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Parent traversal rejected: ${rawDir}` },
          { service: 'workspace.doc', code: 'parent_traversal' },
        )
      }
      // Must be an allowed documentation root prefix
      if (!isAllowedPrefix(normDir)) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Not an allowed documentation prefix: ${rawDir}` },
          { service: 'workspace.doc', code: 'path_not_allowed' },
        )
      }
    }
    const allowedFiles = this.collectAllowedDocs(listDir)
    return { files: allowedFiles.map((p) => ({ path: p })) } satisfies WorkspaceDocListResult
  }

  async read(params: { path: string }): Promise<WorkspaceDocReadResult> {
    const safePath = this.resolveSafeDocPath(params.path)
    // Verify every existing parent component is within workspace
    this.validatePathInWorkspace(safePath)
    if (!existsSync(safePath)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Document not found: ${params.path}` },
        { service: 'workspace.doc', code: 'not_found' },
      )
    }
    const stat = lstatSync(safePath)
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Path is not a file: ${params.path}` },
        { service: 'workspace.doc', code: 'not_a_file' },
      )
    }
    const resolved = this.resolveSymlink(safePath)
    if (!resolved.startsWith(this.workspaceRoot + sep)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Symlink escape detected: ${params.path}` },
        { service: 'workspace.doc', code: 'symlink_escape' },
      )
    }
    const content = readFileSync(resolved, 'utf-8')
    return { path: params.path, content } satisfies WorkspaceDocReadResult
  }

  async create(params: { path: string; content: string }): Promise<WorkspaceDocCreateResult> {
    const safePath = this.resolveSafeDocPath(params.path)
    if (existsSync(safePath)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Document already exists: ${params.path}` },
        { service: 'workspace.doc', code: 'already_exists' },
      )
    }
    // Verify nearest existing parent is within workspace (resists symlink parent escapes)
    const nearestParent = this.findNearestExistingParent(safePath)
    if (nearestParent) {
      const parentReal = realpathSync(nearestParent)
      if (!parentReal.startsWith(this.workspaceRoot + sep) && parentReal !== this.workspaceRoot) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Parent directory symlink escape detected: ${params.path}` },
          { service: 'workspace.doc', code: 'symlink_escape' },
        )
      }
    }
    // Create directories only after safety check
    mkdirSync(dirname(safePath), { recursive: true })
    writeFileSync(safePath, params.content, { encoding: 'utf-8', flag: 'wx' })
    return { path: params.path } satisfies WorkspaceDocCreateResult
  }

  async update(params: { path: string; content: string }): Promise<WorkspaceDocUpdateResult> {
    const safePath = this.resolveSafeDocPath(params.path)
    // Verify every existing parent component is within workspace
    this.validatePathInWorkspace(safePath)
    if (!existsSync(safePath)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Document not found: ${params.path}` },
        { service: 'workspace.doc', code: 'not_found' },
      )
    }
    const stat = lstatSync(safePath)
    if (!stat.isFile()) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Path is not a regular file: ${params.path}` },
        { service: 'workspace.doc', code: 'not_a_file' },
      )
    }
    // Check symlink escape for existing symlink targets
    const resolved = this.resolveSymlink(safePath)
    if (!resolved.startsWith(this.workspaceRoot + sep)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Symlink escape detected: ${params.path}` },
        { service: 'workspace.doc', code: 'symlink_escape' },
      )
    }
    writeFileSync(safePath, params.content, 'utf-8')
    return { path: params.path } satisfies WorkspaceDocUpdateResult
  }

  /**
   * Validate and resolve a doc path relative to the workspace root.
   * Rejects absolute paths, parent traversal, NUL bytes, non-Markdown extensions,
   * and paths outside allowed roots.
   */
  private resolveSafeDocPath(rawPath: string): string {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'path is required' },
        { service: 'workspace.doc', code: 'path_required' },
      )
    }

    if (rawPath.includes('\0')) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'Invalid path: contains NUL byte' },
        { service: 'workspace.doc', code: 'invalid_path' },
      )
    }

    // Reject absolute paths
    if (rawPath.startsWith('/') || rawPath.match(/^[A-Za-z]:[/\\]/u)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Absolute path rejected: ${rawPath}` },
        { service: 'workspace.doc', code: 'absolute_path' },
      )
    }

    // Normalize and reject parent traversal
    const normalized = normalize(rawPath)
    if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Parent traversal rejected: ${rawPath}` },
        { service: 'workspace.doc', code: 'parent_traversal' },
      )
    }

    // Check allowed root
    if (!isAllowedRoot(rawPath, normalized)) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Path not in allowed documentation directories: ${rawPath}` },
        { service: 'workspace.doc', code: 'path_not_allowed' },
      )
    }

    // Reject non-Markdown extension for specific doc entries (not just root files)
    if (normalized.includes(sep) || normalized.endsWith(MARKDOWN_EXT)) {
      if (!normalized.endsWith(MARKDOWN_EXT) && !isAllowedRootFile(normalized)) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Only .md files are allowed: ${rawPath}` },
          { service: 'workspace.doc', code: 'not_markdown' },
        )
      }
    }

    const resolved = resolve(this.workspaceRoot, normalized)

    // Verify resolved path is within workspace
    if (!resolved.startsWith(this.workspaceRoot + sep) && resolved !== this.workspaceRoot) {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `Path escapes workspace: ${rawPath}` },
        { service: 'workspace.doc', code: 'path_escape' },
      )
    }

    return resolved
  }

  /**
   * Verify that every existing ancestor component of a resolved path stays
   * within the workspace (resists symlink-parent-escape attacks).
   */
  private validatePathInWorkspace(absolutePath: string): void {
    if (absolutePath === this.workspaceRoot) return
    // Walk ancestors from workspaceRoot toward the target
    const ancestors: string[] = []
    let current = absolutePath
    while (current !== this.workspaceRoot) {
      ancestors.push(current)
      current = dirname(current)
    }
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const p = ancestors[i]
      if (!existsSync(p)) continue
      const resolved = realpathSync(p)
      if (!resolved.startsWith(this.workspaceRoot + sep) && resolved !== this.workspaceRoot) {
        throw new ProtocolError(
          { code: INVALID_PARAMS.code, message: `Symlink escape detected through path component: ${p}` },
          { service: 'workspace.doc', code: 'symlink_escape' },
        )
      }
    }
  }

  /** Find the nearest existing ancestor directory of a path. */
  private findNearestExistingParent(absolutePath: string): string | null {
    let current = dirname(absolutePath)
    while (current !== resolve(current, '..')) {
      if (existsSync(current)) return current
      current = dirname(current)
    }
    return null
  }

  private resolveSymlink(path: string): string {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }

  private collectAllowedDocs(directory: string): string[] {
    const results: string[] = []

    if (existsSync(join(this.workspaceRoot, 'AGENTS.md'))) results.push('AGENTS.md')
    if (existsSync(join(this.workspaceRoot, 'FWA.md'))) results.push('FWA.md')
    if (existsSync(join(this.workspaceRoot, 'WORK.md'))) results.push('WORK.md')

    // Walk docs directory
    this.addDocsRecursive(join(this.workspaceRoot, 'docs'), 'docs', results)

    // Walk projects/*/** for docs subdirectories (nested project docs)
    const projectsDir = join(this.workspaceRoot, 'projects')
    if (existsSync(projectsDir)) {
      this.findDocDirsRecursive(projectsDir, 'projects', results)
    }

    // Walk memories directory
    const memoriesDir = join(this.workspaceRoot, 'memories')
    if (existsSync(memoriesDir)) {
      for (const entry of readdirSync(memoriesDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!entry.name.endsWith(MARKDOWN_EXT)) continue
        const safePath = join(memoriesDir, entry.name)
        if (lstatSync(safePath).isSymbolicLink()) continue // Never follow symlink dirs
        results.push(`memories/${entry.name}`)
      }
    }

    // Filter to requested directory prefix
    if (directory && directory !== 'docs') {
      const prefix = normalize(directory) + sep
      return results.filter((p) => (normalize(p) + sep).startsWith(prefix) || normalize(p) === normalize(directory))
    }

    return results.sort()
  }

  /** Recursively find `docs` subdirectories under a project tree. */
  private findDocDirsRecursive(dir: string, prefix: string, results: string[]): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      const relPath = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (lstatSync(fullPath).isSymbolicLink()) continue // Never follow symlink dirs
        if (entry.name === 'docs') {
          this.addDocsRecursive(fullPath, relPath, results)
        } else {
          // Recurse into subdirectories to find nested docs dirs
          this.findDocDirsRecursive(fullPath, relPath, results)
        }
      }
    }
  }

  private addDocsRecursive(dir: string, prefix: string, results: string[]): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      const relPath = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        this.addDocsRecursive(fullPath, relPath, results)
      } else if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXT)) {
        // Check symlink escape
        try {
          const resolved = this.resolveSymlink(fullPath)
          if (!resolved.startsWith(this.workspaceRoot + sep)) continue
        } catch {
          continue
        }
        results.push(relPath)
      }
    }
  }
}

// Module-level helpers (no instance state needed)

function isAllowedRoot(rawPath: string, normalized: string): boolean {
  // Root-level allowed files
  if (isAllowedRootFile(normalized)) return true

  // docs/** or projects/**/docs/** or memories/*.md
  if (normalized.startsWith('docs' + sep)) return true
  // projects/**/docs/** — one or more project path segments before /docs/
  if (normalized.match(/^projects[\\/][^\\/]+(?:[\\/][^\\/]+)*[\\/]docs[\\/]/u)) return true
  if (normalized.match(/^memories[\\/][^\\/]+\.md$/u)) return true

  return false
}

function isAllowedPrefix(normalized: string): boolean {
  if (isAllowedRootFile(normalized)) return true
  if (normalized === 'docs' || normalized.startsWith('docs' + sep)) return true
  // projects and any nested project tree prefix (collectAllowedDocs still filters to docs only)
  if (normalized === 'projects' || normalized.startsWith('projects' + sep)) return true
  if (normalized === 'memories' || normalized.startsWith('memories' + sep)) return true
  return false
}

function isAllowedRootFile(normalized: string): boolean {
  return normalized === 'AGENTS.md' || normalized === 'FWA.md' || normalized === 'WORK.md'
}
