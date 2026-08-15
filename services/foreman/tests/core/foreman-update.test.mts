import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ForemanUpdateGit,
  ForemanUpdateGitError,
  makeForemanUpdateTempDir,
  removeForemanUpdateTempDir,
  type ForemanUpdateGitExecutor,
  type ForemanUpdateGitExecutorOptions,
  type ForemanUpdateGitExecutorOutput,
} from '../../lib/core/project/foreman-update.mts'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    removeForemanUpdateTempDir(tempRoots.pop() as string)
  }
})

function freshRoot(): string {
  const root = makeForemanUpdateTempDir()
  tempRoots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Wrenyard Tests',
    '-c', 'user.email=wrenyard-tests@example.invalid',
    ...args,
  ], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function gitOk(cwd: string, args: string[]): void {
  git(cwd, args)
}

function gitLines(cwd: string, args: string[]): string[] {
  return git(cwd, args).split(/\r?\n/u).filter(Boolean)
}

/** Build a bare origin and a seeded clone, push C0 (root) and C1 onto main. */
function buildOriginAndClone(root: string): { origin: string; clone: string; c0: string; c1: string } {
  const origin = join(root, 'origin.git')
  gitOk(root, ['init', '--bare', '-b', 'main', origin])

  const seed = join(root, 'seed')
  gitOk(root, ['init', '-b', 'main', seed])
  gitOk(seed, ['remote', 'add', 'origin', origin])
  writeFileSync(join(seed, 'f.txt'), 'c0\n')
  gitOk(seed, ['add', 'f.txt'])
  gitOk(seed, ['commit', '-m', 'c0'])
  writeFileSync(join(seed, 'f.txt'), 'c1\n')
  gitOk(seed, ['add', 'f.txt'])
  gitOk(seed, ['commit', '-m', 'c1'])
  gitOk(seed, ['push', 'origin', 'main'])

  const c0 = gitLines(seed, ['rev-list', '--max-parents=0', 'HEAD'])[0]
  const c1 = git(seed, ['rev-parse', 'HEAD']).trim()

  const clone = join(root, 'main')
  gitOk(root, ['clone', origin, clone])

  rmSync(seed, { recursive: true, force: true })
  return { origin, clone, c0, c1 }
}

/** A recording executor that runs real git and captures args/shell per call. */
function recordingExecutor(): { executor: ForemanUpdateGitExecutor; calls: Array<{ args: string[]; options: ForemanUpdateGitExecutorOptions }> } {
  const calls: Array<{ args: string[]; options: ForemanUpdateGitExecutorOptions }> = []
  const executor: ForemanUpdateGitExecutor = (args, options) => new Promise<ForemanUpdateGitExecutorOutput>((resolve, reject) => {
    calls.push({ args: [...args], options: { ...options } })
    try {
      const out = execFileSync('git', args as string[], {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: options.windowsHide,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      })
      resolve({ stdout: out, stderr: '' })
    } catch (error) {
      const err = error as Error & { status?: number; exitCode?: number; stdout?: string; stderr?: string; code?: string }
      const exitCode = err.exitCode ?? err.status ?? null
      reject(new ForemanUpdateGitError('git_failed', err.message, {
        exitCode,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }))
    }
  })
  return { executor, calls }
}

function headOf(path: string): string {
  return git(path, ['rev-parse', 'HEAD']).trim()
}

