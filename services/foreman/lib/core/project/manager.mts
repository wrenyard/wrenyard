import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { foremanStateRoot } from '../../config/state.mts'
import { discoverProjects, findProject as findFmprojProject, resolveHostPath } from './loader.mts'
import type {
  ProjectDetail,
  ProjectEntry,
  ProjectGitPullResult,
  ProjectGitPushResult,
  ProjectManagerOptions,
  ProjectNode,
  ProjectOverview,
  WorktreeBaseRestore,
  WorktreeCreateResult,
  WorktreeDirtyDetails,
  WorktreeDirtyFile,
  WorktreeInfo,
  WorktreeMergeCommit,
  WorktreeMergeResult,
  WorktreeRemoteCheck,
  WorktreeRemoveResult,
  WorktreeUntrackedContent,
} from './types.mts'

export type {
  ProjectDetail,
  ProjectEntry,
  ProjectGitPullResult,
  ProjectGitPushResult,
  ProjectManagerOptions,
  ProjectOverview,
  WorktreeCreateResult,
  WorktreeInfo,
  WorktreeMergeResult,
  WorktreeRemoveResult,
} from './types.mts'

interface WorktreeMatch {
  project: ProjectEntry
  path: string
}

const WORKTREE_ID_RE = /^[A-Za-z0-9_-]{8}$/u
const WORKTREE_METADATA_DIR = '.foreman'
const DIRTY_TEXT_LIMIT = 64 * 1024
const UNTRACKED_TEXT_LIMIT = 8 * 1024
const UNTRACKED_LARGE_LIMIT = 64 * 1024

export function foremanWorkspaceFromEnv(): string | null {
  const workspace = process.env.FOREMAN_WORKSPACE?.trim()
  return workspace ? resolve(workspace) : null
}

/**
 * Read all managed worktree metadata and return a map from absolute
 * worktree path to the registered project id. Equivalent to iterating
 * every worktree metadata JSON under `{stateRoot}/worktrees/.foreman/`.
 */
export function listAllManagedWorktreePaths(stateRoot: string): Map<string, string> {
  const root = join(stateRoot, 'worktrees', WORKTREE_METADATA_DIR)
  if (!existsSync(root)) return new Map()
  const result = new Map<string, string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const metadataPath = join(root, entry.name)
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as { id?: unknown; project?: unknown; path?: unknown }
      if (typeof metadata.id === 'string' && typeof metadata.project === 'string' && typeof metadata.path === 'string') {
        result.set(resolve(metadata.path), metadata.project)
      }
    } catch {
      // skip invalid metadata files
    }
  }
  return result
}

export class ProjectManager {
  readonly workspaceRoot: string

  private readonly stateRoot: string
  private readonly hostname: string
  private readonly idGenerator: () => string
  private readonly gitBin: string

  constructor(options: ProjectManagerOptions = {}) {
    const workspaceRoot = options.workspaceRoot?.trim() || foremanWorkspaceFromEnv()
    if (!workspaceRoot) throw new Error('FOREMAN_WORKSPACE is not set')

    this.workspaceRoot = resolve(workspaceRoot)
    this.stateRoot = resolve(options.stateRoot?.trim() || foremanStateRoot())
    this.hostname = options.hostname?.trim() || osHostname()
    this.idGenerator = options.idGenerator ?? (() => randomBytes(4).toString('hex'))
    this.gitBin = options.gitBin ?? 'git'
  }

  listProjects(): ProjectEntry[] {
    const projects: ProjectEntry[] = []
    const fmprojProjects: Map<string, ProjectNode> = discoverProjects(this.workspaceRoot)
    for (const [projectId, node] of fmprojProjects) {
      const project = this.projectEntryFromFmproj(projectId, node)
      if (project) {
        projects.push(project)
      }
    }

    return projects
  }

  isNoWorktree(projectName: string): boolean {
    return this.getProject(projectName).noWorktree === true
  }

  private resolvePathFromFmproj(projectName: string): string | null {
    const hostname = this.hostname
    discoverProjects(this.workspaceRoot)
    if (hostname) {
      const node = findFmprojProject(projectName)
      if (node) {
        const path = resolveHostPath(node.config.hosts, hostname)
        if (path) return resolve(path)
        return null
      }
    }
    return null
  }

  resolveBasePath(projectName: string): string {
    const fmprojPath = this.resolvePathFromFmproj(projectName)
    if (fmprojPath) return fmprojPath
    return this.getProject(projectName).path
  }

  getProject(name: string): ProjectEntry {
    const projectName = name.trim()
    if (!projectName) throw new Error('project is required')

    const fmprojProjects = discoverProjects(this.workspaceRoot)
    const fmprojProject = fmprojProjects.get(projectName)
    if (!fmprojProject) {
      throw new Error(`Project '${projectName}' is not registered`)
    }

    const fmprojEntry = this.projectEntryFromFmproj(projectName, fmprojProject)
    if (fmprojEntry) return fmprojEntry

    const projectFileName = `${projectName.split('/').at(-1)}.fmproj`
    throw new Error(
      `Project '${projectName}' has no host path configured for ${this.hostname}. ` +
      `Add it to projects/${projectName}/${projectFileName} hosts.` +
      hostMappingHint(this.hostname),
    )
  }

