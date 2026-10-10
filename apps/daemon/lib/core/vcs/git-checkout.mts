/**
 * Pure git checkout helpers.
 *
 * Every helper takes an explicit checkout `cwd` and shells out to the `git`
 * binary through `execFile` (no shell, no interpolation). The helpers never
 * force anything: no `push --force`, no `branch -D`, no `commit -a`, and no
 * `--tags`. Staging is always limited to an explicit, validated file list.
 */

import { execFile, type ExecFileException } from 'node:child_process'
import { posix } from 'node:path'

/** Structured failure carrying a machine-readable `code` and a human message. */
export class GitCheckoutError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitCheckoutError'
    this.code = code
  }
}

interface GitRunResult {
  stdout: string
  stderr: string
  code: number
}

function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        let code = 0
        if (error) {
          const rawCode = (error as { code?: unknown }).code
          code = typeof rawCode === 'number' ? rawCode : 1
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
      },
    )
  })
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

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  if (result.code !== 0) {
    throw new GitCheckoutError('git_status_failed', result.stderr.trim() || `git status failed in ${cwd}`)
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

export async function gitDiff(cwd: string, options: GitDiffOptions = {}): Promise<string> {
  const paths = options.paths?.filter((path) => typeof path === 'string' && path.length > 0) ?? []
  const args = ['diff']
  if (options.staged) args.push('--cached')
  args.push('--')
  if (paths.length > 0) args.push(...paths)

  const result = await runGit(cwd, args)
  if (result.code !== 0 && result.stdout.length === 0) {
    throw new GitCheckoutError('git_diff_failed', result.stderr.trim() || `git diff failed in ${cwd}`)
  }

  let output = result.stdout
  if (paths.length > 0) {
    const status = await gitStatus(cwd)
    const untracked = paths.filter((path) =>
      status.entries.some((entry) => entry.worktree === '?' && entry.path === path),
    )
    for (const file of untracked) {
      output += await untrackedDiff(cwd, file)
    }
  }
  return capDiff(output)
}

// ─── commit ───────────────────────────────────────────────────────────────

export interface CommitExactFilesInput {
  message: string
  files: string[]
}

export interface CommitExactFilesResult {
  hash: string
  branch: string
  files: string[]
  shortstat: string
}

function assertRelativeForwardSlashPath(file: unknown): asserts file is string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new GitCheckoutError('invalid_path', 'Every file must be a non-empty relative path.')
  }
  if (file.includes('\\')) {
    throw new GitCheckoutError('invalid_path', `Path must use forward slashes: ${file}`)
  }
  if (posix.isAbsolute(file) || /^[A-Za-z]:/u.test(file)) {
    throw new GitCheckoutError('invalid_path', `Path must be cwd-relative: ${file}`)
  }
  if (file.split('/').some((segment) => segment === '..')) {
    throw new GitCheckoutError('invalid_path', `Path must not contain '..' segments: ${file}`)
  }
}

async function stagedPaths(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
  if (result.code !== 0) {
    throw new GitCheckoutError('git_status_failed', result.stderr.trim() || 'git diff --cached failed')
  }
  return result.stdout.split('\0').filter((path) => path.length > 0)
}

/**
 * Stage exactly `files`, verify the staged set matches, then commit. Any
 * mismatch is reverted with `git reset -q -- <files>` before failing, so a
 * partially staged index never survives a refused commit.
 */
export async function commitExactFiles(cwd: string, input: CommitExactFilesInput): Promise<CommitExactFilesResult> {
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) {
    throw new GitCheckoutError('invalid_message', 'Commit message must not be empty.')
  }

  const files = Array.isArray(input.files) ? input.files : []
  if (files.length === 0) {
    throw new GitCheckoutError('invalid_files', 'At least one file is required.')
  }
  if (new Set(files).size !== files.length) {
    throw new GitCheckoutError('invalid_files', `Duplicate files are not allowed: ${files.join(', ')}`)
  }
  for (const file of files) assertRelativeForwardSlashPath(file)

  const status = await gitStatus(cwd)
  const known = new Set<string>()
  for (const entry of status.entries) {
    known.add(entry.path)
    if (entry.origPath) known.add(entry.origPath)
  }
  const unchanged = files.filter((file) => !known.has(file))
  if (unchanged.length > 0) {
    throw new GitCheckoutError('file_unchanged', `No changes to commit for: ${unchanged.join(', ')}`)
  }

  const fileSet = new Set(files)
  const foreign = (await stagedPaths(cwd)).filter((path) => !fileSet.has(path))
  if (foreign.length > 0) {
    throw new GitCheckoutError('foreign_staged', `Unrelated paths are already staged: ${foreign.join(', ')}`)
  }

  const add = await runGit(cwd, ['add', '-A', '--', ...files])
  if (add.code !== 0) {
    throw new GitCheckoutError('add_failed', add.stderr.trim() || 'git add failed')
  }

  const stagedSet = new Set(await stagedPaths(cwd))
  const missing = files.filter((file) => !stagedSet.has(file))
  const extra = [...stagedSet].filter((path) => !fileSet.has(path))
  if (missing.length > 0 || extra.length > 0 || stagedSet.size !== fileSet.size) {
    await runGit(cwd, ['reset', '-q', '--', ...files])
    throw new GitCheckoutError(
      'staged_mismatch',
      `Staged set does not match the requested files. Missing: [${missing.join(', ')}]; extra: [${extra.join(', ')}]`,
    )
  }

  const commit = await runGit(cwd, ['commit', '-m', message])
  if (commit.code !== 0) {
    throw new GitCheckoutError('commit_failed', commit.stderr.trim() || commit.stdout.trim() || 'git commit failed')
  }

  const hash = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await attachedBranch(cwd)) ?? ''
  const shortstat = (await runGit(cwd, ['show', '--shortstat', '--format=', 'HEAD'])).stdout.trim()
  return { hash, branch, files, shortstat }
}

