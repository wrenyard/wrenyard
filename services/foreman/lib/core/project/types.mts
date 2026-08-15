export interface FmprojConfig {
  name: string
  description: string
  git?: { remote: string; default_branch?: string }
  hosts?: Record<string, string>
}

export interface ProjectNode {
  /** Exact project id derived from the `.fmproj` path under `projects/`. */
  id: string
  flatName: string
  dirPath: string
  config: FmprojConfig
  parent: ProjectNode | null
  children: ProjectNode[]
}

export interface ProjectEntry {
  name: string
  path: string
  noWorktree?: boolean
  gitRemote?: string
  defaultBranch?: string
  implicit?: boolean
}

export interface WorktreeInfo {
  id: string
  path: string
  branch: string | null
  clean: boolean
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

export interface WorktreeCreateResult {
  project: string
  worktree_id: string
  path: string
  branch: string
}

export interface WorktreeRemoveResult {
  worktree_id: string
  removed: boolean
  project?: string
  path?: string
  error?: string
}

export interface WorktreeDirtyFile {
  status: string
  path: string
  original_path?: string
  index_status: string
  worktree_status: string
}

export interface WorktreeUntrackedContent {
  path: string
  size?: number
  content?: string
  omitted?: boolean
  reason?: string
}

export interface WorktreeDirtyDetails {
  dirty: boolean
  status: string[]
  files: string[]
  entries: WorktreeDirtyFile[]
  tracked_diff: string
  staged_diff: string
  untracked_text: WorktreeUntrackedContent[]
}

export interface WorktreeRemoteCheck {
  status: 'checked' | 'skipped' | 'failed'
  remote?: string
  branch?: string
  local_sha?: string
  remote_sha?: string
  remote_ahead_by?: number
  local_ahead_by?: number
  reason?: string
  error?: string
}

export interface WorktreeBaseRestore {
  status: 'restored' | 'not_needed' | 'unavailable' | 'failed'
  ref?: string
  error?: string
}

export interface WorktreeMergeCommit {
  sha: string
  subject: string
}

export interface WorktreeMergeResult {
  project: string
  worktree_id: string
  branch?: string
  target_branch?: string
  worktree_path?: string
  before_sha?: string
  after_sha?: string
  worktree_sha?: string
  prior_base_branch?: string
  prior_base_head?: string
  base_restore?: WorktreeBaseRestore
  commit_count?: number
  commits?: WorktreeMergeCommit[]
  remote_check?: WorktreeRemoteCheck
  merged: boolean
  removed: boolean
  remove_result?: WorktreeRemoveResult
  branch_deleted?: boolean
  dirty?: WorktreeDirtyDetails
  metadata_project?: string
  reason?: string
  error?: string
}

export interface ProjectGitPullResult {
  project: string
  path?: string
  branch?: string
  remote?: string
  pulled: boolean
  reason?: string
  error?: string
  dirty?: WorktreeDirtyDetails
  summary: string
}

export interface ProjectGitPushResult {
  project?: string
  worktree_id?: string
  path?: string
  branch?: string
  remote?: string
  pushed: boolean
  reason?: string
  error?: string
  dirty?: WorktreeDirtyDetails
  summary: string
}

export interface ProjectManagerOptions {
  workspaceRoot?: string
  stateRoot?: string
  hostname?: string
  idGenerator?: () => string
  gitBin?: string
}
