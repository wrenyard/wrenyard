/**
 * The single git repository module.
 *
 * Owns the daemon's read/write checkout operations: status, diff, exact-file
 * commit, push and pull. Every operation shells out to the `git` binary through
 * `runGit` (no shell, no interpolation). Nothing is forced: no `push --force`,
 * no `branch -D`, no `commit -a`, and no `--tags`. Staging is always limited to
 * an explicit, validated file list.
 *
 * A repository created with `ownRoot: true` operates only on a workspace that
 * holds its own git repository.
 */

import { realpathSync } from 'node:fs'
import { posix } from 'node:path'

import { runGit } from './git.mts'

/** Structured failure carrying a machine-readable `code` and a human message. */
export class VcsError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'VcsError'
    this.code = code
  }
}

// ─── status ───────────────────────────────────────────────────────────────

export interface GitStatusEntry {
  path: string
  index: string
  worktree: string
  origPath?: string
}

export interface GitStatus {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
}

/**
 * Parse the `##` header produced by `git status --porcelain=v1 --branch -z`.
 * Handles detached HEAD, an unborn branch, and the optional `[ahead N, behind
 * M]` suffix.
 */
function parseBranchHeader(header: string): { branch: string | null; upstream: string | null; ahead: number; behind: number } {
  const empty = { branch: null, upstream: null, ahead: 0, behind: 0 }
  const body = header.replace(/^##\s*/u, '').trim()
  if (!body) return empty
  if (/^HEAD \(no branch\)/u.test(body)) return empty

  const noCommits = body.match(/^No commits yet on (.+)$/u)
  if (noCommits) return { branch: noCommits[1].trim(), upstream: null, ahead: 0, behind: 0 }

  const separator = body.indexOf('...')
  if (separator === -1) {
    return { branch: body, upstream: null, ahead: 0, behind: 0 }
  }

  const branch = body.slice(0, separator).trim() || null
  let rest = body.slice(separator + 3)
  let ahead = 0
  let behind = 0
  const bracket = rest.match(/\[(.+)\]/u)
  if (bracket) {
    const aheadMatch = bracket[1].match(/ahead\s+(\d+)/u)
    const behindMatch = bracket[1].match(/behind\s+(\d+)/u)
    if (aheadMatch) ahead = Number(aheadMatch[1])
    if (behindMatch) behind = Number(behindMatch[1])
    rest = rest.slice(0, rest.indexOf('[')).trim()
  }
  return { branch, upstream: rest.trim() || null, ahead, behind }
}

/**
 * Parse the NUL-separated `XY PATH` records of `--porcelain=v1 -z`. In `-z`
 * mode a rename/copy record is `XY NEW\0ORIG\0`, so the original path is the
 * following record.
 */
function parseStatusEntries(records: string[]): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record.length < 3) continue
    const index = record[0]
    const worktree = record[1]
    const path = record.slice(3)
    const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
    if (renamed && i + 1 < records.length) {
      const origPath = records[i + 1]
      i += 1
      entries.push({ path, index, worktree, origPath })
    } else {
      entries.push({ path, index, worktree })
    }
  }
  return entries
}

// ─── diff ─────────────────────────────────────────────────────────────────

const DIFF_CHAR_LIMIT = 200_000
const DIFF_TRUNCATION_NOTE = `\n[diff truncated at ${DIFF_CHAR_LIMIT} characters]\n`

export interface GitDiffOptions {
  paths?: string[]
  staged?: boolean
}

function capDiff(value: string): string {
  if (value.length <= DIFF_CHAR_LIMIT) return value
  return value.slice(0, DIFF_CHAR_LIMIT - DIFF_TRUNCATION_NOTE.length) + DIFF_TRUNCATION_NOTE
}

/** Unified diff for an untracked file, falling back to a new-file summary. */
async function untrackedDiff(cwd: string, file: string): Promise<string> {
  const result = await runGit(cwd, ['diff', '--no-index', '--', '/dev/null', file])
  if (result.stdout.trim().length > 0) return result.stdout
  return `diff --git a/${file} b/${file}\nnew file: ${file}\n`
}

// ─── commit ───────────────────────────────────────────────────────────────