describe('ForemanUpdateGit preflight', () => {
  it('returns the real checkout root and full HEAD for a clean attached main and never pulls', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const expectedRoot = realpathSync(clone)
    const expectedHead = headOf(clone)

    const { executor, calls } = recordingExecutor()
    const updater = new ForemanUpdateGit(clone, { executor })

    const snapshot = await updater.preflight()

    assert.equal(snapshot.checkout_path, expectedRoot)
    assert.equal(snapshot.old_head, expectedHead)
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
    for (const call of calls) {
      assert.equal(call.options.shell, false)
      assert.ok(Array.isArray(call.args))
    }
  })

  it('rejects a path that is not a git repository', async () => {
    const root = freshRoot()
    const notRepo = join(root, 'notrepo')
    mkdirSync(notRepo, { recursive: true })
    const updater = new ForemanUpdateGit(notRepo)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'not_a_repository'
    })
  })

  it('rejects a nested path whose top-level differs', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const subdir = join(clone, 'sub')
    mkdirSync(subdir, { recursive: true })
    const updater = new ForemanUpdateGit(subdir)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'nested_checkout'
    })
  })

  it('rejects a detached HEAD', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    gitOk(clone, ['checkout', '--detach', 'HEAD'])
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'detached_head'
    })
  })

  it('rejects any branch other than main', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    gitOk(clone, ['checkout', '-b', 'develop'])
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'wrong_branch'
    })
  })

  it('rejects a dirty tracked file', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    writeFileSync(join(clone, 'f.txt'), 'dirty\n')
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'dirty_checkout'
    })
  })

  it('rejects staged changes', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    writeFileSync(join(clone, 'f.txt'), 'staged\n')
    gitOk(clone, ['add', 'f.txt'])
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'dirty_checkout'
    })
  })

  it('rejects an untracked file', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    writeFileSync(join(clone, 'untracked.txt'), 'hi\n')
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'dirty_checkout'
    })
  })

  it('rejects a missing origin remote', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    gitOk(clone, ['remote', 'remove', 'origin'])
    const updater = new ForemanUpdateGit(clone)
    await assert.rejects(() => updater.preflight(), (error: unknown) => {
      const err = error as ForemanUpdateGitError
      return err instanceof ForemanUpdateGitError && err.code === 'origin_missing'
    })
  })
})

