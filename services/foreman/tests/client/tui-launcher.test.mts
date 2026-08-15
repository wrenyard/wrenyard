import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchTui, defaultSpawnSync } from '../../lib/client/cli/tui-launcher.mts'
import type { SpawnSyncFn } from '../../lib/client/cli/tui-launcher.mts'

function captureConsoleError(): [() => void, string[]] {
  const messages: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { messages.push(args.join(' ')) }
  return [() => { console.error = original }, messages]
}

test('launchTui spawns foreman-tui with zero args, shell:false, stdio:inherit', () => {
  let capturedCommand: string | undefined
  let capturedArgs: string[] | undefined
  let capturedOptions: import('node:child_process').SpawnSyncOptions | undefined

  const mockSpawn: SpawnSyncFn = (
    command,
    args,
    options,
  ) => {
    capturedCommand = command
    capturedArgs = [...args]
    capturedOptions = options
    return { status: 0, signal: null }
  }

  const code = launchTui(mockSpawn)

  assert.equal(capturedCommand, 'foreman-tui')
  assert.deepEqual(capturedArgs, [])
  assert.equal(capturedOptions?.shell, false)
  assert.equal(capturedOptions?.stdio, 'inherit')
  assert.equal(code, 0)
})

test('launchTui returns child exit code directly', () => {
  const mockSpawn = () => ({ status: 42, signal: null })
  assert.equal(launchTui(mockSpawn), 42)
})

test('launchTui converts missing executable to explicit guidance', () => {
  const [restore, messages] = captureConsoleError()
  try {
    const missingExecutable = new Error('spawn foreman-tui ENOENT') as NodeJS.ErrnoException
    missingExecutable.code = 'ENOENT'
    const mockSpawn = () => ({ status: null, signal: null, error: missingExecutable })

    assert.equal(launchTui(mockSpawn), 1)
    assert.ok(
      messages.some((m) => m.includes('foreman-tui') && m.includes('not found') && m.includes('Install')),
      'should contain ENOENT guidance',
    )
  } finally {
    restore()
  }
})

test('launchTui returns 1 on signal-only termination', () => {
  const [restore, messages] = captureConsoleError()
  try {
    const mockSpawn = () => ({ status: null, signal: 'SIGKILL' as NodeJS.Signals, error: undefined })
    assert.equal(launchTui(mockSpawn), 1)
    assert.ok(messages.some((m) => m.includes('SIGKILL')), 'should log signal termination')
  } finally {
    restore()
  }
})

test('launchTui returns 1 when status is null with no signal or error', () => {
  const mockSpawn = () => ({ status: null, signal: null })
  assert.equal(launchTui(mockSpawn), 1)
})

test('launchTui returns 1 when spawn throws synchronously', () => {
  const [restore, messages] = captureConsoleError()
  try {
    const mockSpawn = () => {
      throw new Error('sync launch failure')
    }

    assert.equal(launchTui(mockSpawn), 1)
    assert.ok(
      messages.some((m) => m.includes('Failed to launch foreman-tui')),
      'sync spawn errors should be reported',
    )
  } finally {
    restore()
  }
})

test('defaultSpawnSync invokes child_process.spawnSync with process.execPath', () => {
  const result = defaultSpawnSync(
    process.execPath,
    ['--version'],
    { shell: false, stdio: 'pipe' },
  )
  assert.equal(result.status, 0)
  assert.equal(result.signal, null)
  assert.equal(result.error, undefined)
})
