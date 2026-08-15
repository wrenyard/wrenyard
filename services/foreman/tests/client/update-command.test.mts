import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  handleUpdate,
  type ForemanUpdateCommandDeps,
} from '../../lib/client/cli/commands/update.mts'
import type {
  PlannedRestartPlan,
  PlannedRestartPlanSummary,
} from '../../lib/daemon/planned-restart-store.mts'
import { foremanDir, suiteDir, type ForemanStatus } from '../../lib/client/cli/shared.mts'
import { ForemanUpdateGit } from '../../lib/core/project/foreman-update.mts'
import { closeDb } from '../../lib/db/connection.mts'

const tempDirs: string[] = []
const UPDATE_OLD_HEAD = 'a'.repeat(40)
const UPDATE_NEW_HEAD = 'b'.repeat(40)

let oldDbPath: string | undefined
let oldTaskRunId: string | undefined

beforeEach(() => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'foreman-update-test-db-')), 'foreman.sqlite')
  oldDbPath = process.env.FOREMAN_DB_PATH
  oldTaskRunId = process.env.FOREMAN_TASK_RUN_ID
  process.env.FOREMAN_DB_PATH = dbPath
  delete process.env.FOREMAN_TASK_RUN_ID
  CONFIG = configPathFor()
})

afterEach(() => {
  closeDb()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (oldDbPath === undefined) delete process.env.FOREMAN_DB_PATH
  else process.env.FOREMAN_DB_PATH = oldDbPath
  if (oldTaskRunId === undefined) delete process.env.FOREMAN_TASK_RUN_ID
  else process.env.FOREMAN_TASK_RUN_ID = oldTaskRunId
})

// ── helpers ────────────────────────────────────────────────────────────────

function fakeStatus(operationId = 'op_update_test'): ForemanStatus {
  return {
    ok: true,
    config: { ok: true, path: '/cfg' },
    daemon: { running: true, process: 'foreman-daemon' },
    ipc: { ok: true },
    http: { ok: true },
    mcp: { ok: true },
    db: { ok: true },
    mode: 'planned_restart',
    operation_id: operationId,
    phase: 'verifying',
  } as ForemanStatus
}

interface FakeControl {
  dispatchControl: unknown
  store: unknown
  launchCalls: Array<Record<string, unknown>>
  beginCalls: PlannedRestartPlan[]
  updatePlannedRestartCalls: Array<[string, Record<string, unknown>]>
  abortCalls: string[]
  waitCalls: number
}

function makeFakeControl(state: {
  active: PlannedRestartPlanSummary | null
  plan: PlannedRestartPlan | null
  mode?: 'accepting' | 'frozen' | 'planned_restart'
}): FakeControl {
  const launchCalls: Array<Record<string, unknown>> = []
  const beginCalls: PlannedRestartPlan[] = []
  const updatePlannedRestartCalls: Array<[string, Record<string, unknown>]> = []
  const abortCalls: string[] = []
  const mode = state.mode ?? (state.active ? 'planned_restart' : 'accepting')
  const dispatchControl = {
    status() {
      return {
        mode,
        frozen: mode === 'frozen',
        accepting: mode === 'accepting',
        plannedRestart: mode === 'planned_restart' ? state.active : null,
        activeTasks: [],
        activeTaskCount: 0,
        activeWorkflows: [],
        activeWorkflowCount: 0,
        activeExecutions: [],
        activeExecutionCount: 0,
      }
    },
    updatePlannedRestart(op: string, patch: Record<string, unknown>) {
      updatePlannedRestartCalls.push([op, patch])
    },
    beginPlannedRestart(plan: PlannedRestartPlan) {
      beginCalls.push(plan)
    },
    completePlannedRestart() {},
    abortPlannedRestart(op: string) {
      abortCalls.push(op)
    },
    failPlannedRestart() {},
  }
  const store = {
    snapshot() {
      return { mode, plan: state.plan }
    },
  }
  return { dispatchControl, store, launchCalls, beginCalls, updatePlannedRestartCalls, abortCalls, waitCalls: 0 }
}

