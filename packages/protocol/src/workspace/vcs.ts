/**
 * Typed JSON-RPC params/results for the workspace.vcs methods.
 */

// ─── workspace.vcs.status ──────────────────────────────────────────────

export interface WorkspaceVcsStatusEntry {
  path: string
  index: string
  worktree: string
  origPath?: string
}

export interface WorkspaceVcsStatusParams {}

export interface WorkspaceVcsStatusResult {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: WorkspaceVcsStatusEntry[]
}

// ─── workspace.vcs.diff ────────────────────────────────────────────────

export interface WorkspaceVcsDiffParams {
  paths?: string[]
  staged?: boolean
}

export interface WorkspaceVcsDiffResult {
  diff: string
}

// ─── workspace.vcs.commit ──────────────────────────────────────────────

export interface WorkspaceVcsCommitParams {
  message: string
  files: string[]
}

export interface WorkspaceVcsCommitResult {
  hash: string
  branch: string | null
  files: string[]
  shortstat: string
}

// ─── workspace.vcs.push ────────────────────────────────────────────────

export interface WorkspaceVcsPushParams {}

export interface WorkspaceVcsPushResult {
  branch: string
  remote: string
  pushed: boolean
  head?: string
  summary: string
  reason?: string
  error?: string
}

// ─── workspace.vcs.pull ────────────────────────────────────────────────

export interface WorkspaceVcsPullParams {}

export interface WorkspaceVcsPullResult {
  branch: string
  remote: string
  pulled: boolean
  summary: string
  reason?: string
  error?: string
}
