import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FOREMAN_UPDATE_GIT_MAX_BUFFER = 4 * 1024 * 1024
const FOREMAN_UPDATE_REQUIRED_BRANCH = 'main'
const FOREMAN_UPDATE_REMOTE = 'origin'
const FOREMAN_UPDATE_GIT_DIR_PREFIX = 'foreman-update-'

/**
 * A point-in-time proof that a checkout was on a clean, attached Foreman `main`
 * branch. Callers capture this before scheduling an update and later feed it to
 * `pullAfterDrain` so the pull only runs when the checkout is still where it was.
 */
export interface ForemanUpdateCheckoutSnapshot {
  checkout_path: string
  old_head: string
}

/**
 * Result of attempting the fast-forward pull after a drain. On success both
 * `old_head` and `new_head` are present. On a conservative failure the
 * `error_code`/`error_message` fields describe why the pull was skipped or
 * failed without mutating the checkout.
 */
export interface ForemanUpdatePullResult {
  old_head: string
  new_head?: string
  error_code?: string
  error_message?: string
}

/**
 * Options for replaying an update that was interrupted while a durably
 * persisted "updating" phase claimed ownership. When present, `pullAfterDrain`
 * may skip the pull only under the narrow reconciliation rules defined by the
 * caller contract.
 */
export interface ForemanUpdateRecovery {
  /** The new HEAD recorded by the interrupted update, if any. */
  new_head?: string
}

export interface ForemanUpdatePullOptions {
  recovery?: ForemanUpdateRecovery
}

export interface ForemanUpdateGitExecutorOptions {
  cwd: string
  shell: boolean
  windowsHide: boolean
}

export interface ForemanUpdateGitExecutorOutput {
  stdout: string
  stderr: string
}

/**
 * Injectable asynchronous Git runner. `args` are the raw `git` arguments and
 * must stay as discrete argv elements (no shell interpolation). The class
 * always passes `shell: false`.
 */
export type ForemanUpdateGitExecutor = (
  args: readonly string[],
  options: ForemanUpdateGitExecutorOptions,
) => Promise<ForemanUpdateGitExecutorOutput>

export interface ForemanUpdateGitOptions {
  gitBin?: string
  executor?: ForemanUpdateGitExecutor
}

interface SpawnError extends Error {
  code?: string
  status?: number
  exitCode?: number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

/**
 * Normalized failure for any Git operation performed by `ForemanUpdateGit`.
 * `code` is a stable, internal identifier (not user-facing text) so callers can
 * branch on failure mode without parsing messages.
 */
export class ForemanUpdateGitError extends Error {
  readonly code: string
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string

  constructor(
    code: string,
    message: string,
    details: { exitCode?: number | null; stderr?: string; stdout?: string } = {},
  ) {
    super(message)
    this.name = 'ForemanUpdateGitError'
    this.code = code
    this.exitCode = details.exitCode ?? null
    this.stderr = details.stderr ?? ''
    this.stdout = details.stdout ?? ''
  }
}

function bufferToString(value: string | Buffer | undefined): string {
  if (value === undefined) return ''
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value
}

function createDefaultExecutor(gitBin: string): ForemanUpdateGitExecutor {
  return (args, options) => new Promise<ForemanUpdateGitExecutorOutput>((resolve, reject) => {
    execFile(
      gitBin,
      [...args],
      {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: options.windowsHide,
        maxBuffer: FOREMAN_UPDATE_GIT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          const spawnError = error as SpawnError
          const exitCode = spawnError.exitCode ?? spawnError.status ?? null
          const code = spawnError.code === 'ENOENT' ? 'git_not_found' : 'git_failed'
          reject(new ForemanUpdateGitError(code, spawnError.message, {
            exitCode,
            stdout: bufferToString(spawnError.stdout),
            stderr: bufferToString(spawnError.stderr),
          }))
          return
        }
        resolve({
          stdout: bufferToString(stdout),
          stderr: bufferToString(stderr),
        })
      },
    )
  })
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const err = error as Error & { stderr?: unknown; stdout?: unknown }
  const parts = [err.message || String(error)]
  const stderr = bufferToString(err.stderr as string | Buffer | undefined).trim()
  const stdout = bufferToString(err.stdout as string | Buffer | undefined).trim()
  if (stderr) parts.push(stderr)
  if (stdout) parts.push(stdout)
  return parts.join('\n')
}

