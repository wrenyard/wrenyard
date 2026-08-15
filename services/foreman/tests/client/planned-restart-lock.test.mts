import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  acquirePlannedRestartLockAsync,
  PlannedRestartLockError,
} from '../../lib/client/cli/planned-restart-lock.mts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-lock-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('planned-restart-lock (malformed reclamation)', () => {
  it('reclaims a malformed lock file after the age threshold', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')
    // Write a malformed lock (no valid pid).
    writeFileSync(lockPath, 'garbage content\nno pid here\n', 'utf8')
    // Set the file's mtime to 60s ago so it's older than the 30s threshold.
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(lockPath, oldTime, oldTime)

    const lock = await acquirePlannedRestartLockAsync({
      stateRoot: dir,
      pollIntervalMs: 5,
      timeoutMs: 1000,
      reclaimAgeMs: 30_000,
      sleep: async () => {},
    })

    // The lock was acquired (our process created a new lock file).
    assert.ok(lock)
    const content = readFileSync(lockPath, 'utf8')
    assert.match(content, /pid=\d+/)
    assert.match(content, /token=[0-9a-f]+/)
    lock.release()
    assert.equal(existsSync(lockPath), false, 'release must unlink the lock')
  })

  it('does not reclaim a malformed lock before the age threshold', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')
    // Write a malformed lock (no valid pid), mtime is recent.
    writeFileSync(lockPath, 'garbage\n', 'utf8')

    // The acquire should time out because the malformed lock is too recent.
    await assert.rejects(
      acquirePlannedRestartLockAsync({
        stateRoot: dir,
        pollIntervalMs: 5,
        timeoutMs: 20,
        reclaimAgeMs: 30_000,
        sleep: async () => {},
      }),
      PlannedRestartLockError,
    )
  })
})

describe('planned-restart-lock (token-checked release)', () => {
  it('skips unlink when the token changed (someone else acquired)', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    const lock = await acquirePlannedRestartLockAsync({
      stateRoot: dir,
      pollIntervalMs: 5,
      timeoutMs: 100,
      sleep: async () => {},
    })
    assert.ok(lock)

    // Overwrite the lock file with a different token (simulating another
    // process reclaiming and re-creating the lock).
    writeFileSync(
      lockPath,
      `pid=99999\nts=${new Date().toISOString()}\ntoken=deadbeefdeadbeef\n`,
      'utf8',
    )

    // release() must NOT unlink because the token no longer matches.
    lock.release()
    assert.equal(existsSync(lockPath), true, 'release must not unlink a foreign lock')

    // Clean up.
    rmSync(lockPath, { force: true })
  })

  it('unlinks when the token matches (normal release)', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    const lock = await acquirePlannedRestartLockAsync({
      stateRoot: dir,
      pollIntervalMs: 5,
      timeoutMs: 100,
      sleep: async () => {},
    })
    assert.ok(lock)

    lock.release()
    assert.equal(existsSync(lockPath), false, 'release must unlink when token matches')
  })
})

describe('planned-restart-lock (stale reclaim with content change)', () => {
  it('a reclaimed stale lock blocks a second acquirer with a live pid', async () => {
    // Simulate the race outcome: process A reclaims a stale lock and creates
    // a new one. Process B sees the new live-pid lock and falls back to
    // waiting (times out). This verifies the byte-identical re-read in
    // tryReclaimStale prevents the loser from unlinked A's new lock.
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    // Create a stale lock with a dead pid.
    writeFileSync(
      lockPath,
      `pid=999999\nts=${new Date().toISOString()}\ntoken=aaaaaaaaaaaaaaaa\n`,
      'utf8',
    )

    // First acquire: reclaims the stale lock and creates a new one.
    const firstLock = await acquirePlannedRestartLockAsync({
      stateRoot: dir,
      pollIntervalMs: 5,
      timeoutMs: 100,
      sleep: async () => {},
    })
    assert.ok(firstLock)

    // The lock file now has the first acquire's token (not the stale one).
    const contentAfterFirst = readFileSync(lockPath, 'utf8')
    assert.ok(!contentAfterFirst.includes('token=aaaaaaaaaaaaaaaa'), 'stale content was replaced')
    assert.match(contentAfterFirst, /token=[0-9a-f]+/)

    // Second acquire: sees the first acquire's live-pid lock and times out.
    // (The first acquire's holder pid is our own process, which is alive.)
    await assert.rejects(
      acquirePlannedRestartLockAsync({
        stateRoot: dir,
        pollIntervalMs: 5,
        timeoutMs: 20,
        sleep: async () => {},
      }),
      PlannedRestartLockError,
    )

    // The first lock is still intact (the second acquire did not unlink it).
    assert.equal(existsSync(lockPath), true, 'first lock must still exist')
    const finalContent = readFileSync(lockPath, 'utf8')
    assert.equal(
      finalContent,
      contentAfterFirst,
      'first lock content must be unchanged (token-checked release protected it)',
    )

    firstLock.release()
  })
})