interface BuildOpts {
  state: {
    active: PlannedRestartPlanSummary | null
    plan: PlannedRestartPlan | null
    mode?: 'accepting' | 'frozen' | 'planned_restart'
  }
  operationId?: string
  isCoordinatorAlive?: (pid: number) => boolean
  terminal?: PlannedRestartPlanSummary | null
  status?: ForemanStatus
  commandEnv?: NodeJS.ProcessEnv
  foremanUpdateGit?: ForemanUpdateGit
}

function buildDeps(opts: BuildOpts): {
  deps: ForemanUpdateCommandDeps
  control: FakeControl
} {
  const fakeCheckoutDir = mkdtempSync(join(tmpdir(), 'foreman-update-fake-'))
  tempDirs.push(fakeCheckoutDir)
  const fakeUpdateGit = {
    preflight: async (): Promise<{ checkout_path: string; old_head: string }> => ({
      checkout_path: fakeCheckoutDir,
      old_head: UPDATE_OLD_HEAD,
    }),
  }
  const updateGit = opts.foremanUpdateGit ?? (fakeUpdateGit as unknown as ForemanUpdateGit)

  const control = makeFakeControl(opts.state)
  const deps: ForemanUpdateCommandDeps = {
    plannedRestartStore: control.store as never,
    dispatchControl: control.dispatchControl as never,
    foremanUpdateGit: updateGit,
    launchCoordinator: async (_d, options) => {
      control.launchCalls.push(options as unknown as Record<string, unknown>)
      return { pid: 9999 }
    },
    generateOperationId: () => opts.operationId ?? 'op_update_test',
    isCoordinatorAlive: opts.isCoordinatorAlive ?? (() => false),
    waitForPlanTerminal: async () => {
      control.waitCalls++
      return opts.terminal ?? null
    },
    collectForemanStatus: async () => opts.status ?? fakeStatus(),
    acquireLock: async () => ({ release: () => {} }),
    commandEnv: opts.commandEnv,
  }
  return { deps, control }
}

async function runCapture(
  deps: ForemanUpdateCommandDeps,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
  }
  try {
    const code = await handleUpdate(args, deps)
    return { code, stdout: logs.join('\n') }
  } finally {
    console.log = original
  }
}

// ── real git checkout helpers ───────────────────────────────────────────────

function gitInit(repo: string, branch = 'main'): void {
  execFileSync('git', ['init'], { cwd: repo, encoding: 'utf-8' })
  execFileSync('git', ['config', 'user.email', 'foreman@example.test'], { cwd: repo, encoding: 'utf-8' })
  execFileSync('git', ['config', 'user.name', 'Foreman Test'], { cwd: repo, encoding: 'utf-8' })
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo, encoding: 'utf-8' })
  writeFileSync(join(repo, 'README.md'), '# foreman\n', 'utf-8')
  execFileSync('git', ['add', 'README.md'], { cwd: repo, encoding: 'utf-8' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, encoding: 'utf-8' })
}

function makeCleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'foreman-update-clean-'))
  tempDirs.push(repo)
  gitInit(repo, 'main')
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/foreman.git'], { cwd: repo, encoding: 'utf-8' })
  return repo
}

function makeDirtyRepo(): string {
  const repo = makeCleanRepo()
  writeFileSync(join(repo, 'README.md'), '# modified\n', 'utf-8')
  return repo
}

function makeStagedRepo(): string {
  const repo = makeCleanRepo()
  writeFileSync(join(repo, 'staged.txt'), 'staged\n', 'utf-8')
  execFileSync('git', ['add', 'staged.txt'], { cwd: repo, encoding: 'utf-8' })
  return repo
}