  findProject(name: string): ProjectEntry | null {
    const projectName = name.trim()
    if (!projectName) return null

    const fmprojProjects = discoverProjects(this.workspaceRoot)
    const fmprojProject = fmprojProjects.get(projectName)
    const fmprojEntry = fmprojProject ? this.projectEntryFromFmproj(projectName, fmprojProject) : null
    if (fmprojEntry) return fmprojEntry

    return null
  }

  /**
   * Check if a project exists in .fmproj discovery but has no host path
   * for the current device. Used to distinguish unknown project from
   * known project not available on this device.
   */
  hasProjectButNoLocalCheckout(projectName: string): boolean {
    const fmprojProjects = discoverProjects(this.workspaceRoot)
    const node = fmprojProjects.get(projectName.trim())
    if (!node) return false
    return resolveHostPath(node.config.hosts, this.hostname) === null
  }

  findProjectByPath(path: string): ProjectEntry | null {
    const target = normalizePath(path)
    const projects = this.listProjects()
    return projects.find((project) => normalizePath(project.path) === target) ?? null
  }

  private projectEntryFromFmproj(projectName: string, node: ProjectNode): ProjectEntry | null {
    const hostPath = resolveHostPath(node.config.hosts, this.hostname)
    if (!hostPath) return null
    return {
      name: projectName,
      path: resolve(hostPath),
      ...(node.config.git?.remote ? { gitRemote: node.config.git.remote } : {}),
      ...(node.config.git?.default_branch ? { defaultBranch: node.config.git.default_branch } : {}),
      ...(!node.config.git?.remote ? { noWorktree: true } : {}),
      implicit: false,
    }
  }

  status(projectName?: string): ProjectOverview[] | ProjectDetail {
    const name = projectName?.trim()
    if (name) {
      const project = this.getProject(name)
      return {
        name: project.name,
        path: project.path,
        worktrees: this.listWorktrees(project.name),
      }
    }

    return this.listProjects().map((project) => ({
      name: project.name,
      path: project.path,
      worktree_count: this.listWorktrees(project.name).length,
    }))
  }