// ─── push / pull ──────────────────────────────────────────────────────────

export interface PushCheckoutOptions {
  requireClean: boolean
}

export interface PushCheckoutSuccess {
  branch: string
  remote: 'origin'
  pushed: true
  head: string
  summary: string
}

export interface PushCheckoutFailure {
  pushed: false
  code: string
  error: string
  summary: string
  branch?: string
}

export type PushCheckoutResult = PushCheckoutSuccess | PushCheckoutFailure

export interface PullCheckoutSuccess {
  branch: string
  remote: 'origin'
  pulled: true
  head: string
  summary: string
}

export interface PullCheckoutFailure {
  pulled: false
  code: string
  error: string
  summary: string
  branch?: string
}

export type PullCheckoutResult = PullCheckoutSuccess | PullCheckoutFailure

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

export async function pushCheckout(cwd: string, options: PushCheckoutOptions): Promise<PushCheckoutResult> {
  if (!(await isGitWorkTree(cwd))) {
    return { pushed: false, code: 'not_git_repository', error: `Path is not a git worktree: ${cwd}`, summary: `Push failed: not a git worktree.` }
  }
  const branch = await attachedBranch(cwd)
  if (!branch) {
    return { pushed: false, code: 'detached_head', error: `Checkout is not on an attached branch: ${cwd}`, summary: `Push failed: detached HEAD.` }
  }
  if (options.requireClean && !(await isClean(cwd))) {
    return { pushed: false, branch, code: 'dirty', error: `Checkout has uncommitted changes: ${cwd}`, summary: `Push failed: checkout is dirty.` }
  }
  if (!(await hasRemote(cwd, 'origin'))) {
    return { pushed: false, branch, code: 'origin_missing', error: `Checkout has no origin remote: ${cwd}`, summary: `Push failed: no origin remote.` }
  }

  const push = await runGit(cwd, ['push', 'origin', branch])
  if (push.code !== 0) {
    const error = push.stderr.trim() || push.stdout.trim() || `git push failed for '${branch}'`
    return { pushed: false, branch, code: 'push_failed', error, summary: `Push failed: ${error}` }
  }

  const head = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  return { branch, remote: 'origin', pushed: true, head, summary: `Pushed branch ${branch} to origin.` }
}

export async function pullCheckout(cwd: string): Promise<PullCheckoutResult> {
  if (!(await isGitWorkTree(cwd))) {
    return { pulled: false, code: 'not_git_repository', error: `Path is not a git worktree: ${cwd}`, summary: `Pull failed: not a git worktree.` }
  }
  const branch = await attachedBranch(cwd)
  if (!branch) {
    return { pulled: false, code: 'detached_head', error: `Checkout is not on an attached branch: ${cwd}`, summary: `Pull failed: detached HEAD.` }
  }
  if (!(await isClean(cwd))) {
    return { pulled: false, branch, code: 'dirty', error: `Checkout has uncommitted changes: ${cwd}`, summary: `Pull failed: checkout is dirty.` }
  }
  if (!(await hasRemote(cwd, 'origin'))) {
    return { pulled: false, branch, code: 'origin_missing', error: `Checkout has no origin remote: ${cwd}`, summary: `Pull failed: no origin remote.` }
  }

  const pull = await runGit(cwd, ['pull', '--ff-only', 'origin', branch])
  if (pull.code !== 0) {
    const error = pull.stderr.trim() || pull.stdout.trim() || `git pull failed for '${branch}'`
    return { pulled: false, branch, code: 'pull_failed', error, summary: `Pull failed: ${error}` }
  }

  const head = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  return { branch, remote: 'origin', pulled: true, head, summary: `Pulled branch ${branch} from origin.` }
}
