import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import {
  buildPlannedRestartCoordinatorInvocation,
  isCoordinatorAlive,
  launchPlannedRestartCoordinator,
  type CoordinatorSpawn,
  type PlannedRestartLauncherDispatch,
} from '../../lib/client/cli/planned-restart-launcher.mts'

const OPERATION_ID = 'op_restart_launcher_1'
const CONFIG_PATH = '/tmp/foreman-cfg/foreman.json'

// Isolate coordinator log writes to a temp state root for the whole file.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'foreman-launcher-test-'))
const OLD_STATE_HOME = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = STATE_DIR

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  killed: boolean
  unref: () => void
  kill: (signal?: NodeJS.Signals | number) => boolean
  __unrefed: () => boolean
}

function createFakeCoordinatorSpawn(): {
  spawn: CoordinatorSpawn
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>
  children: FakeChild[]
} {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  const children: FakeChild[] = []
  const spawn: CoordinatorSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    const child = new EventEmitter() as FakeChild
    Object.defineProperty(child, 'pid', { value: 4500, configurable: true })
    child.exitCode = null
    child.killed = false
    let unrefed = false
    child.unref = () => {
      unrefed = true
    }
    child.kill = (signal?: NodeJS.Signals | number) => {
      if (child.killed) return true
      child.killed = true
      queueMicrotask(() => child.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM'))
      return true
    }
    child.__unrefed = () => unrefed
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  }
  return { spawn, calls, children }
}

function makeFakeDispatch(): {
  dispatch: PlannedRestartLauncherDispatch
  begins: unknown[]
  updates: Array<{ op: string; patch: Record<string, unknown> }>
} {
  const begins: unknown[] = []
  const updates: Array<{ op: string; patch: Record<string, unknown> }> = []
  const dispatch: PlannedRestartLauncherDispatch = {
    status: () => ({
      mode: 'accepting',
      frozen: false,
      accepting: true,
      plannedRestart: null,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    }),
    updatePlannedRestart(op: string, patch: Record<string, unknown>) {
      updates.push({ op, patch })
    },
    completePlannedRestart() {},
    abortPlannedRestart() {},
    failPlannedRestart() {},
    beginPlannedRestart(plan: unknown) {
      begins.push(plan)
    },
  }
  return { dispatch, begins, updates }
}

const baseOptions = (overrides: Partial<Parameters<typeof launchPlannedRestartCoordinator>[0]> = {}) => ({
  operationId: OPERATION_ID,
  kind: 'restart' as const,
  resolvedConfigPath: CONFIG_PATH,
  ...overrides,
})

before(() => {
  process.env.XDG_STATE_HOME = STATE_DIR
})

after(() => {
  process.env.XDG_STATE_HOME = OLD_STATE_HOME
  rmSync(STATE_DIR, { recursive: true, force: true })
})

describe('buildPlannedRestartCoordinatorInvocation', () => {
  it('uses process.execPath with tsx loader in front of the private entrypoint', () => {
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions())
    assert.equal(inv.command, process.execPath)
    assert.equal(inv.args[0], '--require')
    assert.ok(inv.args[1].endsWith('tsx/dist/preflight.cjs'))
    assert.equal(inv.args[2], '--import')
    assert.ok(inv.args[3].endsWith('tsx/dist/loader.mjs'))
    assert.ok(inv.args[4].endsWith('lib/client/cli/planned-restart-coordinator-process.mts'))
  })

  it('emits separate non-shell arguments for operation id, kind, and config only', () => {
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions())
    const opIndex = inv.args.indexOf('--operation-id')
    assert.ok(opIndex >= 0)
    assert.equal(inv.args[opIndex + 1], OPERATION_ID)
    assert.equal(inv.args[inv.args.indexOf('--kind') + 1], 'restart')
    assert.equal(inv.args[inv.args.indexOf('--config') + 1], CONFIG_PATH)
  })

  it('passes host/port overrides as separate arguments', () => {
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions({ host: '127.0.0.1', port: '9999' }))
    assert.equal(inv.args[inv.args.indexOf('--host') + 1], '127.0.0.1')
    assert.equal(inv.args[inv.args.indexOf('--port') + 1], '9999')
  })

  it('omits --mode, --checkout-path, and --old-head (single mode, durable plan)', () => {
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions({ kind: 'update' }))
    assert.ok(!inv.args.includes('--mode'))
    assert.ok(!inv.args.includes('--checkout-path'))
    assert.ok(!inv.args.includes('--old-head'))
  })

  it('keeps spaced config paths as discrete non-shell arguments', () => {
    const spacedConfig = '/tmp/with space/foreman config.json'
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions({ resolvedConfigPath: spacedConfig }))
    assert.ok(inv.args.includes(spacedConfig), 'spaced path must survive as one argument')
  })

  it('resolves preflight/loader from the real tsx dependency root, not a hardcoded local node_modules literal', () => {
    const inv = buildPlannedRestartCoordinatorInvocation(baseOptions())
    const preflight = inv.args[inv.args.indexOf('--require') + 1]
    const loader = fileURLToPath(inv.args[inv.args.indexOf('--import') + 1])

    assert.ok(
      preflight.endsWith(join('tsx', 'dist', 'preflight.cjs')),
      `preflight must end with tsx/dist/preflight.cjs, got: ${preflight}`,
    )
    assert.ok(
      loader.endsWith(join('tsx', 'dist', 'loader.mjs')),
      `loader must end with tsx/dist/loader.mjs, got: ${loader}`,
    )
    assert.ok(existsSync(preflight), `preflight file must exist on disk: ${preflight}`)
    assert.ok(existsSync(loader), `loader file must exist on disk: ${loader}`)

    // Paths must come from dependency resolution (e.g. the pnpm store), not
    // from joining foremanDir with a literal node_modules/tsx segment.
    const hardcodedLocalTsx = join('services', 'foreman', 'node_modules', 'tsx')
    assert.ok(!preflight.includes(hardcodedLocalTsx), `preflight must not be a hardcoded local literal: ${preflight}`)
    assert.ok(!loader.includes(hardcodedLocalTsx), `loader must not be a hardcoded local literal: ${loader}`)
  })
})