function makeUntrackedRepo(): string {
  const repo = makeCleanRepo()
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n', 'utf-8')
  return repo
}

function makeDetachedRepo(): string {
  const repo = makeCleanRepo()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  execFileSync('git', ['checkout', head], { cwd: repo, encoding: 'utf-8' })
  return repo
}

function makeNonMainRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'foreman-update-feature-'))
  tempDirs.push(repo)
  gitInit(repo, 'feature')
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/foreman.git'], { cwd: repo, encoding: 'utf-8' })
  return repo
}

// ── config helper (minimal enabled service config) ─────────────────────────

function configPathFor(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-update-cfg-'))
  tempDirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({
    service: { enabled: true, bind: '127.0.0.1:18787', ipc: { path: join(dir, 'foreman.sock') } },
    workspace: {},
    pet: { enabled: false },
    message: { enabled: false },
    messageDelivery: { enabled: false },
  }), 'utf-8')
  return path
}

let CONFIG: string

// ── default checkout rooting (source/layout only; never pulls) ──────────────

test('default update checkout targets the Wrenyard suite root, not the foreman package', () => {
  assert.notEqual(suiteDir, foremanDir, 'suite root and package root must be distinct')
  assert.ok(foremanDir.endsWith('services/foreman'), 'foremanDir is the package root')
  assert.ok(foremanDir.startsWith(`${suiteDir}/`), 'the package lives inside the suite root')
  assert.ok(existsSync(join(suiteDir, 'pnpm-workspace.yaml')), 'suite root has pnpm-workspace.yaml')
  assert.ok(existsSync(join(suiteDir, 'release-manifest.json')), 'suite root has release-manifest.json')
})

// ── preflight rejection (real repos, real ForemanUpdateGit) ─────────────────

const PREFAILED_REPOS: Array<[string, () => string]> = [
  ['dirty', makeDirtyRepo],
  ['staged', makeStagedRepo],
  ['untracked', makeUntrackedRepo],
  ['detached', makeDetachedRepo],
  ['non-main', makeNonMainRepo],
]

for (const [name, makeRepo] of PREFAILED_REPOS) {
  test(`update rejects a ${name} checkout before scheduling, lifecycle, or wait`, async () => {
    const repo = makeRepo()
    const { deps, control } = buildDeps({
      state: { active: null, plan: null },
      commandEnv: { FOREMAN_TASK_RUN_ID: 'run_blocked' },
    })
    deps.foremanUpdateGit = new ForemanUpdateGit(repo)

    await assert.rejects(
      () => handleUpdate(['--config', CONFIG], deps),
      /uncommitted|detached|expected 'main'|not a repository|origin_missing|wrong_branch/i,
    )

    // No beginPlan, no spawn, no terminal wait, no lifecycle activation.
    assert.equal(control.beginCalls.length, 0)
    assert.equal(control.launchCalls.length, 0)
    assert.equal(control.updatePlannedRestartCalls.length, 0)
  })
}

test('update preflights a clean main checkout and supplies the snapshot to beginPlan', async () => {
  const repo = makeCleanRepo()
  const { deps, control } = buildDeps({
    state: { active: null, plan: null },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_clean' },
  })
  deps.foremanUpdateGit = new ForemanUpdateGit(repo)

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG])

  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  assert.equal(control.beginCalls.length, 1, 'fresh path must beginPlan before spawning')
  const plan = control.beginCalls[0]
  assert.equal(plan.kind, 'update')
  assert.equal(plan.phase, 'draining')
  assert.equal(plan.coordinator_pid, null)
  assert.equal(plan.checkout_path, realpathSync(repo))
  assert.ok(plan.old_head)
  // The pid is stamped via updatePlan after spawn.
  assert.equal(control.updatePlannedRestartCalls.length, 1)
  assert.deepEqual(control.updatePlannedRestartCalls[0][1], { coordinator_pid: 9999 })
  // Task context does not wait.
  assert.equal(control.waitCalls, 0)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['operation_id', 'scheduled', 'status_endpoint'])
  assert.equal((parsed as { scheduled: boolean }).scheduled, true)
  assert.equal((parsed as { status_endpoint: string }).status_endpoint, 'wrenyard status --json')
})

