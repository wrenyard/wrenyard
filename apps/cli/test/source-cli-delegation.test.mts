import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  readSourceDevLock,
  sourceDevLockRefusalMessage,
  sourceDevStopNotice,
} from '../src/source-dev-lock.mts'
import { delegateToSourceCli } from '../src/source-cli-delegation.mts'

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))

const DELEGATION_MODULE_PATH = join(CLI_DIR, 'src', 'source-cli-delegation.mts')
const DELEGATION_MODULE_URL = pathToFileURL(DELEGATION_MODULE_PATH).href
const TSX_LOADER_URL = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href

const DELEGATION_EVAL = [
  `import { delegateToSourceCli } from ${JSON.stringify(DELEGATION_MODULE_URL)};`,
  'process.exitCode = delegateToSourceCli(JSON.parse(process.env.ARGS)) ?? 99',
].join('\n')

const CHILD_SCRIPT = [
  'process.stdout.write(JSON.stringify({',
  '  args: process.argv.slice(2),',
  '  root: process.env.WRENYARD_ROOT ?? null,',
  '  nodeBin: process.env.WRENYARD_NODE_BIN ?? null,',
  '}))',
  'process.exit(7)',
].join('\n')

let stateDir: string
let childScriptPath: string
let previousStateHome: string | undefined

beforeEach(() => {
  previousStateHome = process.env.WRENYARD_STATE_HOME
  stateDir = mkdtempSync(join(tmpdir(), 'wrenyard-source-cli-test-'))
  process.env.WRENYARD_STATE_HOME = stateDir
  childScriptPath = join(stateDir, 'child.mjs')
  writeFileSync(childScriptPath, CHILD_SCRIPT)
})

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.WRENYARD_STATE_HOME
  else process.env.WRENYARD_STATE_HOME = previousStateHome
  rmSync(stateDir, { recursive: true, force: true })
})

function lockPath(): string {
  return join(stateDir, 'dev', 'dev.lock')
}

function writeLock(record: unknown): void {
  writeLockRaw(JSON.stringify(record))
}

function writeLockRaw(content: string): void {
  mkdirSync(join(stateDir, 'dev'), { recursive: true })
  writeFileSync(lockPath(), content)
}

function deadPid(): number {
  const probe = spawnSync(process.execPath, ['-e', ''])
  assert.equal(typeof probe.pid, 'number')
  assert.ok((probe.pid as number) > 0)
  return probe.pid as number
}

function runDelegation(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARGS: JSON.stringify(args),
    WRENYARD_ROOT: '/installed/suite',
    WRENYARD_NODE_BIN: '/installed/node',
    ...extraEnv,
  }
  if (!Object.hasOwn(extraEnv, 'WRENYARD_INSTALLED_CLI')) delete env.WRENYARD_INSTALLED_CLI
  return spawnSync(process.execPath, ['--import', TSX_LOADER_URL, '-e', DELEGATION_EVAL], {
    cwd: CLI_DIR,
    env,
    encoding: 'utf8',
  })
}

