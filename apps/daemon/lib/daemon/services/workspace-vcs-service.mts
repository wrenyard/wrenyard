/**
 * Workspace VCS service — daemon-owned git authority for the workspace root.
 *
 * Thin delegation to the pure git-checkout helpers, scoped to the workspace
 * root checkout. The workspace root must be a git work tree.
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'

import {
  commitExactFiles,
  gitDiff,
  gitStatus,
  GitCheckoutError,
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

  /**
   * Refuse version control unless the workspace root is the root of its own
   * git repository — not merely a subdirectory of some parent repository.
   *
   * Runs `git rev-parse --show-toplevel` on every call and never caches the
   * result, so a later `git init` in the workspace takes effect.
   */
  private async assertWorkspaceIsRepositoryRoot(): Promise<void> {
    const root = this.workspaceRoot
    const toplevel = await new Promise<string | null>((resolve) => {
      execFile(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: root, encoding: 'utf8', windowsHide: true },
        (error: Error | null, stdout: string) => {
          resolve(error ? null : stdout.trim() || null)
        },
      )
    })

    if (!toplevel) {
      throw new GitCheckoutError(
        'workspace_not_repository',
        `Workspace ${root} is not a git repository. Workspace version control is unavailable until the workspace has its own repository.`,
      )
    }

    const normalize = (value: string): string => {
      let real: string
      try {
        real = realpathSync(value)
      } catch {
        real = value
      }
      const slashed = real.replace(/\\/gu, '/').replace(/\/+$/u, '')
      return process.platform === 'win32' ? slashed.toLowerCase() : slashed
    }

    if (normalize(root) !== normalize(toplevel)) {
      throw new GitCheckoutError(
        'workspace_not_repository',
        `Workspace ${root} is not the root of a git repository; git resolved the parent repository ${toplevel}. Workspace version control only operates on the workspace's own repository.`,
      )
    }
  }

  /** Working-tree status of the workspace root checkout. */
  async status(): Promise<GitStatus> {
    await this.assertWorkspaceIsRepositoryRoot()
    return gitStatus(this.workspaceRoot)
  }

  /** Unified diff of the workspace root checkout. */
  async diff(options: GitDiffOptions = {}): Promise<string> {
    await this.assertWorkspaceIsRepositoryRoot()
    return gitDiff(this.workspaceRoot, options)
  }

  /** Commit exactly the named files in the workspace root checkout. */
  async commit(input: { message: string; files: string[] }): Promise<CommitExactFilesResult> {
    await this.assertWorkspaceIsRepositoryRoot()
    return commitExactFiles(this.workspaceRoot, input)
  }

  /** Push the workspace root checkout. The workspace working tree may be dirty. */
  async push(): Promise<PushCheckoutResult> {
    await this.assertWorkspaceIsRepositoryRoot()
    return pushCheckout(this.workspaceRoot, { requireClean: false })
  }

  /** Fast-forward pull the workspace root checkout. Requires a clean tree. */
  async pull(): Promise<PullCheckoutResult> {
    await this.assertWorkspaceIsRepositoryRoot()
    return pullCheckout(this.workspaceRoot)
  }
}