describe('launchPlannedRestartCoordinator (construction)', () => {
  it('spawns a detached, non-shell, hidden child with file-backed stdout/stderr and no IPC', () => {
    const fake = createFakeCoordinatorSpawn()
    const result = launchPlannedRestartCoordinator(
      baseOptions(),
      { dispatchControl: makeFakeDispatch().dispatch, spawnProcess: fake.spawn },
    )

    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].command, process.execPath)
    assert.equal(fake.calls[0].options.shell, false)
    assert.equal(fake.calls[0].options.detached, true)
    assert.equal(fake.calls[0].options.windowsHide, true)
    const stdio = fake.calls[0].options.stdio as unknown[]
    assert.equal(stdio[0], 'ignore')
    assert.equal(typeof stdio[1], 'number', 'stdout must be a file descriptor')
    assert.equal(typeof stdio[2], 'number', 'stderr must be a file descriptor')
    assert.equal(stdio.length, 3, 'no IPC descriptor — stdio has only stdin/stdout/stderr')
  })

  it('returns the pid immediately without waiting for readiness', () => {
    const fake = createFakeCoordinatorSpawn()
    const result = launchPlannedRestartCoordinator(
      baseOptions(),
      { dispatchControl: makeFakeDispatch().dispatch, spawnProcess: fake.spawn },
    )

    assert.equal(result.pid, 4500)
    assert.ok(result.logPath.endsWith(`planned-restart-coordinator-${OPERATION_ID}.log`))
  })

  it('unrefs the child so it has no lifetime dependency on the caller', () => {
    const fake = createFakeCoordinatorSpawn()
    launchPlannedRestartCoordinator(
      baseOptions(),
      { dispatchControl: makeFakeDispatch().dispatch, spawnProcess: fake.spawn },
    )

    assert.equal(fake.children[0].__unrefed(), true)
  })
})

describe('launchPlannedRestartCoordinator (child environment)', () => {
  it('omits FOREMAN_TASK_RUN_ID but preserves sentinels and db/state variables', () => {
    const oldTaskRunId = process.env.FOREMAN_TASK_RUN_ID
    const oldDbPath = process.env.FOREMAN_DB_PATH
    const oldStateHome = process.env.XDG_STATE_HOME
    process.env.FOREMAN_TASK_RUN_ID = 'task-run-xyz'
    process.env.FOREMAN_DB_PATH = '/tmp/foreman-test.sqlite'
    process.env.SENTINEL_VAR = 'keep-me'
    process.env.XDG_STATE_HOME = STATE_DIR
    try {
      const fake = createFakeCoordinatorSpawn()
      launchPlannedRestartCoordinator(
        baseOptions(),
        { dispatchControl: makeFakeDispatch().dispatch, spawnProcess: fake.spawn },
      )

      const env = fake.calls[0].options.env as NodeJS.ProcessEnv
      assert.equal(env.FOREMAN_TASK_RUN_ID, undefined, 'caller task context must not leak into the coordinator')
      assert.equal(env.FOREMAN_CONFIG, CONFIG_PATH, 'resolved config must be set')
      assert.equal(env.FOREMAN_DB_PATH, '/tmp/foreman-test.sqlite')
      assert.equal(env.XDG_STATE_HOME, STATE_DIR)
      assert.equal(env.SENTINEL_VAR, 'keep-me')
    } finally {
      if (oldTaskRunId === undefined) delete process.env.FOREMAN_TASK_RUN_ID
      else process.env.FOREMAN_TASK_RUN_ID = oldTaskRunId
      if (oldDbPath === undefined) delete process.env.FOREMAN_DB_PATH
      else process.env.FOREMAN_DB_PATH = oldDbPath
      if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = oldStateHome
      delete process.env.SENTINEL_VAR
    }
  })
})

describe('launchPlannedRestartCoordinator (rejection cases)', () => {
  it('rejects on spawn error without plan activation', () => {
    const { dispatch, begins } = makeFakeDispatch()
    const spawnProcess: CoordinatorSpawn = () => {
      throw new Error('spawn boom')
    }
    assert.throws(
      () => launchPlannedRestartCoordinator(
        baseOptions(),
        { dispatchControl: dispatch, spawnProcess },
      ),
    )
    assert.equal(begins.length, 0)
  })

  it('rejects when the child does not expose a pid', () => {
    const { dispatch, begins } = makeFakeDispatch()
    const spawnProcess: CoordinatorSpawn = (() => {
      const child = new EventEmitter()
      Object.defineProperty(child, 'pid', { value: undefined, configurable: true })
      return child as unknown as ChildProcess
    }) as CoordinatorSpawn
    assert.throws(
      () => launchPlannedRestartCoordinator(
        baseOptions(),
        { dispatchControl: dispatch, spawnProcess },
      ),
    )
    assert.equal(begins.length, 0)
  })
})

describe('isCoordinatorAlive', () => {
  it('reports a nonexistent pid as not alive', () => {
    assert.equal(isCoordinatorAlive(-1), false)
    assert.equal(isCoordinatorAlive(9_999_999), false)
  })

  it('reports the current process as alive', () => {
    assert.equal(isCoordinatorAlive(process.pid), true)
  })
})
