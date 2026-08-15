import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  canonicalize,
  discoverProjects,
  getAncestorChain,
  invalidateProjectCache,
  resolveHostPath,
  resolveProjectPath,
} from '../lib/core/project/loader.mts'

let oldWorkspace: string | undefined
let workspaceRoots: string[] = []

beforeEach(() => {
  oldWorkspace = process.env.FOREMAN_WORKSPACE
  delete process.env.FOREMAN_WORKSPACE
  workspaceRoots = []
})

afterEach(() => {
  if (oldWorkspace === undefined) {
    delete process.env.FOREMAN_WORKSPACE
  } else {
    process.env.FOREMAN_WORKSPACE = oldWorkspace
  }

  for (const workspaceRoot of workspaceRoots) {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
  workspaceRoots = []
  invalidateProjectCache()
})

function createWorkspaceWithProjectsDir(): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'foreman-projects-'))
  const projectsDir = join(workspaceDir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  process.env.FOREMAN_WORKSPACE = workspaceDir
  workspaceRoots.push(workspaceDir)
  return workspaceDir
}

function writeFmproj(dir: string, name: string, config: Record<string, unknown>): string {
  const filePath = join(dir, `${name}.fmproj`)
  const lines = [
    `name: ${config.name}`,
    `description: "${config.description || 'test'}"`,
  ]

  if (config.git) {
    const git = config.git as Record<string, string>
    lines.push('git:', `  remote: ${git.remote}`, `  default_branch: ${git.default_branch}`)
  }

  if (config.hosts) {
    lines.push('hosts:')
    for (const [k, v] of Object.entries(config.hosts as Record<string, string>)) {
      lines.push(`  ${k}: "${v}"`)
    }
  }

  writeFileSync(filePath, lines.join('\n'), 'utf-8')
  return filePath
}

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }

  try {
    run()
  } finally {
    console.warn = originalWarn
  }

  return warnings
}

test('discoverProjects loads flat projects from the projects directory', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const projectsDir = join(workspaceDir, 'projects')
  writeFmproj(projectsDir, 'forge', { name: 'forge', description: 'Forge root' })

  const projects = discoverProjects(workspaceDir)
  const project = projects.get('forge')

  assert.equal(projects.has('forge'), true)
  assert.equal(project?.flatName, 'forge')
  assert.equal(project?.parent, null)
})

test('discoverProjects does not register an implicit workspace project', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()

  const projects = discoverProjects(workspaceDir)

  assert.equal(projects.has('workspace'), false)
})

test('discoverProjects builds parent/children links for nested project trees', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const ureDir = join(workspaceDir, 'projects', 'ure')
  const siteDir = join(ureDir, 'site')
  mkdirSync(siteDir, { recursive: true })
  writeFmproj(ureDir, 'ure', { name: 'ure', description: 'Ure root' })
  writeFmproj(siteDir, 'site', { name: 'site', description: 'Site child' })

  const projects = discoverProjects(workspaceDir)
  const nestedProject = projects.get('ure/site')

  assert.ok(nestedProject)
  assert.equal(nestedProject?.id, 'ure/site')
  assert.equal(nestedProject?.parent?.id, 'ure')
  assert.equal(projects.get('ure')?.children.some((child) => child.id === 'ure/site'), true)
})

test('derives the exact project id from its directory path under projects', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const toolsDir = join(workspaceDir, 'projects', 'gol', 'tools')
  mkdirSync(toolsDir, { recursive: true })
  writeFmproj(toolsDir, 'tools', { name: 'tools', description: 'Tools project' })

  const projects = discoverProjects(workspaceDir)
  const toolsProject = projects.get('gol/tools')

  assert.ok(toolsProject)
  assert.equal(toolsProject?.id, 'gol/tools')
})

test('rejects project name and filename mismatches', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const testDir = join(workspaceDir, 'projects', 'test')
  mkdirSync(testDir, { recursive: true })
  writeFmproj(testDir, 'WRONG', { name: 'test', description: 'Mismatch' })

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }

  try {
    const projects = discoverProjects(workspaceDir)

    assert.equal(projects.has('test'), false)
    assert.equal(errors.some((message) => message.includes("does not match filename 'WRONG'")), true)
  } finally {
    console.error = originalError
  }
})

