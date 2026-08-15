import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { FmprojConfig, ProjectNode } from './types.mts'

export type { FmprojConfig, ProjectNode } from './types.mts'

type UnknownRecord = Record<string, unknown>

const FMPROJ_EXT = '.fmproj'
const FLAT_NAME_RE = /^[A-Za-z0-9._-]+$/u
const ROOT_SCOPE = '__root__'
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'coverage'])
const ORDINAL_RE = /-\d+$/u
const warnedAmbiguousCanonicalHosts = new Set<string>()

export function canonicalize(hostname: string): string {
  let s = hostname.trim().toLowerCase()
  if (s.endsWith('.local')) s = s.slice(0, -'.local'.length)
  if (ORDINAL_RE.test(s)) s = s.slice(0, s.lastIndexOf('-'))
  return s
}

export function resolveHostPath(hosts: Record<string, string> | undefined, hostname: string): string | null {
  if (!hosts) return null
  const key = hostname.trim()
  if (!key) return null

  // Exact match always wins
  const exact = hosts[key]
  if (exact !== undefined) return exact

  // Canonical fallback
  const canonicalHost = canonicalize(key)
  let bestKey: string | null = null
  let bestIsOrdinal = false
  let ambiguousKeys: string[] = []

  for (const hostKey of Object.keys(hosts)) {
    if (canonicalize(hostKey) !== canonicalHost) continue

    const isOrdinal = (() => {
      const lowered = hostKey.toLowerCase()
      const noDomain = lowered.endsWith('.local') ? lowered.slice(0, -'.local'.length) : lowered
      return ORDINAL_RE.test(noDomain)
    })()

    if (bestKey === null) {
      bestKey = hostKey
      bestIsOrdinal = isOrdinal
      continue
    }

    // Prefer suffix-less (non-ordinal) key
    if (!isOrdinal && bestIsOrdinal) {
      ambiguousKeys.push(bestKey)
      bestKey = hostKey
      bestIsOrdinal = false
    } else {
      ambiguousKeys.push(hostKey)
    }
  }

  if (ambiguousKeys.length > 0) {
    const matchingKeys = [bestKey!, ...ambiguousKeys]
    const matchingPaths = new Set(matchingKeys.map((hostKey) => hosts[hostKey]))

    if (matchingPaths.size > 1 && !warnedAmbiguousCanonicalHosts.has(canonicalHost)) {
      warnedAmbiguousCanonicalHosts.add(canonicalHost)
      console.warn(
        `[foreman] ambiguous hostname canonical match for '${key}': ` +
        `keys [${matchingKeys.join(', ')}] all resolve to '${canonicalHost}'. Using '${bestKey}'.`,
      )
    }
  }

  return bestKey !== null ? hosts[bestKey] : null
}

let cachedWorkspaceRoot: string | null = null
let cachedProjects = new Map<string, ProjectNode>()

export function discoverProjects(workspaceRoot: string): Map<string, ProjectNode> {
  const root = resolve(workspaceRoot)
  if (cachedWorkspaceRoot === root) return cachedProjects

  const projects = new Map<string, ProjectNode>()
  const siblingNames = new Map<string, Set<string>>()
  const projectsDir = join(root, 'projects')

  if (existsSync(projectsDir)) {
    scanDirectory(projectsDir, null, root, projects, siblingNames)
  }

  cachedWorkspaceRoot = root
  cachedProjects = projects
  return projects
}

export function invalidateProjectCache(): void {
  cachedWorkspaceRoot = null
  cachedProjects = new Map()
}

export function findProject(projectId: string): ProjectNode | null {
  const key = projectId.trim()
  if (!key) return null
  return cachedProjects.get(key) ?? null
}

export function resolveProjectPath(projectId: string, hostname: string): string | null {
  const project = findProject(projectId)
  if (!project) return null

  return resolveHostPath(project.config.hosts, hostname)
}

export function getAncestorChain(project: ProjectNode): ProjectNode[] {
  const chain: ProjectNode[] = []
  let current: ProjectNode | null = project

  while (current) {
    chain.unshift(current)
    current = current.parent
  }

  return chain
}

