/**
 * Workspace VCS service — daemon-owned git authority for the workspace root.
 *
 * Thin delegation to the pure git-checkout helpers, scoped to the workspace
 * root checkout. The workspace root must be a git work tree.
 */

import {
  commitExactFiles,
  gitDiff,
  gitStatus,
  pullCheckout,
  pushCheckout,
  type CommitExactFilesResult,
  type GitDiffOptions,
  type GitStatus,
  type PullCheckoutResult,
  type PushCheckoutResult,
} from '../../core/vcs/git-checkout.mts'

export class WorkspaceVcsService {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  /** Working-tree status of the workspace root checkout. */
  async status(): Promise<GitStatus> {
    return gitStatus(this.workspaceRoot)
  }

  /** Unified diff of the workspace root checkout. */
  async diff(options: GitDiffOptions = {}): Promise<string> {
    return gitDiff(this.workspaceRoot, options)
  }

  /** Commit exactly the named files in the workspace root checkout. */
  async commit(input: { message: string; files: string[] }): Promise<CommitExactFilesResult> {
    return commitExactFiles(this.workspaceRoot, input)
  }

  /** Push the workspace root checkout. The workspace working tree may be dirty. */
  async push(): Promise<PushCheckoutResult> {
    return pushCheckout(this.workspaceRoot, { requireClean: false })
  }

  /** Fast-forward pull the workspace root checkout. Requires a clean tree. */
  async pull(): Promise<PullCheckoutResult> {
    return pullCheckout(this.workspaceRoot)
  }
}