test('rejects sibling name collision under the same parent', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const aDir = join(workspaceDir, 'projects', 'a')
  const leftDir = join(aDir, 'left')
  const rightDir = join(aDir, 'right')
  mkdirSync(leftDir, { recursive: true })
  mkdirSync(rightDir, { recursive: true })

  writeFmproj(aDir, 'a', { name: 'a', description: 'Parent' })
  writeFmproj(leftDir, 'b', { name: 'b', description: 'Left child' })
  writeFmproj(rightDir, 'b', { name: 'b', description: 'Right child' })

  assert.throws(
    () => {
      discoverProjects(workspaceDir)
    },
    /duplicate|collision/i,
  )
})

test('resolves host path from project hosts map and unknown hosts return null', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const projectDir = join(workspaceDir, 'projects', 'hosted')
  mkdirSync(projectDir, { recursive: true })
  writeFmproj(projectDir, 'hosted', {
    name: 'hosted',
    description: 'Hosted project',
    hosts: { myhost: '/path/to/repo' },
  })

  const projects = discoverProjects(workspaceDir)
  assert.equal(projects.has('hosted'), true)
  assert.equal(resolveProjectPath('hosted', 'myhost'), '/path/to/repo')
  assert.equal(resolveProjectPath('hosted', 'unknown'), null)
})

test('getAncestorChain returns far-to-near chain including self', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const levelA = join(workspaceDir, 'projects', 'a')
  const levelB = join(levelA, 'b')
  const levelC = join(levelB, 'c')
  mkdirSync(levelC, { recursive: true })
  writeFmproj(levelA, 'a', { name: 'a', description: 'Level A' })
  writeFmproj(levelB, 'b', { name: 'b', description: 'Level B' })
  writeFmproj(levelC, 'c', { name: 'c', description: 'Level C' })

  const projects = discoverProjects(workspaceDir)
  const projectC = projects.get('a/b/c')
  const chain = getAncestorChain(projectC!)

  assert.deepEqual(chain.map((project) => project.id), ['a', 'a/b', 'a/b/c'])
})

test('skips generated dependency directories without treating worktrees as generated', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const skipWorktrees = join(workspaceDir, 'projects', 'gol', 'worktrees')
  const skipNodeModules = join(workspaceDir, 'projects', 'gol', 'node_modules', 'pkg')
  mkdirSync(skipWorktrees, { recursive: true })
  mkdirSync(skipNodeModules, { recursive: true })
  writeFmproj(skipWorktrees, 'some', { name: 'some', description: 'Should skip' })
  writeFmproj(skipNodeModules, 'pkg', { name: 'pkg', description: 'Should skip' })

  const projects = discoverProjects(workspaceDir)

  assert.equal(projects.has('gol/worktrees/some'), true)
  assert.equal(projects.has('gol/node_modules/pkg'), false)
})

test('invalidates the projects cache after workspace changes', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const projectsDir = join(workspaceDir, 'projects')
  writeFmproj(projectsDir, 'first', { name: 'first', description: 'First project' })

  const initial = discoverProjects(workspaceDir)
  assert.equal(initial.has('first'), true)
  assert.equal(initial.has('second'), false)

  writeFmproj(projectsDir, 'second', { name: 'second', description: 'Second project' })

  const cached = discoverProjects(workspaceDir)
  assert.equal(cached.has('second'), false)

  invalidateProjectCache()
  const refreshed = discoverProjects(workspaceDir)

  assert.equal(refreshed.has('first'), true)
  assert.equal(refreshed.has('second'), true)
})

test('canonicalize lowercases and strips .local and trailing -<digits>', () => {
  assert.equal(canonicalize('BUILD-NODE.local'), 'build-node')
  assert.equal(canonicalize('BUILD-NODE-3.local'), 'build-node')
  assert.equal(canonicalize('BUILD-NODE'), 'build-node')
  assert.equal(canonicalize('BUILD-NODE-2'), 'build-node')
  assert.equal(canonicalize('FOO-BAR.local'), 'foo-bar')
})

test('canonicalize does not strip -<digits> if not pure digits', () => {
  assert.equal(canonicalize('BUILD-PC2'), 'build-pc2')
  assert.equal(canonicalize('BUILD-PC2.local'), 'build-pc2')
  assert.equal(canonicalize('HOST-PC2'), 'host-pc2')
  assert.equal(canonicalize('HOST-PC23'), 'host-pc23')
  assert.equal(canonicalize('MY-MAC'), 'my-mac')
})