  listWorktrees(projectName: string): WorktreeInfo[] {
    const project = this.getProject(projectName)
    if (project.noWorktree) return []

    const root = this.worktreesRoot()
    if (!existsSync(root)) return []

    return this.listWorktreeMetadata()
      .filter((metadata) => metadata.project === project.name && existsSync(metadata.path))
      .map((metadata) => this.describeWorktree(metadata.id, metadata.path))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  createWorktree(projectName: string, branch?: string): WorktreeCreateResult {
    const project = this.getProject(projectName)
    if (project.noWorktree) throw new Error(this.worktreeUnsupportedProjectMessage(project))
    if (!existsSync(project.path)) throw new Error(`Project path does not exist: ${project.path}`)

    const id = this.allocateWorktreeId(project.name)
    const targetPath = this.worktreePath(id)
    const branchName = branch?.trim() || `wrenyard/${id}`
    if (!branchName) throw new Error('branch must not be empty')

    mkdirSync(dirname(targetPath), { recursive: true })
    const args = this.localBranchExists(project.path, branchName)
      ? ['worktree', 'add', targetPath, branchName]
      : ['worktree', 'add', '-b', branchName, targetPath]

    try {
      this.git(project.path, args)
      this.writeWorktreeMetadata({
        id,
        project: project.name,
        path: targetPath,
      })
    } catch (e) {
      rmSync(targetPath, { recursive: true, force: true })
      this.removeWorktreeMetadata(id)
      throw e
    }

    return {
      project: project.name,
      worktree_id: id,
      path: targetPath,
      branch: this.currentBranch(targetPath) ?? branchName,
    }
  }

  removeWorktree(worktreeId: string): WorktreeRemoveResult {
    const id = validateWorktreeId(worktreeId)
    const metadata = this.readWorktreeMetadata(id)
    if (!metadata || !existsSync(metadata.path)) {
      return {
        worktree_id: id,
        removed: false,
        error: `Worktree '${id}' was not found`,
      }
    }

    const project = this.findProject(metadata.project)
    if (!project) {
      return {
        worktree_id: id,
        removed: false,
        project: metadata.project,
        path: metadata.path,
        error: `Worktree '${id}' metadata references missing project '${metadata.project}'`,
      }
    }
    if (project.noWorktree) {
      return {
        worktree_id: id,
        removed: false,
        project: project.name,
        path: metadata.path,
        error: `Worktree '${id}' metadata references project '${project.name}', which does not support worktrees`,
      }
    }

    try {
      this.git(project.path, ['worktree', 'remove', metadata.path])
    } catch (e) {
      return {
        worktree_id: id,
        removed: false,
        project: project.name,
        path: metadata.path,
        error: errorMessage(e),
      }
    }

    rmSync(metadata.path, { recursive: true, force: true })
    this.removeWorktreeMetadata(id)
    return {
      worktree_id: id,
      removed: true,
      project: project.name,
      path: metadata.path,
    }
  }

  mergeWorktree(projectName: string, worktreeId: string): WorktreeMergeResult {
    const requestedProject = projectName.trim()
    let id: string
    try {
      id = validateWorktreeId(worktreeId)
    } catch (error) {
      return {
        project: requestedProject,
        worktree_id: worktreeId.trim(),
        merged: false,
        removed: false,
        reason: 'invalid_worktree_id',
        error: errorMessage(error),
      }
    }

    const metadata = this.readWorktreeMetadata(id)
    const requestedBase = (extra: Partial<WorktreeMergeResult> = {}): WorktreeMergeResult => ({
      project: requestedProject,
      worktree_id: id,
      merged: false,
      removed: false,
      ...extra,
    })

    let project: ProjectEntry
    try {
      project = this.getProject(projectName)
    } catch (error) {
      if (metadata && metadata.project === requestedProject) {
        return requestedBase({
          worktree_path: metadata.path,
          metadata_project: metadata.project,
          reason: 'metadata_project_missing',
          error: `Worktree '${id}' metadata references missing project '${metadata.project}'`,
        })
      }
      return requestedBase({
        reason: 'project_missing',
        error: errorMessage(error),
      })
    }
    const base = (extra: Partial<WorktreeMergeResult> = {}): WorktreeMergeResult => ({
      project: project.name,
      worktree_id: id,
      merged: false,
      removed: false,
      ...extra,
    })

    if (project.noWorktree) {
      return base({
        reason: 'project_unsupported',
        error: `Project '${project.name}' does not support worktrees`,
      })
    }
    if (!existsSync(project.path)) {
      return base({
        reason: 'project_path_missing',
        error: `Project path does not exist: ${project.path}`,
      })
    }

    if (!metadata) {
      return base({
        reason: 'worktree_metadata_missing',
        error: `Worktree '${id}' metadata was not found`,
      })
    }

    const worktreeBase = (extra: Partial<WorktreeMergeResult> = {}): WorktreeMergeResult => base({
      worktree_path: metadata.path,
      ...extra,
    })
    if (metadata.project !== project.name) {
      return worktreeBase({
        metadata_project: metadata.project,
        reason: 'project_mismatch',
        error: `Worktree '${id}' belongs to project '${metadata.project}', not '${project.name}'`,
      })
    }
    if (!existsSync(metadata.path)) {
      return worktreeBase({
        reason: 'worktree_path_missing',
        error: `Managed worktree path does not exist: ${metadata.path}`,
      })
    }

    const branch = this.attachedBranch(metadata.path)
    if (!branch) {
      return worktreeBase({
        reason: 'detached_head',
        error: `Worktree '${id}' is not on an attached branch`,
      })
    }

    const dirty = this.dirtyDetails(metadata.path)
    if (dirty.dirty) {
      return worktreeBase({
        branch,
        dirty,
        reason: 'worktree_dirty',
        error: `Worktree '${id}' has uncommitted changes`,
      })
    }

    const targetBranch = this.resolveTargetBranch(project)
    if (!targetBranch) {
      return worktreeBase({
        branch,
        reason: 'target_branch_missing',
        error: 'No local target branch found. Expected fmproj git.default_branch, main, or master.',
      })
    }

    const targetBase = (extra: Partial<WorktreeMergeResult> = {}): WorktreeMergeResult => worktreeBase({
      branch,
      target_branch: targetBranch,
      ...extra,
    })
    const baseDirty = this.dirtyDetails(project.path)
    if (baseDirty.dirty) {
      return targetBase({
        dirty: baseDirty,
        reason: 'base_dirty',
        error: `Base checkout for '${project.name}' has uncommitted changes`,
      })
    }

    const remoteCheck = this.checkRemoteTarget(project.path, targetBranch)
    if (remoteCheck.status === 'failed') {
      const reason = remoteCheck.reason === 'remote_ahead'
        ? 'target_branch_remote_ahead'
        : remoteCheck.reason === 'count_unavailable'
          ? 'target_branch_remote_count_unavailable'
          : 'target_branch_stale'
      return targetBase({
        remote_check: remoteCheck,
        reason,
        error: remoteCheck.error ?? `Local target branch '${targetBranch}' is not current with origin/${targetBranch}`,
      })
    }

    const beforeSha = this.revParse(project.path, `refs/heads/${targetBranch}`) ?? undefined
    const worktreeSha = this.revParse(metadata.path, 'HEAD') ?? undefined
    const commitCount = this.revListCount(project.path, `${targetBranch}..${branch}`)
    if (commitCount === null) {
      return targetBase({
        before_sha: beforeSha,
        worktree_sha: worktreeSha,
        remote_check: remoteCheck,
        reason: 'commit_count_failed',
        error: `Could not count commits on '${branch}' that are not on '${targetBranch}'`,
      })
    }
    const commits = this.commitList(project.path, `${targetBranch}..${branch}`)
    if (commitCount === 0) {
      return targetBase({
        before_sha: beforeSha,
        worktree_sha: worktreeSha,
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        reason: 'no_unique_commits',
        error: `Worktree branch '${branch}' has no commits to merge into '${targetBranch}'`,
      })
    }

    try {
      this.git(metadata.path, ['rebase', targetBranch])
    } catch (error) {
      try {
        this.git(metadata.path, ['rebase', '--abort'])
      } catch {
        // Best effort cleanup; the failure result still preserves the original rebase error.
      }
      return targetBase({
        before_sha: beforeSha,
        worktree_sha: worktreeSha,
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        reason: 'rebase_failed',
        error: errorMessage(error),
      })
    }

    const rebasedSha = this.revParse(metadata.path, 'HEAD') ?? undefined
    if (!this.isAncestor(project.path, targetBranch, rebasedSha ?? branch)) {
      return targetBase({
        before_sha: beforeSha,
        worktree_sha: rebasedSha,
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        reason: 'non_fast_forward',
        error: `Target branch '${targetBranch}' cannot fast-forward to '${branch}'`,
      })
    }

    const priorBaseBranch = this.attachedBranch(project.path) ?? undefined
    const priorBaseHead = this.revParse(project.path, 'HEAD') ?? undefined
    let checkedOutTarget = false
    try {
      this.git(project.path, ['checkout', targetBranch])
      checkedOutTarget = true
      this.git(project.path, ['merge', '--ff-only', rebasedSha ?? branch])
    } catch (error) {
      const restore = checkedOutTarget
        ? this.restoreBaseCheckout(project.path, targetBranch, priorBaseBranch, priorBaseHead)
        : undefined
      return targetBase({
        before_sha: beforeSha,
        worktree_sha: rebasedSha,
        ...(checkedOutTarget
          ? { prior_base_branch: priorBaseBranch, prior_base_head: priorBaseHead, base_restore: restore }
          : {}),
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        reason: 'merge_failed',
        error: errorMessage(error),
      })
    }

    const afterSha = this.revParse(project.path, `refs/heads/${targetBranch}`) ?? undefined
    const removeResult = this.removeWorktree(id)
    if (!removeResult.removed) {
      return targetBase({
        before_sha: beforeSha,
        after_sha: afterSha,
        worktree_sha: rebasedSha,
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        merged: true,
        removed: false,
        remove_result: removeResult,
        reason: 'remove_failed',
        error: removeResult.error ?? `Worktree '${id}' merged but could not be removed`,
      })
    }

    // Delete the merged feature branch from the main checkout. Never force:
    // 'git branch -d' refuses if the branch is not fully merged.
    let branchDeleted = true
    let branchDeleteError: string | undefined
    if (branch !== targetBranch) {
      try {
        this.git(project.path, ['branch', '-d', branch])
      } catch (error) {
        branchDeleted = false
        branchDeleteError = errorMessage(error)
      }
    }
    if (!branchDeleted) {
      return targetBase({
        before_sha: beforeSha,
        after_sha: afterSha,
        worktree_sha: rebasedSha,
        commit_count: commitCount,
        commits,
        remote_check: remoteCheck,
        merged: true,
        removed: true,
        remove_result: removeResult,
        branch_deleted: false,
        reason: 'branch_delete_failed',
        error: branchDeleteError ?? `Merged branch '${branch}' could not be deleted`,
      })
    }

    return targetBase({
      before_sha: beforeSha,
      after_sha: afterSha,
      worktree_sha: rebasedSha,
      commit_count: commitCount,
      commits,
      remote_check: remoteCheck,
      merged: true,
      removed: true,
      remove_result: removeResult,
      branch_deleted: true,
    })
  }

  pushProject(options: { project?: string; worktreeId?: string }): ProjectGitPushResult {
    const requestedProject = options.project?.trim() ?? ''
    const rawWorktreeId = options.worktreeId?.trim() ?? ''

    if (!requestedProject && !rawWorktreeId) {
      return {
        pushed: false,
        reason: 'target_missing',
        error: 'project or worktree_id is required',
        summary: 'Push failed: no project or worktree id was provided.',
      }
    }

    if (rawWorktreeId) {
      let id: string
      try {
        id = validateWorktreeId(rawWorktreeId)
      } catch (error) {
        return this.gitPushFailure({
          project: requestedProject || undefined,
          worktree_id: rawWorktreeId,
          reason: 'invalid_worktree_id',
          error: errorMessage(error),
        })
      }

      const metadata = this.readWorktreeMetadata(id)
      if (!metadata) {
        return this.gitPushFailure({
          project: requestedProject || undefined,
          worktree_id: id,
          reason: 'worktree_metadata_missing',
          error: `Worktree '${id}' metadata was not found`,
        })
      }
      if (requestedProject && metadata.project !== requestedProject) {
        return this.gitPushFailure({
          project: requestedProject,
          worktree_id: id,
          path: metadata.path,
          reason: 'project_mismatch',
          error: `Worktree '${id}' belongs to project '${metadata.project}', not '${requestedProject}'`,
        })
      }

      const project = this.findProject(metadata.project)
      if (!project) {
        return this.gitPushFailure({
          project: metadata.project,
          worktree_id: id,
          path: metadata.path,
          reason: 'metadata_project_missing',
          error: `Worktree '${id}' metadata references missing project '${metadata.project}'`,
        })
      }
      if (!existsSync(metadata.path)) {
        return this.gitPushFailure({
          project: project.name,
          worktree_id: id,
          path: metadata.path,
          reason: 'worktree_path_missing',
          error: `Managed worktree path does not exist: ${metadata.path}`,
        })
      }

      return this.pushGitCheckout(project.name, metadata.path, id)
    }

    let project: ProjectEntry
    try {
      project = this.getProject(requestedProject)
    } catch (error) {
      return this.gitPushFailure({
        project: requestedProject,
        reason: 'project_missing',
        error: errorMessage(error),
      })
    }
    if (!existsSync(project.path)) {
      return this.gitPushFailure({
        project: project.name,
        path: project.path,
        reason: 'project_path_missing',
        error: `Project path does not exist: ${project.path}`,
      })
    }

    return this.pushGitCheckout(project.name, project.path)
  }

  pullProject(projectName: string): ProjectGitPullResult {
    const requestedProject = projectName.trim()
    let project: ProjectEntry
    try {
      project = this.getProject(requestedProject)
    } catch (error) {
      return this.gitPullFailure({
        project: requestedProject,
        reason: 'project_missing',
        error: errorMessage(error),
      })
    }

    const base = {
      project: project.name,
      path: project.path,
    }

    if (!existsSync(project.path)) {
      return this.gitPullFailure({
        ...base,
        reason: 'project_path_missing',
        error: `Project path does not exist: ${project.path}`,
      })
    }

    if (!this.isGitWorkTree(project.path)) {
      return this.gitPullFailure({
        ...base,
        reason: 'not_git_repository',
        error: `Path is not a git worktree: ${project.path}`,
      })
    }

    const branch = this.attachedBranch(project.path)
    if (!branch) {
      return this.gitPullFailure({
        ...base,
        reason: 'detached_head',
        error: `Checkout is not on an attached branch: ${project.path}`,
      })
    }

    const dirty = this.dirtyDetails(project.path)
    if (dirty.dirty) {
      return this.gitPullFailure({
        ...base,
        branch,
        dirty,
        reason: 'dirty',
        error: `Checkout has uncommitted changes: ${project.path}`,
      })
    }

    if (!this.remoteExists(project.path, 'origin')) {
      return this.gitPullFailure({
        ...base,
        branch,
        reason: 'origin_missing',
        error: `Checkout has no origin remote: ${project.path}`,
      })
    }

    try {
      this.git(project.path, ['pull', '--ff-only', 'origin', branch])
      return {
        ...base,
        branch,
        remote: 'origin',
        pulled: true,
        summary: `Pulled ${project.name} branch ${branch} from origin.`,
      }
    } catch (error) {
      return this.gitPullFailure({
        ...base,
        branch,
        remote: 'origin',
        reason: 'pull_failed',
        error: errorMessage(error),
      })
    }
  }

  resolveWorktreePath(worktreeId: string, projectName: string): string {
    const id = validateWorktreeId(worktreeId)
    const requestedProject = projectName.trim()
    if (!requestedProject) throw new Error('project is required')

    const project = this.getProject(requestedProject)
    if (project.noWorktree) throw new Error(this.worktreeUnsupportedProjectMessage(project))
    if (!existsSync(project.path)) throw new Error(`Project path does not exist: ${project.path}`)

    const metadata = this.readWorktreeMetadata(id)
    if (!metadata) throw new Error(`Worktree '${id}' was not found`)
    if (!existsSync(metadata.path)) throw new Error(`Managed worktree path does not exist: ${metadata.path}`)
    if (metadata.project !== project.name) {
      throw new Error(`Worktree '${id}' belongs to project '${metadata.project}', not '${project.name}'`)
    }

    // The metadata path is the git worktree root used for merge/remove. For
    // execution, a monorepo project runs inside its registered component
    // directory mirrored beneath that same worktree root. Realpath both sides
    // so a tracked or locally substituted symlink component cannot redirect
    // task execution outside the managed worktree root.
    const mainTop = normalizePath(this.git(project.path, ['rev-parse', '--show-toplevel']).trim())
    const projectRoot = normalizePath(project.path)
    const component = relative(mainTop, projectRoot)
    if (isAbsolute(component) || component.split(/[/\\]/u).includes('..')) {
      throw new Error(`Project '${project.name}' path '${project.path}' is not inside git top-level '${mainTop}'`)
    }

    const worktreeRoot = normalizePath(metadata.path)
    const componentPath = component === '.' ? metadata.path : join(metadata.path, component)
    if (!existsSync(componentPath)) {
      throw new Error(`Managed worktree component path does not exist: ${componentPath}`)
    }
    const normalizedComponent = normalizePath(componentPath)
    const componentRelative = relative(worktreeRoot, normalizedComponent)
    if (isAbsolute(componentRelative) || componentRelative.split(/[/\\]/u).includes('..')) {
      throw new Error(
        `Managed worktree component '${componentPath}' escapes the managed worktree root '${worktreeRoot}'`,
      )
    }
    return normalizedComponent
  }

  private findWorktree(worktreeId: string): WorktreeMatch | null {
    const metadata = this.readWorktreeMetadata(worktreeId)
    if (metadata && existsSync(metadata.path)) {
      const project = this.findProject(metadata.project)
      if (project && !project.noWorktree) return { project, path: metadata.path }
    }
    return null
  }

  private describeWorktree(id: string, path: string): WorktreeInfo {
    return {
      id,
      path,
      branch: this.currentBranch(path),
      clean: this.isClean(path),
    }
  }

  private allocateWorktreeId(projectName: string): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = validateWorktreeId(this.idGenerator())
      if (!this.findWorktree(id)) return id
    }
    throw new Error(`Could not allocate a unique worktree id for project '${projectName}'`)
  }

  private worktreesRoot(): string {
    return join(this.stateRoot, 'worktrees')
  }

  private worktreePath(worktreeId: string): string {
    return join(this.worktreesRoot(), validateWorktreeId(worktreeId))
  }

  private worktreeMetadataRoot(): string {
    return join(this.worktreesRoot(), WORKTREE_METADATA_DIR)
  }

  private worktreeMetadataPath(worktreeId: string): string {
    return join(this.worktreeMetadataRoot(), `${validateWorktreeId(worktreeId)}.json`)
  }

  private writeWorktreeMetadata(metadata: { id: string; project: string; path: string }): void {
    mkdirSync(this.worktreeMetadataRoot(), { recursive: true })
    writeFileSync(this.worktreeMetadataPath(metadata.id), `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8')
  }

  private readWorktreeMetadata(worktreeId: string): { id: string; project: string; path: string } | null {
    const path = this.worktreeMetadataPath(worktreeId)
    if (!existsSync(path)) return null
    try {
      const metadata = JSON.parse(readFileSync(path, 'utf-8')) as { id?: unknown; project?: unknown; path?: unknown }
      if (metadata.id === worktreeId && typeof metadata.project === 'string' && typeof metadata.path === 'string') {
        return { id: worktreeId, project: metadata.project, path: metadata.path }
      }
    } catch {
      return null
    }
    return null
  }

  private listWorktreeMetadata(): Array<{ id: string; project: string; path: string }> {
    const root = this.worktreeMetadataRoot()
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => this.readWorktreeMetadata(entry.name.slice(0, -'.json'.length)))
      .filter((metadata): metadata is { id: string; project: string; path: string } => metadata !== null)
  }

  private removeWorktreeMetadata(worktreeId: string): void {
    try {
      unlinkSync(this.worktreeMetadataPath(worktreeId))
    } catch {
      return
    }
  }

  private currentBranch(path: string): string | null {
    try {
      const branch = this.git(path, ['branch', '--show-current']).trim()
      if (branch) return branch
      const head = this.git(path, ['rev-parse', '--short', 'HEAD']).trim()
      return head || null
    } catch {
      return null
    }
  }

  private attachedBranch(path: string): string | null {
    try {
      const branch = this.git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
      return branch || null
    } catch {
      return null
    }
  }

  private isClean(path: string): boolean {
    try {
      return this.git(path, ['status', '--porcelain']).trim() === ''
    } catch {
      return false
    }
  }

  private localBranchExists(path: string, branch: string): boolean {
    try {
      this.git(path, ['rev-parse', '--verify', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  private resolveTargetBranch(project: ProjectEntry): string | null {
    const candidates = [
      project.defaultBranch,
      'main',
      'master',
    ].filter((branch): branch is string => Boolean(branch?.trim()))

    for (const branch of candidates) {
      if (this.localBranchExists(project.path, branch)) return branch
    }
    return null
  }

  private dirtyDetails(path: string): WorktreeDirtyDetails {
    const entries = parsePorcelainStatus(this.git(path, ['status', '--porcelain=v1', '--untracked-files=all']))
    const files = unique(entries.flatMap((entry) => entry.original_path ? [entry.original_path, entry.path] : [entry.path]))
    return {
      dirty: entries.length > 0,
      status: entries.map(formatDirtyStatus),
      files,
      entries,
      tracked_diff: boundedText(this.git(path, ['diff', '--']), DIRTY_TEXT_LIMIT),
      staged_diff: boundedText(this.git(path, ['diff', '--cached', '--']), DIRTY_TEXT_LIMIT),
      untracked_text: entries
        .filter((entry) => entry.status === '??')
        .map((entry) => this.untrackedContent(path, entry.path)),
    }
  }

  private untrackedContent(root: string, relativePath: string): WorktreeUntrackedContent {
    const path = join(root, relativePath)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) {
        return { path: relativePath, omitted: true, reason: 'not_file' }
      }
      if (stat.size > UNTRACKED_LARGE_LIMIT) {
        return { path: relativePath, size: stat.size, omitted: true, reason: 'large' }
      }
      const buffer = readFileSync(path)
      if (buffer.includes(0)) {
        return { path: relativePath, size: stat.size, omitted: true, reason: 'binary' }
      }
      return {
        path: relativePath,
        size: stat.size,
        content: boundedText(buffer.toString('utf-8'), UNTRACKED_TEXT_LIMIT),
        ...(buffer.length > UNTRACKED_TEXT_LIMIT ? { omitted: true, reason: 'truncated' } : {}),
      }
    } catch (error) {
      return { path: relativePath, omitted: true, reason: `read_error: ${errorMessage(error)}` }
    }
  }

  private checkRemoteTarget(path: string, branch: string): WorktreeRemoteCheck {
    if (!this.remoteExists(path, 'origin')) {
      return { status: 'skipped', remote: 'origin', branch, reason: 'origin remote not configured' }
    }

    const remoteRef = `refs/remotes/origin/${branch}`
    const remoteShaBeforeFetch = this.revParse(path, remoteRef) ?? undefined
    try {
      this.git(path, ['fetch', 'origin', branch])
    } catch (error) {
      const message = errorMessage(error)
      if (!remoteShaBeforeFetch && message.match(/couldn't find remote ref|could not find remote ref/iu)) {
        return { status: 'skipped', remote: 'origin', branch, reason: `origin/${branch} was not found` }
      }
      return {
        status: 'failed',
        remote: 'origin',
        branch,
        error: message,
      }
    }

    const localSha = this.revParse(path, `refs/heads/${branch}`) ?? undefined
    const remoteSha = this.revParse(path, remoteRef) ?? undefined
    if (!remoteSha) {
      return { status: 'skipped', remote: 'origin', branch, local_sha: localSha, reason: `origin/${branch} was not found` }
    }
    if (localSha === remoteSha) {
      return { status: 'checked', remote: 'origin', branch, local_sha: localSha, remote_sha: remoteSha }
    }
    if (!localSha) {
      return {
        status: 'failed',
        remote: 'origin',
        branch,
        remote_sha: remoteSha,
        reason: 'count_unavailable',
        error: `Local target branch '${branch}' could not be resolved; refusing to allow merge without ancestry counts`,
      }
    }

    // Compute both ancestry counts from the exact captured SHAs so a concurrent
    // fetch mutating refs/remotes/origin/<branch> cannot skew the decision.
    const remoteAheadBy = this.revListCount(path, `${localSha}..${remoteSha}`)
    const localAheadBy = this.revListCount(path, `${remoteSha}..${localSha}`)
    if (remoteAheadBy === null || localAheadBy === null) {
      return {
        status: 'failed',
        remote: 'origin',
        branch,
        local_sha: localSha,
        remote_sha: remoteSha,
        ...(remoteAheadBy !== null ? { remote_ahead_by: remoteAheadBy } : {}),
        ...(localAheadBy !== null ? { local_ahead_by: localAheadBy } : {}),
        reason: 'count_unavailable',
        error: `Could not compute ancestry counts between local '${branch}' and origin/${branch}; refusing to allow merge`,
      }
    }
    if (remoteAheadBy > 0) {
      return {
        status: 'failed',
        remote: 'origin',
        branch,
        local_sha: localSha,
        remote_sha: remoteSha,
        remote_ahead_by: remoteAheadBy,
        ...(localAheadBy > 0 ? { local_ahead_by: localAheadBy } : {}),
        reason: 'remote_ahead',
        error: `Local main checkout branch '${branch}' is behind origin/${branch} by ${remoteAheadBy} commit(s). Orchestrator agent must update the main checkout from remote before retrying worktree_merge.`,
      }
    }
    if (remoteAheadBy === 0 && localAheadBy > 0) {
      // Local target is strictly ahead of origin and not behind it; allow the merge.
      return {
        status: 'checked',
        remote: 'origin',
        branch,
        local_sha: localSha,
        remote_sha: remoteSha,
        remote_ahead_by: remoteAheadBy,
        local_ahead_by: localAheadBy,
      }
    }
    return {
      status: 'failed',
      remote: 'origin',
      branch,
      local_sha: localSha,
      remote_sha: remoteSha,
      remote_ahead_by: remoteAheadBy,
      local_ahead_by: localAheadBy,
      reason: 'sha_mismatch',
      error: `Local target branch '${branch}' is stale relative to origin/${branch}`,
    }
  }

  private pushGitCheckout(project: string, path: string, worktreeId?: string): ProjectGitPushResult {
    const base = {
      project,
      ...(worktreeId ? { worktree_id: worktreeId } : {}),
      path,
    }

    if (!this.isGitWorkTree(path)) {
      return this.gitPushFailure({
        ...base,
        reason: 'not_git_repository',
        error: `Path is not a git worktree: ${path}`,
      })
    }

    const branch = this.attachedBranch(path)
    if (!branch) {
      return this.gitPushFailure({
        ...base,
        reason: 'detached_head',
        error: `Checkout is not on an attached branch: ${path}`,
      })
    }

    const dirty = this.dirtyDetails(path)
    if (dirty.dirty) {
      return this.gitPushFailure({
        ...base,
        branch,
        dirty,
        reason: 'dirty',
        error: `Checkout has uncommitted changes: ${path}`,
      })
    }

    if (!this.remoteExists(path, 'origin')) {
      return this.gitPushFailure({
        ...base,
        branch,
        reason: 'origin_missing',
        error: `Checkout has no origin remote: ${path}`,
      })
    }

    try {
      this.git(path, ['push', 'origin', branch])
      return {
        ...base,
        branch,
        remote: 'origin',
        pushed: true,
        summary: `Pushed ${project}${worktreeId ? ` worktree ${worktreeId}` : ''} branch ${branch} to origin.`,
      }
    } catch (error) {
      return this.gitPushFailure({
        ...base,
        branch,
        remote: 'origin',
        reason: 'push_failed',
        error: errorMessage(error),
      })
    }
  }

  private gitPushFailure(result: Omit<ProjectGitPushResult, 'pushed' | 'summary'> & { summary?: string }): ProjectGitPushResult {
    const target = result.worktree_id
      ? `worktree ${result.worktree_id}`
      : result.project
        ? `project ${result.project}`
        : 'target'
    return {
      ...result,
      pushed: false,
      summary: result.summary ?? `Push failed for ${target}: ${result.reason ?? 'unknown'}.`,
    }
  }

  private gitPullFailure(result: Omit<ProjectGitPullResult, 'pulled' | 'summary'> & { summary?: string }): ProjectGitPullResult {
    return {
      ...result,
      pulled: false,
      summary: result.summary ?? `Pull failed for project ${result.project}: ${result.reason ?? 'unknown'}.`,
    }
  }

  private isGitWorkTree(path: string): boolean {
    try {
      return this.git(path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
    } catch {
      return false
    }
  }

  private remoteExists(path: string, remote: string): boolean {
    try {
      this.git(path, ['remote', 'get-url', remote])
      return true
    } catch {
      return false
    }
  }

  private revParse(path: string, ref: string): string | null {
    try {
      return this.git(path, ['rev-parse', '--verify', ref]).trim() || null
    } catch {
      return null
    }
  }

  private revListCount(path: string, range: string): number | null {
    try {
      const value = this.git(path, ['rev-list', '--count', range]).trim()
      const count = Number(value)
      return Number.isInteger(count) ? count : null
    } catch {
      return null
    }
  }

  private commitList(path: string, range: string): WorktreeMergeCommit[] {
    try {
      return this.git(path, ['log', '--format=%H%x00%s', range])
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          const [sha, subject = ''] = line.split('\0')
          return { sha, subject }
        })
    } catch {
      return []
    }
  }

  private isAncestor(path: string, ancestor: string, descendant: string): boolean {
    try {
      this.git(path, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }

  private restoreBaseCheckout(path: string, targetBranch: string, priorBranch?: string, priorHead?: string): WorktreeBaseRestore {
    const ref = priorBranch ?? priorHead
    if (!ref) return { status: 'unavailable' }
    if (priorBranch === targetBranch) return { status: 'not_needed', ref: priorBranch }

    try {
      if (priorBranch) {
        this.git(path, ['checkout', priorBranch])
        return { status: 'restored', ref: priorBranch }
      }
      this.git(path, ['checkout', '--detach', priorHead as string])
      return { status: 'restored', ref: priorHead }
    } catch (error) {
      return {
        status: 'failed',
        ref,
        error: errorMessage(error),
      }
    }
  }

  private git(cwd: string, args: string[]): string {
    return execFileSync(this.gitBin, args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  commitLog(projectName: string, limit: number): { project: string; commits: Array<{ sha: string; authored_at: string; author_name: string; subject: string }> } {
    const l = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? Math.floor(limit) : 20
    const project = this.getProject(projectName)
    const args = ['log', `--max-count=${l}`, '--format=%H%x1f%aI%x1f%an%x1f%s']
    const output = this.git(project.path, args)
    const lines = output.split(/\r?\n/u).filter(Boolean)
    const commits = lines.map((line) => {
      const [sha, authored_at, author_name, ...subjectParts] = line.split('\x1f')
      return {
        sha: sha ?? '',
        authored_at: authored_at ?? '',
        author_name: author_name ?? '',
        subject: subjectParts.join('\x1f'),
      }
    })
    return { project: project.name, commits }
  }

  private worktreeUnsupportedProjectMessage(project: ProjectEntry): string {
    if (!project.gitRemote) {
      return `Project "${project.name}" does not declare git.remote in its .fmproj metadata, so Foreman treats it as non-git and will not create worktrees for it.`
    }
    return `Project "${project.name}" does not support worktrees.`
  }
}

function preferredHostKey(hostname: string): string | null {
  const trimmed = hostname.trim()
  if (!trimmed) return null

  const hasLocalSuffix = trimmed.toLowerCase().endsWith('.local')
  const withoutLocal = hasLocalSuffix
    ? trimmed.slice(0, -'.local'.length)
    : trimmed
  const suffixless = withoutLocal.replace(/-\d+$/u, '')
  const strippedOrdinal = suffixless !== withoutLocal

  if (!hasLocalSuffix && !strippedOrdinal) return null

  if (!suffixless) return null
  return `${suffixless}.local`
}

function hostMappingHint(hostname: string): string {
  const preferred = preferredHostKey(hostname)
  if (!preferred || preferred === hostname.trim()) return ''

  return ` Host matching ignores trailing -<digits> and .local; prefer suffix-less host key '${preferred}' when configuring this machine.`
}

function validateWorktreeId(value: string): string {
  const id = value.trim()
  if (!WORKTREE_ID_RE.test(id)) {
    throw new Error('worktree id must be 8 letters, numbers, underscores, or dashes')
  }
  return id
}

function normalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function parsePorcelainStatus(output: string): WorktreeDirtyFile[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2)
      const rawPath = line.length > 3 ? line.slice(3) : ''
      const renameIndex = rawPath.indexOf(' -> ')
      const originalPath = renameIndex >= 0 ? decodeGitPath(rawPath.slice(0, renameIndex)) : undefined
      const path = decodeGitPath(renameIndex >= 0 ? rawPath.slice(renameIndex + ' -> '.length) : rawPath)
      return {
        status,
        path,
        ...(originalPath ? { original_path: originalPath } : {}),
        index_status: status[0] ?? ' ',
        worktree_status: status[1] ?? ' ',
      }
    })
}

function decodeGitPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      if (typeof decoded === 'string') return decoded
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function formatDirtyStatus(entry: WorktreeDirtyFile): string {
  return entry.original_path
    ? `${entry.status} ${entry.original_path} -> ${entry.path}`
    : `${entry.status} ${entry.path}`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const err = error as Error & { stderr?: unknown; stdout?: unknown }
  const parts = [err.message || String(error)]
  const stderr = bufferText(err.stderr).trim()
  const stdout = bufferText(err.stdout).trim()
  if (stderr) parts.push(stderr)
  if (stdout) parts.push(stdout)
  return parts.join('\n')
}

function bufferText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf-8')
  if (typeof value === 'string') return value
  return ''
}
