import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path'
import { ProjectManager } from '../project/manager.mts'
import { isTrustedDocDefinition } from '../../standard/index.mts'
import type { TaskDefinition } from './types.mts'

/**
 * Minimal gate granting workspace-root write authority to the trusted builtin
 * `doc` task. Identity-based: any non-singleton target gets no scope.
 */

const DOC_CATEGORY_DIRECTORIES: Readonly<Record<string, string>> = {
  spec: 'specs',
  plan: 'plans',
  report: 'reports',
  handoff: 'handoff',
}

export interface DocumentExecutionScope {
  workingDirectory: string
  targetPath: string
}

/** Minimal structural view shared by ResolvedTarget and RegisteredTask. */
interface DocScopeTarget {
  definition: TaskDefinition
  source: unknown
}

export function documentExecutionScope(
  target: DocScopeTarget,
  input: unknown,
  workspaceRoot: string,
  project: string,
  worktree?: string,
): DocumentExecutionScope | undefined {
  // Trust is object identity only; a clone/override/same-named definition gets
  // no scope and no privilege.
  if (!isTrustedDocDefinition(target.definition, target.source)) return undefined

  const docInput = (input && typeof input === 'object' ? input : {}) as {
    targetProject?: unknown
    category?: unknown
    targetPath?: unknown
  }
  const requestedProject = typeof docInput.targetProject === 'string' ? docInput.targetProject.trim() : ''
  const category = typeof docInput.category === 'string' ? docInput.category : ''
  const categoryDirectory = DOC_CATEGORY_DIRECTORIES[category]
  const rawTargetPath = typeof docInput.targetPath === 'string' ? docInput.targetPath : ''

  if (worktree?.trim()) return undefined
  const registeredProject = project.trim()
  if (!requestedProject || requestedProject !== registeredProject) return undefined
  if (!categoryDirectory) return undefined
  const registered = new ProjectManager({ workspaceRoot })
    .listProjects()
    .some((entry) => entry.name === registeredProject)
  if (!registered) return undefined

  // Workspace-relative `.md` path strictly inside the project docs category
  // directory, with no absolute/traversal/alternate spellings.
  if (!rawTargetPath || rawTargetPath.includes('\0') || rawTargetPath.includes('\\')) return undefined
  if (isAbsolute(rawTargetPath)) return undefined
  // Workspace-relative paths use forward slashes on every platform; win32 normalize would rewrite them to backslashes.
  const normalized = posix.normalize(rawTargetPath)
  if (normalized !== rawTargetPath) return undefined
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return undefined
  if (!normalized.endsWith('.md')) return undefined

  const prefix = `projects/${registeredProject}/docs/${categoryDirectory}/`
  if (!normalized.startsWith(prefix) || normalized.length <= prefix.length) return undefined

  // Canonicalize the root once; the nearest existing parent must resolve inside
  // it. One bounded containment check — no media machinery.
  const root = canonicalRoot(workspaceRoot)
  const absolute = resolve(root, normalized)
  if (!isInside(root, absolute)) return undefined
  const nearestExisting = nearestExistingParent(absolute)
  if (nearestExisting && !isInside(root, canonicalRoot(nearestExisting))) return undefined

  return { workingDirectory: root, targetPath: absolute }
}

function canonicalRoot(value: string): string {
  try {
    return realpathSync(resolve(value))
  } catch {
    return resolve(value)
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

function nearestExistingParent(absolutePath: string): string | null {
  let current = dirname(absolutePath)
  while (true) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
