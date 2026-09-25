import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  acquireInstanceLock,
  readLiveInstanceLock,
  releaseInstanceLock,
  type InstanceLockRecord,
} from '../../lib/daemon/instance-lock.mts'

const tempDirs: string[] = []
const liveChildren: ChildProcess[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wy-instance-lock-'))
  tempDirs.push(dir)
  return dir
}

function makeRecord(overrides: Partial<InstanceLockRecord> = {}): InstanceLockRecord {
  return { pid: process.pid, mode: 'source', startedAt: '2026-09-25T00:00:00.000Z', ...overrides }
}

async function spawnLiveChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  liveChildren.push(child)
  await once(child, 'spawn')
  return child
}

async function spawnExitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.ok(child.pid)
  return child.pid
}

function writeRecord(path: string, record: InstanceLockRecord): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`)
}

afterEach(() => {
  for (const child of liveChildren.splice(0)) child.kill('SIGKILL')
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('instance lock', () => {
  it('writes one JSON line and creates missing parent directories', () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'nested', 'deeper', 'daemon.lock')
    const record = makeRecord()

    acquireInstanceLock(lockPath, record)

    const contents = readFileSync(lockPath, 'utf8')
    assert.equal(contents, `${JSON.stringify(record)}\n`)
    const lines = contents.split('\n').filter((line) => line.length > 0)
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0]), record)
  })

  it('refuses a lock held by another live process', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'daemon.lock')
    const child = await spawnLiveChild()
    try {
      writeRecord(lockPath, makeRecord({ pid: child.pid! }))

      let caught: unknown
      try {
        acquireInstanceLock(lockPath, makeRecord())
      } catch (error) {
        caught = error
      }

      assert.ok(caught instanceof Error)
      assert.match(caught.message, new RegExp(`pid ${child.pid}\\b`))
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('takes over a lock whose pid is dead', async () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'daemon.lock')
    const deadPid = await spawnExitedChildPid()
    writeRecord(lockPath, makeRecord({ pid: deadPid }))

    acquireInstanceLock(lockPath, makeRecord())

    const written = JSON.parse(readFileSync(lockPath, 'utf8')) as InstanceLockRecord
    assert.equal(written.pid, process.pid)
  })

  it('treats unparsable content as stale and takes over', () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'daemon.lock')
    writeFileSync(lockPath, 'not json')

    acquireInstanceLock(lockPath, makeRecord())

    const written = JSON.parse(readFileSync(lockPath, 'utf8')) as InstanceLockRecord
    assert.equal(written.pid, process.pid)
  })

  it('refuses a second acquire in the same process', () => {
    const dir = makeTempDir()
    const lockPath = join(dir, 'daemon.lock')
    acquireInstanceLock(lockPath, makeRecord())

    assert.throws(() => acquireInstanceLock(lockPath, makeRecord()), Error)
  })

  it('releases only a lock that records this process', async () => {
    const dir = makeTempDir()
    const ownedPath = join(dir, 'owned.lock')
    acquireInstanceLock(ownedPath, makeRecord())
    releaseInstanceLock(ownedPath)
    assert.equal(existsSync(ownedPath), false)

    const foreignPath = join(dir, 'foreign.lock')
    const child = await spawnLiveChild()
    try {
      writeRecord(foreignPath, makeRecord({ pid: child.pid! }))
      releaseInstanceLock(foreignPath)
      assert.equal(existsSync(foreignPath), true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('reads a live lock and ignores missing or dead ones', async () => {
    const dir = makeTempDir()
    assert.equal(readLiveInstanceLock(join(dir, 'missing.lock')), undefined)

    const deadPath = join(dir, 'dead.lock')
    const deadPid = await spawnExitedChildPid()
    writeRecord(deadPath, makeRecord({ pid: deadPid }))
    assert.equal(readLiveInstanceLock(deadPath), undefined)

    const livePath = join(dir, 'live.lock')
    const live = makeRecord()
    writeRecord(livePath, live)
    assert.deepEqual(readLiveInstanceLock(livePath), live)
  })
})