test('exact match takes priority over canonical fallback', () => {
  const hosts = {
    'BUILD-NODE.local': '/exact/path',
    'build-node': '/canonical/path',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE.local'), '/exact/path')
})

test('canonical fallback: NAME-3.local resolves via key NAME.local', () => {
  const hosts = {
    'BUILD-NODE.local': '/path/to/repo',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE-3.local'), '/path/to/repo')
})

test('canonical fallback: NAME resolves via key NAME-2', () => {
  const hosts = {
    'BUILD-NODE-2': '/path/to/repo',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE'), '/path/to/repo')
})

test('BUILD-PC2 does NOT match BUILD-PC (PC2 is not digit-only)', () => {
  const hosts = {
    'BUILD-PC': '/wrong/path',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-PC2'), null)
})

test('canonical fallback prefers suffix-less key among ambiguities', () => {
  const hosts = {
    'BUILD-NODE-2': '/path/ordinal',
    'BUILD-NODE.local': '/path/suffix-less',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE-3'), '/path/suffix-less')
})

test('canonical fallback returns first in declaration order when multiple suffix-less match', () => {
  const hosts = {
    'BUILD-NODE': '/path/first',
    'build-node': '/path/second',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE-2.local'), '/path/first')
})

test('canonical fallback: both sides have ordinals, prefers first in order', () => {
  const hosts = {
    'BUILD-NODE-1': '/path/one',
    'BUILD-NODE-2': '/path/two',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE-3'), '/path/one')
})

test('canonical fallback: multiple ambiguous keys, prefers suffix-less', () => {
  const hosts = {
    'BUILD-NODE-1': '/path/one',
    'BUILD-NODE-2.local': '/path/two',
    'build-node': '/path/three',
  }

  assert.equal(resolveHostPath(hosts, 'BUILD-NODE-3.local'), '/path/three')
})

test('canonical fallback does not warn when matching keys share the same path', () => {
  const hosts = {
    'SAME-PATH-MAC.local': '/path/shared',
    'SAME-PATH-MAC-2.local': '/path/shared',
    'same-path-mac-3': '/path/shared',
  }

  const warnings = captureWarnings(() => {
    assert.equal(resolveHostPath(hosts, 'SAME-PATH-MAC-4.local'), '/path/shared')
  })

  assert.deepEqual(warnings, [])
})

test('canonical fallback warns once for repeated ambiguous matches with different paths', () => {
  const hosts = {
    'WARN-ONCE-MAC-1.local': '/path/one',
    'WARN-ONCE-MAC.local': '/path/suffix-less',
    'warn-once-mac-2': '/path/two',
  }

  const warnings = captureWarnings(() => {
    assert.equal(resolveHostPath(hosts, 'WARN-ONCE-MAC-3.local'), '/path/suffix-less')
    assert.equal(resolveHostPath(hosts, 'WARN-ONCE-MAC-4.local'), '/path/suffix-less')
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ambiguous hostname canonical match/u)
  assert.match(warnings[0], /warn-once-mac/u)
})

test('resolveHostPath returns null for undefined hosts', () => {
  assert.equal(resolveHostPath(undefined, 'anyhost'), null)
})

test('resolveHostPath returns null for empty hostname', () => {
  const hosts = { 'myhost': '/path' }
  assert.equal(resolveHostPath(hosts, ''), null)
  assert.equal(resolveHostPath(hosts, '  '), null)
})

test('resolveHostPath returns null when no canonical match exists', () => {
  const hosts = { 'OTHER-MAC.local': '/path' }
  assert.equal(resolveHostPath(hosts, 'BUILD-NODE'), null)
})

test('resolveProjectPath uses canonical fallback for .fmproj host resolution', () => {
  const workspaceDir = createWorkspaceWithProjectsDir()
  const projectDir = join(workspaceDir, 'projects', 'canonical')
  mkdirSync(projectDir, { recursive: true })
  writeFmproj(projectDir, 'canonical', {
    name: 'canonical',
    description: 'Canonical host project',
    hosts: { 'BUILD-NODE.local': '/path/to/repo' },
  })

  discoverProjects(workspaceDir)
  assert.equal(resolveProjectPath('canonical', 'BUILD-NODE-3.local'), '/path/to/repo')
  assert.equal(resolveProjectPath('canonical', 'BUILD-NODE.local'), '/path/to/repo')
  assert.equal(resolveProjectPath('canonical', 'unknown'), null)
})