function scanDirectory(
  dir: string,
  parent: ProjectNode | null,
  workspaceRoot: string,
  projects: Map<string, ProjectNode>,
  siblingNames: Map<string, Set<string>>,
): void {
  if (!existsSync(dir)) return

  const entries = readdirSync(dir, { withFileTypes: true })
  const projectsInCurrentDir: ProjectNode[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(FMPROJ_EXT)) continue

    const filePath = join(dir, entry.name)
    const project = loadProjectFromFile(
      filePath,
      parent,
      workspaceRoot,
      projects,
      siblingNames,
    )
    if (project) projectsInCurrentDir.push(project)
  }

  const projectsByName = new Map(projectsInCurrentDir.map((project) => [project.flatName, project]))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIRS.has(entry.name)) continue
    const implicitParent = projectsInCurrentDir.length === 1 ? projectsInCurrentDir[0] : parent
    const childParent = projectsByName.get(entry.name) ?? implicitParent
    scanDirectory(
      join(dir, entry.name),
      childParent,
      workspaceRoot,
      projects,
      siblingNames,
    )
  }
}

function loadProjectFromFile(
  filePath: string,
  parent: ProjectNode | null,
  workspaceRoot: string,
  projects: Map<string, ProjectNode>,
  siblingNames: Map<string, Set<string>>,
): ProjectNode | null {
  if (!existsSync(filePath)) return null

  const fileName = filePath.replace(/^.*[\\/]/u, '')
  if (!fileName.endsWith(FMPROJ_EXT)) return null
  const expectedName = fileName.slice(0, -FMPROJ_EXT.length)

  let raw: unknown
  try {
    raw = parseYaml(readFileSync(filePath, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${(error as Error).message}`)
  }
  if (!isRecord(raw)) {
    console.error(`Skipping invalid project ${fileName} (YAML must be an object)`)
    return null
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''

  if (!name) {
    console.error(`Skipping invalid project ${fileName} (missing name)`)
    return null
  }
  if (!description) {
    console.error(`Skipping invalid project ${fileName} (missing description)`)
    return null
  }
  if (!FLAT_NAME_RE.test(name)) {
    throw new Error(`Invalid project name '${name}' in ${fileName}`)
  }
  if (name !== expectedName) {
    console.error(`Project name '${name}' does not match filename '${expectedName}' in ${fileName}`)
    return null
  }

  const parentScope = parent ? parent.id : ROOT_SCOPE
  const siblings = siblingNames.get(parentScope) ?? new Set<string>()
  if (siblings.has(name)) {
    throw new Error(`Duplicate project name '${name}' under the same parent`)
  }
  siblings.add(name)
  siblingNames.set(parentScope, siblings)

  const projectId = buildProjectId(filePath, workspaceRoot)
  const config: FmprojConfig = {
    name,
    description,
    git: parseGit(raw.git),
    hosts: parseHosts(raw.hosts),
  }
  if (!config.hosts) delete config.hosts
  if (!config.git) delete config.git

  const existing = projects.get(projectId)
  if (existing) {
    throw new Error(`Duplicate project '${projectId}' found in ${fileName}`)
  }

  const project: ProjectNode = {
    id: projectId,
    flatName: name,
    dirPath: dirname(filePath),
    config,
    parent,
    children: [],
  }

  projects.set(projectId, project)
  if (parent) parent.children.push(project)
  return project
}

function buildProjectId(filePath: string, workspaceRoot: string): string {
  const fileName = filePath.replace(/^.*[\\/]/u, '')
  const projectName = fileName.slice(0, -FMPROJ_EXT.length)
  const projectsRoot = join(workspaceRoot, 'projects')
  const projectDir = dirname(filePath)
  const relativePath = relative(projectsRoot, projectDir)
  const normalized = relativePath === '.' ? '' : relativePath.replace(/\\/gu, '/')
  if (!normalized) return projectName
  return normalized.endsWith(`/${projectName}`) || normalized === projectName
    ? normalized
    : `${normalized}/${projectName}`
}

function parseGit(raw: unknown): { remote: string; default_branch?: string } | undefined {
  if (!isRecord(raw)) return undefined

  const remote = typeof raw.remote === 'string' ? raw.remote.trim() : ''
  const defaultBranch = typeof raw.default_branch === 'string' ? raw.default_branch.trim() : ''
  if (!remote) return undefined
  return {
    remote,
    ...(defaultBranch ? { default_branch: defaultBranch } : {}),
  }
}

function parseHosts(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const hosts: Record<string, string> = {}
  let hasHost = false

  for (const [hostname, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const key = hostname.trim()
    const hostPath = value.trim()
    if (!key || !hostPath) continue
    hosts[key] = hostPath
    hasHost = true
  }

  return hasHost ? hosts : undefined
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