// ── task context scheduling ─────────────────────────────────────────────────

test('task context schedules without waiting and emits the scheduled JSON', async () => {
  const { deps, control } = buildDeps({
    state: { active: null, plan: null },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_123' },
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG])

  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  assert.equal(control.beginCalls.length, 1)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['operation_id', 'scheduled', 'status_endpoint'])
  assert.equal(parsed.scheduled, true)
  assert.equal(parsed.status_endpoint, 'wrenyard status --json')
})

test('task context with an empty FOREMAN_TASK_RUN_ID still schedules without waiting', async () => {
  const { deps, control } = buildDeps({
    state: { active: null, plan: null },
    commandEnv: { FOREMAN_TASK_RUN_ID: '' },
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG])

  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.equal(parsed.scheduled, true)
  assert.equal(parsed.status_endpoint, 'wrenyard status --json')
})

// ── human --no-wait presentation ────────────────────────────────────────────

test('human --no-wait emits the same scheduled value and follows --json presentation', async () => {
  const { deps: depsJson } = buildDeps({ state: { active: null, plan: null } })
  const jsonRun = await runCapture(depsJson, ['--config', CONFIG, '--no-wait', '--json'])
  const parsedJson = JSON.parse(jsonRun.stdout) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsedJson).sort(), ['operation_id', 'scheduled', 'status_endpoint'])
  assert.equal(parsedJson.scheduled, true)

  const { deps: depsHuman, control: controlHuman } = buildDeps({ state: { active: null, plan: null } })
  const humanRun = await runCapture(depsHuman, ['--config', CONFIG, '--no-wait'])
  assert.match(humanRun.stdout, /scheduled/u)
  assert.match(humanRun.stdout, /wrenyard status --json/u)
  assert.throws(() => JSON.parse(humanRun.stdout))
  assert.equal(controlHuman.launchCalls.length, 1)
})

// ── human default waits and emits the five-field completed result ───────────

test('human default waits for the exact operation and emits exactly the five result fields', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: null,
      plan: {
        operation_id: 'op_update_test',
        kind: 'update',
        phase: 'completed',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        new_head: UPDATE_NEW_HEAD,
      },
    },
    terminal: {
      operationId: 'op_update_test',
      kind: 'update',
      phase: 'completed',
      recoveryRequired: false,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    status: fakeStatus(),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['health_result', 'operation_id', 'phase', 'pull_result', 'restart_result'],
  )
})

