/**
 * Project feature wire DTOs: the `project.*` params/result surface and the
 * shared project / worktree / commit-log record shapes.
 *
 * Declared independently of any runtime package: the shapes are structural and
 * describe exactly what crosses the IPC boundary. The daemon holds the runtime
 * JSON schemas that validate these.
 */

export interface ProjectListParams {}

export interface ProjectEntry {
  name: string
  path: string
  displayName?: string
  noWorktree?: boolean
  gitRemote?: string
  defaultBranch?: string
  implicit?: boolean
}

export type ProjectListResult = ProjectEntry[]

export interface ProjectDescribeParams {
  project: string
}

export type ProjectDescribeResult = ProjectEntry

export interface WorktreeInfo {
  id: string
  path: string
  branch: string | null
  clean: boolean
  owner?: string
}

export interface ProjectOverview {
  name: string
  path: string
  worktree_count: number
}

export interface ProjectDetail {
  name: string
  path: string
  worktrees: WorktreeInfo[]
}

export interface ProjectStatusParams {
  project?: string
}

export type ProjectStatusResult = ProjectDetail | ProjectOverview[]

export interface ProjectPullParams {
  project: string
}

export interface ProjectPullResult {
  project: string
  path?: string
  branch?: string
  remote?: string
  pulled: boolean
  reason?: string
  error?: string
  dirty?: Record<string, unknown>
  summary: string
}

export interface ProjectPushParams {
  project?: string
  worktree_id?: string
}

export interface ProjectPushResult {
  project?: string
  worktree_id?: string
  path?: string
  branch?: string
  remote?: string
  pushed: boolean
  reason?: string
  error?: string
  dirty?: Record<string, unknown>
  summary: string
}

export interface ProjectWorktreeListParams {
  project: string
}

export type ProjectWorktreeListResult = WorktreeInfo[]

export interface ProjectWorktreeCreateParams {
  project: string
  worktree_id?: string
  branch?: string
  /** Lock required to remove or merge the worktree; sessions get their own id. */
  lock?: string
}

export interface ProjectWorktreeCreateResult {
  project: string
  worktree_id: string
  path: string
  branch: string
}

export interface ProjectWorktreeMergeParams {
  project: string
  worktree_id: string
  lock?: string
  /** Escape hatch: merge a worktree locked by another creator. */
  force?: boolean
}

export interface ProjectWorktreeMergeResult {
  project: string
  worktree_id: string
  branch?: string
  target_branch?: string
  worktree_path?: string
  before_sha?: string
  after_sha?: string
  worktree_sha?: string
  commit_count?: number
  merged: boolean
  removed: boolean
  branch_deleted?: boolean
  reason?: string
  error?: string
}

export interface ProjectWorktreeRebaseParams {
  project: string
  worktree_id: string
}

/** One target-branch commit that touched the conflicting paths of a failed rebase. */
export interface ProjectWorktreeRebaseCommit {
  sha: string
  subject: string
  files: string[]
}

export interface ProjectWorktreeRebaseResult {
  project: string
  worktree_id: string
  rebased: boolean
  target_branch?: string
  before_sha?: string
  head_sha?: string
  conflicts?: string[]
  target_commits?: ProjectWorktreeRebaseCommit[]
  reason?: string
  error?: string
}

export interface ProjectWorktreeRemoveParams {
  worktree_id: string
  project?: string
  lock?: string
  /** Escape hatch: remove a worktree locked by another creator. */
  force?: boolean
}

export interface ProjectWorktreeRemoveResult {
  worktree_id: string
  removed: boolean
  project?: string
  path?: string
  error?: string
}

// ─── project.commitLog ─────────────────────────────────────────────────

export interface CommitLogEntry {
  sha: string
  authored_at: string
  author_name: string
  subject: string
}

export interface ProjectCommitLogParams {
  project: string
  limit?: number
}

export interface ProjectCommitLogResult {
  project: string
  commits: CommitLogEntry[]
}

// ─── project.diff / project.commit ─────────────────────────────────────

export interface ProjectDiffParams {
  project: string
  worktree_id?: string
  paths?: string[]
  staged?: boolean
}

export interface ProjectDiffResult {
  project: string
  worktree_id?: string
  diff: string
}

export interface ProjectCommitParams {
  project: string
  worktree_id?: string
  message: string
  files: string[]
}

export interface ProjectCommitResult {
  project: string
  worktree_id?: string
  hash: string
  branch: string | null
  files: string[]
  shortstat: string
}

// ─── project.register ──────────────────────────────────────────────────

export interface ProjectRegisterParams {
  project: string
  description: string
  display_name?: string
  checkout_path?: string
  git_remote?: string
  default_branch?: string
}

export interface ProjectRegisterResult {
  project: string
  file: string
  path: string | null
  git_remote?: string
  default_branch?: string
  registered: boolean
}