describe('planned-restart-lock (unlink error handling)', () => {
  it('times out when unlink throws EPERM instead of looping forever', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    // Create a stale lock with a dead pid so the acquire tries to reclaim it.
    writeFileSync(
      lockPath,
      `pid=999999\nts=${new Date().toISOString()}\ntoken=aaaaaaaaaaaaaaaa\n`,
      'utf8',
    )

    // Inject an unlink that always throws EPERM. The reclaim should fail
    // (return false), and the acquire should continue polling until the
    // timeout, then throw — NOT loop forever or report success.
    const failingUnlink = (): void => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }

    await assert.rejects(
      acquirePlannedRestartLockAsync({
        stateRoot: dir,
        pollIntervalMs: 5,
        timeoutMs: 30,
        sleep: async () => {},
        unlink: failingUnlink,
      }),
      PlannedRestartLockError,
    )

    // The stale lock file is still there (unlink never succeeded).
    assert.equal(existsSync(lockPath), true, 'stale lock must not have been removed')
  })
})

describe('planned-restart-lock (liveness age backstop)', () => {
  it('reclaims a lock with a live holder pid when mtime is older than 60s', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    // Create a lock with OUR OWN pid (alive) but an old mtime (120s ago).
    writeFileSync(
      lockPath,
      `pid=${process.pid}\nts=${new Date(Date.now() - 120_000).toISOString()}\ntoken=oldoldoldoldoldold\n`,
      'utf8',
    )
    const oldTime = new Date(Date.now() - 120_000)
    utimesSync(lockPath, oldTime, oldTime)

    // The acquire should reclaim the stale lock (age > 60s) despite the
    // holder pid being alive, and create a new lock.
    const lock = await acquirePlannedRestartLockAsync({
      stateRoot: dir,
      pollIntervalMs: 5,
      timeoutMs: 100,
      staleLivePidAgeMs: 60_000,
      sleep: async () => {},
    })

    assert.ok(lock, 'acquire must succeed by reclaiming the stale live-pid lock')
    const content = readFileSync(lockPath, 'utf8')
    assert.ok(!content.includes('token=oldoldoldoldoldold'), 'old lock content must be replaced')
    assert.match(content, /token=[0-9a-f]+/)
    lock.release()
  })

  it('does not reclaim a live-pid lock before the 60s age threshold', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'planned-restart.lock')

    // Create a lock with our own pid (alive) and a recent mtime.
    writeFileSync(
      lockPath,
      `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=recentrecentrecent\n`,
      'utf8',
    )

    // The acquire should time out because the live-pid lock is too recent.
    await assert.rejects(
      acquirePlannedRestartLockAsync({
        stateRoot: dir,
        pollIntervalMs: 5,
        timeoutMs: 20,
        staleLivePidAgeMs: 60_000,
        sleep: async () => {},
      }),
      PlannedRestartLockError,
    )

    // The lock is still there (not reclaimed).
    assert.equal(existsSync(lockPath), true)
    rmSync(lockPath, { force: true })
  })
})
