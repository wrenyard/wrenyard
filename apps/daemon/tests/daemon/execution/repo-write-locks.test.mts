import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  RepoWriteLocks,
  requiresRepoWriteLock,
  type RepoRootResolver,
} from '../../../lib/daemon/execution/repo-write-locks.mts'

const IS_WINDOWS = process.platform === 'win32'

// Mirrors the production canonicalPath: resolve to an absolute path, and
// lowercase on native Windows (where path identity is case-insensitive).
function canonicalExpected(value: string): string {
  const absolute = resolve(value)
  return IS_WINDOWS ? absolute.toLowerCase() : absolute
}

describe('RepoWriteLocks', () => {
  let tempRepo: string
  let topLevel: string
  let foremanDir: string
  let forgeDir: string
  let foremanFile: string
  let forgeFile: string

  before(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'wren-repo-write-locks-'))
    // Git reports the long-form top level on Windows; mirror production
    // canonicalization so real-repo assertions hold on both platforms.
    topLevel = canonicalExpected(realpathSync.native(tempRepo))
    foremanDir = join(tempRepo, 'services', 'foreman')
    forgeDir = join(tempRepo, 'runtime', 'forge')
    mkdirSync(foremanDir, { recursive: true })
    mkdirSync(forgeDir, { recursive: true })
    foremanFile = join(foremanDir, 'src', 'a.ts')
    forgeFile = join(forgeDir, 'src', 'b.ts')
    execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' })
  })

  after(() => {
    rmSync(tempRepo, { recursive: true, force: true })
  })

  it('shares one repo-wide lock namespace across subdirs of a real git monorepo', () => {
    const locks = new RepoWriteLocks()

    assert.deepEqual(
      locks.tryAcquire(foremanDir, 'exec_foreman', 'edit', [foremanFile]),
      { acquired: true },
    )

    const holder = locks.isLocked(forgeDir)
    assert.ok(holder, 'a lock from another subdir must be visible at the git top level')
    if (holder) {
      assert.equal(holder.holderExecutionId, 'exec_foreman')
      assert.equal(holder.repoPath, topLevel)
    }

    const blocked = locks.tryAcquire(forgeDir, 'exec_yolo', 'yolo')
    assert.equal(blocked.acquired, false, 'a repo-wide writer from the other subdir must be blocked')
    if (!blocked.acquired) {
      assert.equal(blocked.holder.holderExecutionId, 'exec_foreman')
      assert.equal(blocked.holder.repoPath, topLevel)
    }

    assert.deepEqual(
      locks.tryAcquire(forgeDir, 'exec_forge', 'edit', [forgeFile]),
      { acquired: true },
      'disjoint exact file edits from both subdirs may coexist',
    )
    assert.equal(locks.isLocked(foremanDir)?.holderExecutionId, 'exec_foreman')
  })

  it('normalizes through an injected repo root resolver', () => {
    const resolver: RepoRootResolver = (repoPath) => (repoPath.startsWith('/mono/') ? '/mono' : repoPath)
    const locks = new RepoWriteLocks({ repoRootResolver: resolver })

    assert.deepEqual(
      locks.tryAcquire('/mono/services/foreman', 'exec_a', 'edit', ['/mono/services/foreman/a.ts']),
      { acquired: true },
    )
    const blocked = locks.tryAcquire('/mono/runtime/forge', 'exec_b', 'yolo')
    assert.equal(blocked.acquired, false)
    if (!blocked.acquired) {
      assert.equal(blocked.holder.holderExecutionId, 'exec_a')
      assert.equal(blocked.holder.repoPath, '/mono')
    }
  })

  it('holds one in-memory writer per repo path and releases by execution id', () => {
    const locks = new RepoWriteLocks()

    const app = canonicalExpected('/repo/app')
    const other = canonicalExpected('/repo/other')

    assert.deepEqual(locks.tryAcquire('/repo/app', 'exec_a', 'edit'), { acquired: true })
    const blocked = locks.tryAcquire('/repo/app', 'exec_b', 'yolo')

    assert.equal(blocked.acquired, false)
    if (!blocked.acquired) {
      assert.equal(blocked.holder.repoPath, app)
      assert.equal(blocked.holder.holderExecutionId, 'exec_a')
      assert.equal(blocked.holder.mode, 'edit')
    }

    assert.deepEqual(locks.tryAcquire('/repo/other', 'exec_c', 'edit'), { acquired: true })
    locks.releaseByExecution('exec_a')
    assert.deepEqual(locks.tryAcquire('/repo/app', 'exec_b', 'yolo'), { acquired: true })
    assert.equal(locks.isLocked('/repo/other')?.repoPath, other)
  })

  it('allows disjoint file-scoped edits in one repo while preserving exact conflicts', () => {
    const locks = new RepoWriteLocks()
    const repo = '/repo/app'
    const a = '/repo/app/src/a.ts'
    const b = '/repo/app/src/b.ts'
    const canonicalA = canonicalExpected(a)

    assert.deepEqual(locks.tryAcquire(repo, 'exec_a', 'edit', [a]), { acquired: true })
    assert.deepEqual(locks.tryAcquire(repo, 'exec_b', 'edit', [b]), { acquired: true })

    const sameTarget = locks.tryAcquire(repo, 'exec_same', 'edit', [a])
    assert.equal(sameTarget.acquired, false)
    if (!sameTarget.acquired) {
      assert.equal(sameTarget.holder.holderExecutionId, 'exec_a')
      assert.deepEqual(sameTarget.holder.targetPaths, [canonicalA])
    }

    const wideWriter = locks.tryAcquire(repo, 'exec_yolo', 'yolo')
    assert.equal(wideWriter.acquired, false)

    locks.releaseByExecution('exec_a')
    assert.equal(locks.tryAcquire(repo, 'exec_yolo', 'yolo').acquired, false,
      'a repo-wide writer must still conflict with the remaining scoped edit')
    locks.releaseByExecution('exec_b')
    assert.deepEqual(locks.tryAcquire(repo, 'exec_yolo', 'yolo'), { acquired: true })
  })

  it('normalizes equivalent target paths before conflict detection', () => {
    const locks = new RepoWriteLocks()
    const app = canonicalExpected('/repo/app')
    assert.deepEqual(
      locks.tryAcquire('/repo/app', 'exec_a', 'edit', ['/repo/app/src/../src/a.ts']),
      { acquired: true },
    )
    assert.equal(locks.isLocked('/repo/app')?.repoPath, app)
    assert.equal(
      locks.tryAcquire('/repo/app/', 'exec_b', 'edit', ['/repo/app/src/a.ts']).acquired,
      false,
    )
  })

  it('maps only write permissions to repo write locks', () => {
    assert.equal(requiresRepoWriteLock('readonly'), false)
    assert.equal(requiresRepoWriteLock('edit'), true)
    assert.equal(requiresRepoWriteLock('yolo'), true)
  })
})