test('successful old/new head projection yields completed result with collected health', async () => {
  const { deps } = buildDeps({
    state: {
      active: null,
      plan: {
        operation_id: 'op_update_test',
        kind: 'update',
        phase: 'completed',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        new_head: UPDATE_NEW_HEAD,
      },
    },
    terminal: {
      operationId: 'op_update_test',
      kind: 'update',
      phase: 'completed',
      recoveryRequired: false,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    status: fakeStatus(),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout) as {
    operation_id: string
    phase: string
    pull_result: { old_head: string; new_head: string }
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.equal(parsed.operation_id, 'op_update_test')
  assert.equal(parsed.phase, 'completed')
  assert.deepEqual(parsed.pull_result, { old_head: UPDATE_OLD_HEAD, new_head: UPDATE_NEW_HEAD })
  assert.equal(parsed.restart_result, 'completed')
  assert.ok(parsed.health_result)
})

test('pre-stop pull failure yields null restart/health and a nonzero exit', async () => {
  const { deps } = buildDeps({
    state: { active: null, plan: null },
    terminal: null,
    status: fakeStatus(),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.notEqual(code, 0)
  const parsed = JSON.parse(stdout) as {
    phase: string
    pull_result: Record<string, unknown>
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.equal(parsed.phase, 'failed')
  assert.equal(Object.keys(parsed.pull_result).length, 0)
  assert.equal(parsed.restart_result, null)
  assert.equal(parsed.health_result, null)
})

test('post-stop failure reuses FU-002 result values (failed restart, collected health)', async () => {
  const { deps } = buildDeps({
    state: {
      active: null,
      plan: {
        operation_id: 'op_update_test',
        kind: 'update',
        phase: 'failed',
        recovery_required: true,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        error_code: 'planned_restart_verification_failed',
        error_message: 'daemon did not become healthy',
      },
    },
    terminal: {
      operationId: 'op_update_test',
      kind: 'update',
      phase: 'failed',
      recoveryRequired: true,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    status: fakeStatus(),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.notEqual(code, 0)
  const parsed = JSON.parse(stdout) as {
    phase: string
    pull_result: { old_head: string; error_code: string; error_message: string }
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.equal(parsed.phase, 'failed')
  assert.equal(parsed.pull_result.old_head, UPDATE_OLD_HEAD)
  assert.equal(parsed.pull_result.error_code, 'planned_restart_verification_failed')
  assert.equal(parsed.pull_result.error_message, 'daemon did not become healthy')
  assert.equal(parsed.restart_result, 'failed')
  assert.ok(parsed.health_result)
})

// ── plan selection (join / resume / reject / surface) ───────────────────────

test('joins a live update coordinator without spawning a new one', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: {
        operationId: 'op_update_live',
        kind: 'update',
        phase: 'draining',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_live',
        kind: 'update',
        phase: 'draining',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        coordinator_pid: 4242,
      },
    },
    isCoordinatorAlive: () => true,
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_join' },
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG])
  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 0, 'join must not spawn')
  assert.equal(control.beginCalls.length, 0, 'join must not beginPlan')
  assert.equal(control.updatePlannedRestartCalls.length, 0, 'join must not stamp a pid')
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.equal(parsed.operation_id, 'op_update_live')
  assert.equal(parsed.scheduled, true)
})

test('resumes a dead update coordinator under the existing operation id without beginPlan', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: {
        operationId: 'op_update_dead',
        kind: 'update',
        phase: 'updating',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_dead',
        kind: 'update',
        phase: 'updating',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        coordinator_pid: 5555,
      },
    },
    isCoordinatorAlive: (pid) => pid === 9999,
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_resume' },
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG])
  assert.equal(code, 0)
  assert.equal(control.beginCalls.length, 0, 'resume must not begin a second plan')
  assert.equal(control.launchCalls.length, 1, 'resume must spawn a coordinator')
  assert.equal(control.launchCalls[0].operationId, 'op_update_dead')
  assert.equal(control.launchCalls[0].kind, 'update')
  // Resume stamps the new coordinator pid via updatePlan.
  assert.equal(control.updatePlannedRestartCalls.length, 1)
  assert.deepEqual(control.updatePlannedRestartCalls[0][1], { coordinator_pid: 9999 })
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  assert.equal(parsed.operation_id, 'op_update_dead')
})

test('rejects an active restart plan', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: {
        operationId: 'op_restart_conflict',
        kind: 'restart',
        phase: 'draining',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: null,
    },
  })

  await assert.rejects(
    () => handleUpdate(['--config', CONFIG], deps),
    /planned restart is currently active/u,
  )
  assert.equal(control.launchCalls.length, 0)
  assert.equal(control.beginCalls.length, 0)
})