export interface GitCommitFilesInput {
  message: string
  files: string[]
}

export interface GitCommitFilesResult {
  hash: string
  branch: string | null
  files: string[]
  shortstat: string
}

function assertRelativeForwardSlashPath(file: unknown): asserts file is string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new VcsError('invalid_path', 'Every file must be a non-empty relative path.')
  }
  if (file.includes('\\')) {
    throw new VcsError('invalid_path', `Path must use forward slashes: ${file}`)
  }
  if (posix.isAbsolute(file) || /^[A-Za-z]:/u.test(file)) {
    throw new VcsError('invalid_path', `Path must be cwd-relative: ${file}`)
  }
  if (file.split('/').some((segment) => segment === '..')) {
    throw new VcsError('invalid_path', `Path must not contain '..' segments: ${file}`)
  }
}

async function stagedPaths(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
  if (result.code !== 0) {
    throw new VcsError('git_status_failed', result.stderr.trim() || 'git diff --cached failed')
  }
  return result.stdout.split('\0').filter((path) => path.length > 0)
}

// ─── push / pull ──────────────────────────────────────────────────────────

export interface GitPushOptions {
  requireClean: boolean
}

export interface GitPushSuccess {
  branch: string
  remote: 'origin'
  pushed: true
  head?: string
  summary: string
}

export interface GitPushFailure {
  pushed: false
  reason: string
  summary: string
  error?: string
  branch?: string
}

export type GitPushResult = GitPushSuccess | GitPushFailure

export interface GitPullSuccess {
  branch: string
  remote: 'origin'
  pulled: true
  summary: string
}

export interface GitPullFailure {
  pulled: false
  reason: string
  summary: string
  error?: string
  branch?: string
}

export type GitPullResult = GitPullSuccess | GitPullFailure

async function isGitWorkTree(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return result.code === 0 && result.stdout.trim() === 'true'
}

async function attachedBranch(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() || null : null
}

async function isClean(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['status', '--porcelain'])
  return result.code === 0 && result.stdout.trim() === ''
}

async function hasRemote(cwd: string, remote: string): Promise<boolean> {
  const result = await runGit(cwd, ['remote', 'get-url', remote])
  return result.code === 0
}

export interface GitRepositoryOptions {
  ownRoot?: boolean
}

/**
 * One git repository rooted at `root`. With `ownRoot: true` every method first
 * asserts the root holds its own git repository, failing with
 * `workspace_not_repository` when it does not.
 */
export class GitRepository {
  private readonly root: string
  private readonly ownRoot: boolean

  constructor(root: string, options: GitRepositoryOptions = {}) {
    this.root = root
    this.ownRoot = options.ownRoot === true
  }

  /**
   * Refuse version control unless `root` holds its own git repository: its
   * resolved toplevel (`git rev-parse --show-toplevel`) must canonicalize to
   * `root` itself, never an ancestor. Path case is folded on Windows.
   *
   * Resolves the toplevel on every call and never caches the result, so a
   * later `git init` in the workspace takes effect. The parent path is never
   * revealed in the error.
   */
  private async assertOwnRoot(): Promise<void> {
    if (!this.ownRoot) return
    const failure = new VcsError('workspace_not_repository', 'The workspace has no git repository of its own.')
    const result = await runGit(this.root, ['rev-parse', '--show-toplevel'])
    if (result.code !== 0) throw failure
    let ownReal: string
    let toplevelReal: string
    try {
      ownReal = realpathSync(this.root)
      toplevelReal = realpathSync(result.stdout.trim())
    } catch {
      throw failure
    }
    const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
    if (fold(ownReal) !== fold(toplevelReal)) throw failure
  }