describe('readSourceDevLock', () => {
  it('returns undefined when the lock file is missing', () => {
    assert.equal(readSourceDevLock(), undefined)
  })

  it('returns undefined for malformed JSON', () => {
    writeLockRaw('{ not json')
    assert.equal(readSourceDevLock(), undefined)
  })

  it('returns undefined when the lock holder pid is dead', () => {
    writeLock({ pid: deadPid(), checkout: '/src/wrenyard', startedAt: '2026-09-24T00:00:00.000Z' })
    assert.equal(readSourceDevLock(), undefined)
  })

  it('returns pid and checkout for a live lock without exposing cli', () => {
    writeLock({ pid: process.pid, checkout: '/src/wrenyard', startedAt: '2026-09-24T00:00:00.000Z' })
    const lock = readSourceDevLock()
    assert.ok(lock)
    assert.equal(lock.pid, process.pid)
    assert.equal(lock.checkout, '/src/wrenyard')
    assert.equal(Object.hasOwn(lock, 'cli'), false)
  })

  it('includes a valid cli argv array', () => {
    const cli = [process.execPath, '/opt/wrenyard/cli.mjs']
    writeLock({ pid: process.pid, checkout: '/src/wrenyard', cli })
    const lock = readSourceDevLock()
    assert.ok(lock)
    assert.deepEqual(lock.cli, cli)
  })

  it('drops a cli value that is not an array', () => {
    writeLock({ pid: process.pid, checkout: '/src/wrenyard', cli: process.execPath })
    const lock = readSourceDevLock()
    assert.ok(lock)
    assert.equal(lock.cli, undefined)
  })

  it('drops a cli array with fewer than two entries', () => {
    writeLock({ pid: process.pid, checkout: '/src/wrenyard', cli: [process.execPath] })
    const lock = readSourceDevLock()
    assert.ok(lock)
    assert.equal(lock.cli, undefined)
  })

  it('drops a cli array containing an empty string', () => {
    writeLock({ pid: process.pid, checkout: '/src/wrenyard', cli: [process.execPath, ''] })
    const lock = readSourceDevLock()
    assert.ok(lock)
    assert.equal(lock.cli, undefined)
  })
})

describe('sourceDevLockRefusalMessage', () => {
  it('includes the holder pid and checkout', () => {
    const message = sourceDevLockRefusalMessage({ pid: 4321, checkout: '/src/wrenyard' })
    assert.match(message, /4321/u)
    assert.match(message, /\/src\/wrenyard/u)
  })
})

describe('sourceDevStopNotice', () => {
  it('points the human at pnpm dev restarting the daemon', () => {
    assert.match(sourceDevStopNotice(), /pnpm dev/u)
  })
})

describe('delegateToSourceCli', () => {
  it('delegates to a live source cli and returns its exit code', () => {
    writeLock({
      pid: process.pid,
      checkout: '/src/wrenyard',
      cli: [process.execPath, childScriptPath],
    })
    const result = runDelegation(['task', 'list', '--json'])
    assert.equal(result.status, 7, result.stderr)
    const payload = JSON.parse(result.stdout.trim())
    assert.deepEqual(payload.args, ['task', 'list', '--json'])
    assert.equal(payload.root, null)
    assert.equal(payload.nodeBin, null)
  })

  it('does not delegate when running as the installed cli', () => {
    writeLock({
      pid: process.pid,
      checkout: '/src/wrenyard',
      cli: [process.execPath, childScriptPath],
    })
    const result = runDelegation(['task', 'list', '--json'], { WRENYARD_INSTALLED_CLI: '1' })
    assert.equal(result.status, 99, result.stderr)
    assert.equal(result.stdout, '')
  })

  it('does not delegate when the lock holder pid is dead', () => {
    writeLock({
      pid: deadPid(),
      checkout: '/src/wrenyard',
      cli: [process.execPath, childScriptPath],
    })
    const result = runDelegation(['task', 'list', '--json'])
    assert.equal(result.status, 99, result.stderr)
    assert.equal(result.stdout, '')
  })

  it('does not delegate when the lock has no cli argv', () => {
    writeLock({ pid: process.pid, checkout: '/src/wrenyard' })
    const result = runDelegation(['task', 'list', '--json'])
    assert.equal(result.status, 99, result.stderr)
    assert.equal(result.stdout, '')
  })

  it('does not delegate when the cli script path does not exist', () => {
    writeLock({
      pid: process.pid,
      checkout: '/src/wrenyard',
      cli: [process.execPath, join(stateDir, 'missing-cli.mjs')],
    })
    const result = runDelegation(['task', 'list', '--json'])
    assert.equal(result.status, 99, result.stderr)
    assert.equal(result.stdout, '')
  })
})