test('surfaces a terminal recovery-required update plan rather than retrying it', async () => {
  const { deps } = buildDeps({
    state: {
      active: {
        operationId: 'op_update_recovery',
        kind: 'update',
        phase: 'failed',
        recoveryRequired: true,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_recovery',
        kind: 'update',
        phase: 'failed',
        recovery_required: true,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        error_code: 'planned_restart_verification_failed',
        error_message: 'recovery required',
      },
    },
    terminal: {
      operationId: 'op_update_recovery',
      kind: 'update',
      phase: 'failed',
      recoveryRequired: true,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    status: fakeStatus('op_update_recovery'),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.notEqual(code, 0)
  const parsed = JSON.parse(stdout) as {
    operation_id: string
    phase: string
    pull_result: { old_head: string; error_code: string }
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.equal(parsed.operation_id, 'op_update_recovery')
  assert.equal(parsed.phase, 'failed')
  assert.equal(parsed.pull_result.old_head, UPDATE_OLD_HEAD)
  assert.equal(parsed.pull_result.error_code, 'planned_restart_verification_failed')
  assert.equal(parsed.restart_result, 'failed')
  assert.ok(parsed.health_result)
})

test('task context surfaces a terminal recovery-required update plan (never a scheduled success)', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: {
        operationId: 'op_update_recovery_task',
        kind: 'update',
        phase: 'failed',
        recoveryRequired: true,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_recovery_task',
        kind: 'update',
        phase: 'failed',
        recovery_required: true,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        error_code: 'planned_restart_verification_failed',
        error_message: 'recovery required',
      },
    },
    status: fakeStatus('op_update_recovery_task'),
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_recovery_task' },
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--json'])
  assert.notEqual(code, 0)
  assert.equal(control.launchCalls.length, 0)
  assert.equal(control.beginCalls.length, 0)
  assert.equal(control.updatePlannedRestartCalls.length, 0)
  assert.equal(control.waitCalls, 0)
  const parsed = JSON.parse(stdout) as {
    operation_id: string
    phase: string
    pull_result: { old_head: string; error_code: string; error_message: string }
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['health_result', 'operation_id', 'phase', 'pull_result', 'restart_result'],
  )
  assert.equal(parsed.operation_id, 'op_update_recovery_task')
  assert.equal(parsed.phase, 'failed')
  assert.equal(parsed.pull_result.old_head, UPDATE_OLD_HEAD)
  assert.equal(parsed.pull_result.error_code, 'planned_restart_verification_failed')
  assert.equal(parsed.pull_result.error_message, 'recovery required')
  assert.equal(parsed.restart_result, 'failed')
  assert.ok(parsed.health_result)
})

test('human --no-wait surfaces a terminal recovery-required update plan (never a scheduled success)', async () => {
  const { deps, control } = buildDeps({
    state: {
      active: {
        operationId: 'op_update_recovery_nowait',
        kind: 'update',
        phase: 'failed',
        recoveryRequired: true,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_recovery_nowait',
        kind: 'update',
        phase: 'failed',
        recovery_required: true,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        error_code: 'planned_restart_verification_failed',
        error_message: 'recovery required',
      },
    },
    status: fakeStatus('op_update_recovery_nowait'),
  })

  const { code, stdout } = await runCapture(deps, ['--config', CONFIG, '--no-wait', '--json'])
  assert.notEqual(code, 0)
  assert.equal(control.launchCalls.length, 0)
  assert.equal(control.beginCalls.length, 0)
  assert.equal(control.updatePlannedRestartCalls.length, 0)
  assert.equal(control.waitCalls, 0)
  const parsed = JSON.parse(stdout) as {
    operation_id: string
    phase: string
    pull_result: { old_head: string; error_code: string; error_message: string }
    restart_result: string | null
    health_result: ForemanStatus | null
  }
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['health_result', 'operation_id', 'phase', 'pull_result', 'restart_result'],
  )
  assert.equal(parsed.phase, 'failed')
  assert.equal(parsed.pull_result.error_code, 'planned_restart_verification_failed')
  assert.equal(parsed.pull_result.error_message, 'recovery required')
  assert.equal(parsed.restart_result, 'failed')
  assert.ok(parsed.health_result)
})

test('ignores a retained completed update plan under accepting and schedules a fresh update', async () => {
  const { deps, control } = buildDeps({
    state: {
      mode: 'accepting',
      active: {
        operationId: 'op_update_old',
        kind: 'update',
        phase: 'completed',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_old',
        kind: 'update',
        phase: 'completed',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
        new_head: UPDATE_NEW_HEAD,
      },
    },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_history_completed' },
  })

  const { code } = await runCapture(deps, ['--config', CONFIG])
  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1, 'fresh update replaces retained history')
  assert.equal(control.beginCalls.length, 1, 'fresh path begins a new plan')
})