/**
 * Strict, read-mostly gatekeeper around the Foreman `main` checkout. It proves
 * the checkout is a clean, attached `main` before an update is scheduled,
 * repeats that proof after drain, and runs exactly one fast-forward pull. It
 * never fetches, merges, rebases, resets, stashes, checks out, commits, pushes,
 * or rolls back on its own.
 */
export class ForemanUpdateGit {
  readonly checkoutPath: string

  private readonly gitBin: string
  private readonly executor: ForemanUpdateGitExecutor
  private readonly executorOptions: ForemanUpdateGitExecutorOptions

  constructor(checkoutPath: string, options: ForemanUpdateGitOptions = {}) {
    if (!checkoutPath || !checkoutPath.trim()) {
      throw new Error('ForemanUpdateGit requires a checkoutPath')
    }
    this.checkoutPath = checkoutPath
    this.gitBin = options.gitBin?.trim() || 'git'
    this.executorOptions = {
      cwd: this.checkoutPath,
      shell: false,
      windowsHide: true,
    }
    this.executor = options.executor ?? createDefaultExecutor(this.gitBin)
  }

  /**
   * Prove the checkout is a clean, attached Foreman `main` and return its
   * canonical root plus the full HEAD. Performs no fetch and no mutation.
   */
  async preflight(): Promise<ForemanUpdateCheckoutSnapshot> {
    const checkoutRoot = this.resolveCheckoutRoot()
    await this.requireCleanAttachedMain(checkoutRoot)
    const oldHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim()
    return { checkout_path: checkoutRoot, old_head: oldHead }
  }

  /**
   * After a drain, re-prove the admission conditions and run the fixed
   * fast-forward pull. On a normal attempt the current HEAD must still equal
   * `snapshot.old_head`. When `options.recovery` is supplied, the pull may be
   * skipped under the narrow reconciliation rules; otherwise it fails closed.
   */
  async pullAfterDrain(
    snapshot: ForemanUpdateCheckoutSnapshot,
    options: ForemanUpdatePullOptions = {},
  ): Promise<ForemanUpdatePullResult> {
    try {
      const checkoutRoot = this.resolveCheckoutRoot()
      await this.requireCleanAttachedMain(checkoutRoot)

      if (options.recovery) {
        return await this.pullAfterDrainRecovery(snapshot, options.recovery)
      }

      const currentHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim()
      if (currentHead !== snapshot.old_head) {
        throw new ForemanUpdateGitError(
          'head_mismatch',
          `Current HEAD ${currentHead} does not equal snapshot old_head ${snapshot.old_head}`,
        )
      }

      await this.runGit(['pull', '--ff-only', FOREMAN_UPDATE_REMOTE, FOREMAN_UPDATE_REQUIRED_BRANCH])
      await this.requireCleanAttachedMain(checkoutRoot)

      const newHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim()
      return { old_head: snapshot.old_head, new_head: newHead }
    } catch (error) {
      const gitError = error instanceof ForemanUpdateGitError
        ? error
        : new ForemanUpdateGitError('git_failed', errorMessage(error))
      return {
        old_head: snapshot.old_head,
        error_code: gitError.code,
        error_message: gitError.message,
      }
    }
  }