describe('ForemanUpdateGit pullAfterDrain', () => {
  function snapshotFor(updater: ForemanUpdateGit, clone: string) {
    return updater.preflight()
  }

  it('fails before pulling when HEAD changed since the snapshot', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })
    gitOk(clone, ['reset', '--hard', 'HEAD~1'])

    const result = await checked.pullAfterDrain(snapshot)
    assert.equal(result.error_code, 'head_mismatch')
    assert.equal(result.new_head, undefined)
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
    assert.equal(headOf(clone), git(clone, ['rev-parse', `${snapshot.old_head}~1`]).trim())
  })

  it('fails before pulling when on a branch other than main', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })
    gitOk(clone, ['checkout', '-b', 'develop'])

    const result = await checked.pullAfterDrain(snapshot)
    assert.equal(result.error_code, 'wrong_branch')
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
  })

  it('fails before pulling when the worktree is dirty', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })
    writeFileSync(join(clone, 'f.txt'), 'dirty\n')

    const result = await checked.pullAfterDrain(snapshot)
    assert.equal(result.error_code, 'dirty_checkout')
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
  })

  it('runs exactly the ff-only pull, advances to remote, stays clean, and returns old/new heads', async () => {
    const root = freshRoot()
    const { origin, clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)
    const oldHead = snapshot.old_head

    // Advance origin/main from a second clone and push.
    const second = join(root, 'second')
    gitOk(root, ['clone', origin, second])
    writeFileSync(join(second, 'g.txt'), 'g\n')
    gitOk(second, ['add', 'g.txt'])
    gitOk(second, ['commit', '-m', 'c2'])
    gitOk(second, ['push', 'origin', 'main'])
    const newHead = headOf(second)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot)
    assert.equal(result.error_code, undefined)
    assert.equal(result.old_head, oldHead)
    assert.equal(result.new_head, newHead)
    assert.equal(headOf(clone), newHead)

    const pullCall = calls.find((call) => call.args[0] === 'pull')
    assert.ok(pullCall, 'expected a pull call')
    assert.deepEqual(pullCall?.args, ['pull', '--ff-only', 'origin', 'main'])
    assert.equal(pullCall?.options.shell, false)

    const status = git(clone, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
    assert.equal(status, '')
    assert.equal(git(clone, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main')
  })

  it('leaves local HEAD unchanged when the ff-only pull cannot fast-forward', async () => {
    const root = freshRoot()
    const { origin, clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)
    const beforeHead = headOf(clone)

    // Replace origin/main with an unrelated history so a ff-only pull cannot
    // fast-forward, while the local checkout stays clean, attached main exactly
    // at snapshot.old_head (no local commit after the snapshot).
    const divergent = join(root, 'divergent')
    gitOk(root, ['init', '-b', 'main', divergent])
    gitOk(divergent, ['remote', 'add', 'origin', origin])
    writeFileSync(join(divergent, 'other.txt'), 'other\n')
    gitOk(divergent, ['add', 'other.txt'])
    gitOk(divergent, ['commit', '-m', 'other'])
    gitOk(divergent, ['push', '--force', 'origin', 'main'])

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot)
    assert.equal(result.error_code, 'git_failed')
    assert.equal(result.new_head, undefined)
    assert.equal(headOf(clone), beforeHead)

    const pullCall = calls.find((call) => call.args[0] === 'pull')
    assert.ok(pullCall, 'expected a pull call')
    assert.deepEqual(pullCall?.args, ['pull', '--ff-only', 'origin', 'main'])
  })

  it('replays a persisted matching new_head without a second pull', async () => {
    const root = freshRoot()
    const { origin, clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    // Simulate the earlier pull having succeeded and persisted its new head.
    const second = join(root, 'second')
    gitOk(root, ['clone', origin, second])
    writeFileSync(join(second, 'g.txt'), 'g\n')
    gitOk(second, ['add', 'g.txt'])
    gitOk(second, ['commit', '-m', 'c2'])
    gitOk(second, ['push', 'origin', 'main'])
    const persistedNewHead = headOf(second)
    // Bring the checkout to that same head as if the earlier pull had landed.
    gitOk(clone, ['fetch', 'origin', 'main'])
    gitOk(clone, ['reset', '--hard', persistedNewHead])

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot, { recovery: { new_head: persistedNewHead } })
    assert.equal(result.error_code, undefined)
    assert.equal(result.new_head, persistedNewHead)
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
    assert.equal(headOf(clone), persistedNewHead)
  })

  it('reconciles via old-head ancestor + origin/main equality without a second pull', async () => {
    const root = freshRoot()
    const { origin, clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    const second = join(root, 'second')
    gitOk(root, ['clone', origin, second])
    writeFileSync(join(second, 'g.txt'), 'g\n')
    gitOk(second, ['add', 'g.txt'])
    gitOk(second, ['commit', '-m', 'c2'])
    gitOk(second, ['push', 'origin', 'main'])
    const newHead = headOf(second)
    gitOk(clone, ['fetch', 'origin', 'main'])
    gitOk(clone, ['reset', '--hard', newHead])

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot, { recovery: {} })
    assert.equal(result.error_code, undefined)
    assert.equal(result.new_head, newHead)
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
    assert.equal(headOf(clone), newHead)
  })

  it('rejects a mismatched persisted new_head', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot, { recovery: { new_head: 'deadbeef'.repeat(10) } })
    assert.equal(result.error_code, 'recovery_new_head_mismatch')
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
  })

  it('rejects a non-ancestor history during recovery', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)
    const c0 = gitLines(clone, ['rev-list', '--max-parents=0', 'HEAD'])[0]

    // Move main to the root commit, so the snapshot old_head is not an ancestor
    // while the branch stays attached and the checkout stays clean.
    gitOk(clone, ['reset', '--hard', c0])

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot, { recovery: {} })
    assert.equal(result.error_code, 'recovery_not_reconciled')
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
  })

  it('rejects when current head is not origin/main during recovery', async () => {
    const root = freshRoot()
    const { clone } = buildOriginAndClone(root)
    const updater = new ForemanUpdateGit(clone)
    const snapshot = await snapshotFor(updater, clone)

    // Make a local commit that is a descendant of old_head but not origin/main.
    writeFileSync(join(clone, 'local.txt'), 'local\n')
    gitOk(clone, ['add', 'local.txt'])
    gitOk(clone, ['commit', '-m', 'local'])
    const localHead = headOf(clone)

    const { executor, calls } = recordingExecutor()
    const checked = new ForemanUpdateGit(clone, { executor })

    const result = await checked.pullAfterDrain(snapshot, { recovery: {} })
    assert.equal(result.error_code, 'recovery_not_reconciled')
    assert.equal(result.new_head, undefined)
    assert.equal(headOf(clone), localHead)
    assert.equal(calls.some((call) => call.args[0] === 'pull'), false)
  })
})