  /** Working-tree status of the checkout. */
  async status(): Promise<GitStatus> {
    await this.assertOwnRoot()
    const cwd = this.root
    const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
    if (result.code !== 0) {
      throw new VcsError('git_status_failed', result.stderr.trim() || `git status failed in ${cwd}`)
    }

    const records = result.stdout.split('\0').filter((record) => record.length > 0)
    let header = ''
    let body = records
    if (records[0]?.startsWith('## ')) {
      header = records[0]
      body = records.slice(1)
    }
    const { branch, upstream, ahead, behind } = parseBranchHeader(header)

    const headResult = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])
    const head = headResult.code === 0 ? headResult.stdout.trim() || null : null

    return {
      branch,
      head,
      upstream,
      ahead,
      behind,
      entries: parseStatusEntries(body),
    }
  }

  /** Unified diff of the checkout, including untracked files when paths are given. */
  async diff(options: GitDiffOptions = {}): Promise<string> {
    await this.assertOwnRoot()
    const cwd = this.root
    const paths = options.paths?.filter((path) => typeof path === 'string' && path.length > 0) ?? []
    const args = ['diff']
    if (options.staged) args.push('--cached')
    args.push('--')
    if (paths.length > 0) args.push(...paths)

    const result = await runGit(cwd, args)
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new VcsError('git_diff_failed', result.stderr.trim() || `git diff failed in ${cwd}`)
    }

    let output = result.stdout
    if (paths.length > 0) {
      const status = await this.status()
      const untracked = paths.filter((path) =>
        status.entries.some((entry) => entry.worktree === '?' && entry.path === path),
      )
      for (const file of untracked) {
        output += await untrackedDiff(cwd, file)
      }
    }
    return capDiff(output)
  }

  /**
   * Stage exactly `files`, verify the staged set matches, then commit. Any
   * mismatch is reverted with `git reset -q -- <files>` before failing, so a
   * partially staged index never survives a refused commit.
   */
  async commitFiles(input: GitCommitFilesInput): Promise<GitCommitFilesResult> {
    await this.assertOwnRoot()
    const cwd = this.root
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (!message) {
      throw new VcsError('invalid_message', 'Commit message must not be empty.')
    }

    const files = Array.isArray(input.files) ? input.files : []
    if (files.length === 0) {
      throw new VcsError('invalid_files', 'At least one file is required.')
    }
    if (new Set(files).size !== files.length) {
      throw new VcsError('invalid_files', `Duplicate files are not allowed: ${files.join(', ')}`)
    }
    for (const file of files) assertRelativeForwardSlashPath(file)

    const status = await this.status()
    const known = new Set<string>()
    for (const entry of status.entries) {
      known.add(entry.path)
      if (entry.origPath) known.add(entry.origPath)
    }
    const unchanged = files.filter((file) => !known.has(file))
    if (unchanged.length > 0) {
      throw new VcsError('file_unchanged', `No changes to commit for: ${unchanged.join(', ')}`)
    }

    const fileSet = new Set(files)
    const foreign = (await stagedPaths(cwd)).filter((path) => !fileSet.has(path))
    if (foreign.length > 0) {
      throw new VcsError('foreign_staged', `Unrelated paths are already staged: ${foreign.join(', ')}`)
    }

    const add = await runGit(cwd, ['add', '-A', '--', ...files])
    if (add.code !== 0) {
      throw new VcsError('add_failed', add.stderr.trim() || 'git add failed')
    }

    const stagedSet = new Set(await stagedPaths(cwd))
    const missing = files.filter((file) => !stagedSet.has(file))
    const extra = [...stagedSet].filter((path) => !fileSet.has(path))
    if (missing.length > 0 || extra.length > 0 || stagedSet.size !== fileSet.size) {
      await runGit(cwd, ['reset', '-q', '--', ...files])
      throw new VcsError(
        'staged_mismatch',
        `Staged set does not match the requested files. Missing: [${missing.join(', ')}]; extra: [${extra.join(', ')}]`,
      )
    }

    const commit = await runGit(cwd, ['commit', '-m', message])
    if (commit.code !== 0) {
      throw new VcsError('commit_failed', commit.stderr.trim() || commit.stdout.trim() || 'git commit failed')
    }

    const hash = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
    const branch = await attachedBranch(cwd)
    const shortstat = (await runGit(cwd, ['show', '--shortstat', '--format=', 'HEAD'])).stdout.trim()
    return { hash, branch, files, shortstat }
  }

  /** Push the current attached branch to origin only; never force or push tags. */
  async push(options: GitPushOptions): Promise<GitPushResult> {
    await this.assertOwnRoot()
    const cwd = this.root
    if (!(await isGitWorkTree(cwd))) {
      return { pushed: false, reason: 'not_git_repository', error: `Path is not a git worktree: ${cwd}`, summary: `Push failed: not a git worktree.` }
    }
    const branch = await attachedBranch(cwd)
    if (!branch) {
      return { pushed: false, reason: 'detached_head', error: `Checkout is not on an attached branch: ${cwd}`, summary: `Push failed: detached HEAD.` }
    }
    if (options.requireClean && !(await isClean(cwd))) {
      return { pushed: false, branch, reason: 'dirty', error: `Checkout has uncommitted changes: ${cwd}`, summary: `Push failed: checkout is dirty.` }
    }
    if (!(await hasRemote(cwd, 'origin'))) {
      return { pushed: false, branch, reason: 'origin_missing', error: `Checkout has no origin remote: ${cwd}`, summary: `Push failed: no origin remote.` }
    }

    const push = await runGit(cwd, ['push', 'origin', branch])
    if (push.code !== 0) {
      const error = push.stderr.trim() || push.stdout.trim() || `git push failed for '${branch}'`
      return { pushed: false, branch, reason: 'push_failed', error, summary: `Push failed: ${error}` }
    }

    const head = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
    return { branch, remote: 'origin', pushed: true, head, summary: `Pushed branch ${branch} to origin.` }
  }

  /** Fast-forward pull the current attached branch from origin only. Requires a clean tree. */
  async pull(): Promise<GitPullResult> {
    await this.assertOwnRoot()
    const cwd = this.root
    if (!(await isGitWorkTree(cwd))) {
      return { pulled: false, reason: 'not_git_repository', error: `Path is not a git worktree: ${cwd}`, summary: `Pull failed: not a git worktree.` }
    }
    const branch = await attachedBranch(cwd)
    if (!branch) {
      return { pulled: false, reason: 'detached_head', error: `Checkout is not on an attached branch: ${cwd}`, summary: `Pull failed: detached HEAD.` }
    }
    if (!(await isClean(cwd))) {
      return { pulled: false, branch, reason: 'dirty', error: `Checkout has uncommitted changes: ${cwd}`, summary: `Pull failed: checkout is dirty.` }
    }
    if (!(await hasRemote(cwd, 'origin'))) {
      return { pulled: false, branch, reason: 'origin_missing', error: `Checkout has no origin remote: ${cwd}`, summary: `Pull failed: no origin remote.` }
    }

    const pull = await runGit(cwd, ['pull', '--ff-only', 'origin', branch])
    if (pull.code !== 0) {
      const error = pull.stderr.trim() || pull.stdout.trim() || `git pull failed for '${branch}'`
      return { pulled: false, branch, reason: 'pull_failed', error, summary: `Pull failed: ${error}` }
    }

    return { branch, remote: 'origin', pulled: true, summary: `Pulled branch ${branch} from origin.` }
  }

  /** Top level path of the repository (`git rev-parse --show-toplevel`). */
  async toplevel(): Promise<string> {
    await this.assertOwnRoot()
    const result = await runGit(this.root, ['rev-parse', '--show-toplevel'])
    return result.stdout.trim()
  }

  /** URL of the named remote, or null when it is not configured. */
  async remoteUrl(name = 'origin'): Promise<string | null> {
    await this.assertOwnRoot()
    const result = await runGit(this.root, ['remote', 'get-url', name])
    return result.code === 0 ? result.stdout.trim() || null : null
  }

  /**
   * The remote default branch (`refs/remotes/origin/HEAD`) with the 'origin/'
   * prefix stripped, falling back to the current branch when that fails.
   */
  async defaultBranch(): Promise<string | null> {
    await this.assertOwnRoot()
    const originHead = await runGit(this.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (originHead.code === 0) {
      const value = originHead.stdout.trim()
      if (value) return value.replace(/^origin\//u, '')
    }
    return attachedBranch(this.root)
  }

  /** True when the root is inside a git work tree (`git rev-parse --is-inside-work-tree`). */
  async isWorkTree(): Promise<boolean> {
    await this.assertOwnRoot()
    return isGitWorkTree(this.root)
  }
}