  private async pullAfterDrainRecovery(
    snapshot: ForemanUpdateCheckoutSnapshot,
    recovery: ForemanUpdateRecovery,
  ): Promise<ForemanUpdatePullResult> {
    const currentHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim()

    if (recovery.new_head !== undefined) {
      if (currentHead !== recovery.new_head) {
        throw new ForemanUpdateGitError(
          'recovery_new_head_mismatch',
          `Current HEAD ${currentHead} does not match persisted new_head ${recovery.new_head}`,
        )
      }
      return { old_head: snapshot.old_head, new_head: currentHead }
    }

    const ancestorOutput = await this.tryRunGit([
      'merge-base', '--is-ancestor', snapshot.old_head, currentHead,
    ])
    const originMain = await this.tryRunGit(['rev-parse', '--verify', `refs/remotes/${FOREMAN_UPDATE_REMOTE}/${FOREMAN_UPDATE_REQUIRED_BRANCH}`])

    const reconciled = ancestorOutput !== null && originMain !== null && originMain === currentHead
    if (!reconciled) {
      throw new ForemanUpdateGitError(
        'recovery_not_reconciled',
        `Checkout cannot be safely resumed without a pull: snapshot old_head is not an ancestor of ` +
        `current HEAD, or current HEAD does not equal ${FOREMAN_UPDATE_REMOTE}/${FOREMAN_UPDATE_REQUIRED_BRANCH}`,
      )
    }

    return { old_head: snapshot.old_head, new_head: currentHead }
  }

  private resolveCheckoutRoot(): string {
    try {
      return realpathSync(this.checkoutPath)
    } catch {
      throw new ForemanUpdateGitError('checkout_missing', `Checkout path does not exist: ${this.checkoutPath}`)
    }
  }

  private async requireCleanAttachedMain(checkoutRoot: string): Promise<void> {
    let topLevelRaw: string
    try {
      topLevelRaw = (await this.runGit(['rev-parse', '--show-toplevel'])).trim()
    } catch {
      throw new ForemanUpdateGitError('not_a_repository', `Path is not inside a git repository: ${this.checkoutPath}`)
    }

    let topLevel: string
    try {
      topLevel = realpathSync(topLevelRaw)
    } catch {
      throw new ForemanUpdateGitError('not_a_repository', `git top-level is not resolvable: ${topLevelRaw}`)
    }
    if (topLevel !== checkoutRoot) {
      throw new ForemanUpdateGitError(
        'nested_checkout',
        `Checkout ${checkoutRoot} is not the git top-level directory (top-level is ${topLevel})`,
      )
    }

    const branch = await this.tryRunGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch === null) {
      throw new ForemanUpdateGitError('detached_head', `Checkout ${checkoutRoot} is in a detached HEAD state`)
    }
    if (branch !== FOREMAN_UPDATE_REQUIRED_BRANCH) {
      throw new ForemanUpdateGitError(
        'wrong_branch',
        `Checkout is on branch '${branch}', expected '${FOREMAN_UPDATE_REQUIRED_BRANCH}'`,
      )
    }

    const status = (await this.runGit(['status', '--porcelain=v1', '--untracked-files=all'])).trim()
    if (status) {
      throw new ForemanUpdateGitError('dirty_checkout', `Checkout has uncommitted changes:\n${status}`)
    }

    try {
      await this.runGit(['remote', 'get-url', FOREMAN_UPDATE_REMOTE])
    } catch {
      throw new ForemanUpdateGitError('origin_missing', `Checkout has no '${FOREMAN_UPDATE_REMOTE}' remote: ${checkoutRoot}`)
    }
  }

  private async runGit(args: readonly string[]): Promise<string> {
    const { stdout } = await this.executor(args, this.executorOptions)
    return stdout
  }

  private async tryRunGit(args: readonly string[]): Promise<string | null> {
    try {
      return (await this.runGit(args)).trim()
    } catch {
      return null
    }
  }
}

/** Test/helper utility: create a throwaway temp directory scoped to foreman-update. */
export function makeForemanUpdateTempDir(): string {
  return mkdtempSync(join(tmpdir(), FOREMAN_UPDATE_GIT_DIR_PREFIX))
}

/** Test/helper utility: remove a temp directory created by {@link makeForemanUpdateTempDir}. */
export function removeForemanUpdateTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