test('ignores a retained failed non-recovery update plan under accepting and schedules a fresh update', async () => {
  const { deps, control } = buildDeps({
    state: {
      mode: 'accepting',
      active: {
        operationId: 'op_update_old',
        kind: 'update',
        phase: 'failed',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_update_old',
        kind: 'update',
        phase: 'failed',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
        old_head: UPDATE_OLD_HEAD,
      },
    },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_history_failed' },
  })

  const { code } = await runCapture(deps, ['--config', CONFIG])
  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  assert.equal(control.beginCalls.length, 1)
})

test('a retained completed opposite-kind restart history under accepting does not conflict with a fresh update', async () => {
  const { deps, control } = buildDeps({
    state: {
      mode: 'accepting',
      active: {
        operationId: 'op_restart_old',
        kind: 'restart',
        phase: 'completed',
        recoveryRequired: false,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      plan: {
        operation_id: 'op_restart_old',
        kind: 'restart',
        phase: 'completed',
        recovery_required: false,
        created_at: '2026-07-15T00:00:00.000Z',
      },
    },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_history_opposite' },
  })

  const { code } = await runCapture(deps, ['--config', CONFIG])
  assert.equal(code, 0)
  assert.equal(control.launchCalls.length, 1)
  assert.equal(control.beginCalls.length, 1)
})

// ── plan-first abort contract (Finding 1c-i) ───────────────────────────────

test('spawn failure after beginPlan aborts the plan with the exact begun operation id', async () => {
  const { deps, control } = buildDeps({
    state: { active: null, plan: null },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_abort' },
  })
  // Override launchCoordinator to throw, simulating a spawn failure after
  // beginPlan has already atomically activated the plan.
  deps.launchCoordinator = async () => {
    throw new Error('spawn boom')
  }

  await assert.rejects(
    () => handleUpdate(['--config', CONFIG], deps),
    /spawn boom/u,
  )

  // beginPlan was called with a complete fresh plan (phase draining, null pid).
  assert.equal(control.beginCalls.length, 1)
  const begun = control.beginCalls[0]
  assert.equal(begun.phase, 'draining')
  assert.equal(begun.coordinator_pid, null)
  assert.equal(begun.kind, 'update')

  // abortPlan was invoked with the exact operation id that was begun.
  assert.equal(control.abortCalls.length, 1)
  assert.equal(control.abortCalls[0], begun.operation_id)

  // No pid was stamped (spawn failed before stamping).
  assert.equal(control.updatePlannedRestartCalls.length, 0)
})

// ── serialized decide+launch flows (Finding 1c-ii) ─────────────────────────

test('a second decide+launch flow joins after the first begins and stamps a live pid', async () => {
  // Stateful fake dispatch: the first call sees no active plan (fresh path);
  // after beginPlan + updatePlan stamp the pid, the second call sees the
  // active plan and joins because the coordinator is alive.
  let activePlan: PlannedRestartPlanSummary | null = null
  let stampedPid: number | null = null
  const beginCalls: PlannedRestartPlan[] = []
  const launchCalls: Array<Record<string, unknown>> = []
  const updateCalls: Array<[string, Record<string, unknown>]> = []

  const dispatchControl = {
    status() {
      return {
        mode: activePlan ? 'planned_restart' : 'accepting',
        frozen: false,
        accepting: !activePlan,
        plannedRestart: activePlan,
        activeTasks: [],
        activeTaskCount: 0,
        activeWorkflows: [],
        activeWorkflowCount: 0,
        activeExecutions: [],
        activeExecutionCount: 0,
      }
    },
    beginPlannedRestart(plan: PlannedRestartPlan) {
      beginCalls.push(plan)
      activePlan = {
        operationId: plan.operation_id,
        kind: plan.kind,
        phase: plan.phase,
        recoveryRequired: plan.recovery_required,
        createdAt: plan.created_at,
      }
    },
    updatePlannedRestart(op: string, patch: Record<string, unknown>) {
      updateCalls.push([op, patch])
      if (patch.coordinator_pid !== undefined) stampedPid = patch.coordinator_pid as number
    },
    completePlannedRestart() {},
    abortPlannedRestart() {},
    failPlannedRestart() {},
  }
  const store = {
    snapshot: () => ({
      mode: activePlan ? 'planned_restart' : 'accepting',
      plan: stampedPid !== null ? { coordinator_pid: stampedPid } : null,
    }),
  }

  const launchCoordinator = async (_d: unknown, options: { operationId: string; kind: string }) => {
    launchCalls.push(options as unknown as Record<string, unknown>)
    return { pid: 7777 }
  }
  // The coordinator is alive for the stamped pid.
  const isCoordinatorAlive = (pid: number) => pid === 7777

  const deps: ForemanUpdateCommandDeps = {
    plannedRestartStore: store as never,
    dispatchControl: dispatchControl as never,
    foremanUpdateGit: {
      preflight: async () => ({ checkout_path: '/tmp/fake-checkout', old_head: UPDATE_OLD_HEAD }),
    } as unknown as ForemanUpdateGit,
    launchCoordinator: launchCoordinator as never,
    isCoordinatorAlive,
    waitForPlanTerminal: async () => null,
    collectForemanStatus: async () => fakeStatus(),
    acquireLock: async () => ({ release: () => {} }),
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_serialize' },
  }

  // First flow: fresh — begins plan, spawns, stamps pid.
  const first = await runCapture(deps, ['--config', CONFIG])
  assert.equal(first.code, 0)
  assert.equal(beginCalls.length, 1, 'first flow begins a plan')
  assert.equal(launchCalls.length, 1, 'first flow spawns a coordinator')
  assert.equal(stampedPid, 7777)

  // Second flow: the active plan has a live coordinator → join (no second
  // beginPlan, no second spawn).
  const second = await runCapture(deps, ['--config', CONFIG])
  assert.equal(second.code, 0)
  assert.equal(beginCalls.length, 1, 'second flow must not begin a second plan')
  assert.equal(launchCalls.length, 1, 'second flow must not spawn a second coordinator')
  const parsed = JSON.parse(second.stdout) as { scheduled?: boolean; operation_id?: string }
  assert.equal(parsed.scheduled, true)
  assert.equal(parsed.operation_id, beginCalls[0].operation_id)
})

test('no handler dependency accepts a caller id and update never calls restartDaemonProcess', async () => {
  const { deps, control } = buildDeps({
    state: { active: null, plan: null },
    commandEnv: { FOREMAN_TASK_RUN_ID: 'run_nocaller' },
  })

  await runCapture(deps, ['--config', CONFIG])

  assert.equal((deps as Record<string, unknown>).restartDaemonProcess, undefined)
  for (const call of control.launchCalls) {
    assert.equal((call as Record<string, unknown>).callerId, undefined)
    assert.equal((call as Record<string, unknown>).excludeCaller, undefined)
  }
  for (const [, patch] of control.updatePlannedRestartCalls) {
    assert.equal((patch as Record<string, unknown>).callerId, undefined)
  }
  assert.equal(control.launchCalls.length, 1)
  assert.equal(control.beginCalls.length, 1)
})
