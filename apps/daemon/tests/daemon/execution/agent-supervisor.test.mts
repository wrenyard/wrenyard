import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { AgentEvent } from '@wrenyard/clients'
import type { ExecService } from '@wrenyard/exec'
import { Catalog } from '@wrenyard/providers/catalog'
import type { ForemanDatabase } from '../../../lib/db/types.mts'
import { AgentExecutionSupervisor, ExecutionTerminationFailure } from '../../../lib/daemon/execution/agent-supervisor.mts'
import { redactEvent } from '../../../lib/daemon/execution/redaction.mts'
import { RepoWriteLocks } from '../../../lib/daemon/execution/repo-write-locks.mts'
import { closeTestDb, initTestDb } from '../../helpers/test-db.mts'
import type { TaskResolvedDispatch } from '../../../lib/protocol/task-run-metadata.mts'

let db: ForemanDatabase
let oldForgeBin: string | undefined
let oldForgeArgsPrefix: string | undefined
let tempDirs: string[] = []
let scriptCounter = 0
let supervisors: AgentExecutionSupervisor[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeSupervisor(repoWriteLocks?: RepoWriteLocks): AgentExecutionSupervisor {
  const locks = repoWriteLocks ?? new RepoWriteLocks()
  const supervisor = new AgentExecutionSupervisor({ db, repoWriteLocks: locks })
  supervisors.push(supervisor)
  return supervisor
}

beforeEach(() => {
  oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
  oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX
  db = initTestDb()
})

afterEach(async () => {
  const shutdownErrors: unknown[] = []
  await Promise.allSettled(supervisors.map((s) => s.shutdown())).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') shutdownErrors.push(r.reason)
    }
  })

  if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
  else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
  if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
  else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix

  closeTestDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  supervisors = []

  if (shutdownErrors.length > 0) {
    throw new Error(
      `supervisor shutdown failures: ${shutdownErrors.map((e) => String(e)).join('; ')}`,
    )
  }
})

describe('AgentExecutionSupervisor', { concurrency: false }, () => {
  it('does not launch Forge when the task is already terminal at binding time', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-attach-fail-')
    const startedPath = join(cwd, 'started')
    installLongRunningFakeForge(cwd, startedPath)

    const repoWriteLocks = new RepoWriteLocks()
    const supervisor = makeSupervisor(repoWriteLocks)

    const taskId = 'task_term_before_bind'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'done', 1, ?, ?)`,
    ).run(taskId, now, now)

    const handle = await supervisor.startExecution({
      profile: 'test',
      cwd,
      prompt: 'should not run',
      taskId,
    })

    // Give the (never launched) forge a moment; startedPath must never appear.
    await sleep(80)
    assert.equal(existsSync(startedPath), false, 'Forge must not be launched for a terminal task')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'cancelled', 'new execution must be synchronously cancelled when binding fails')

    assert.equal(repoWriteLocks.isLocked(cwd), null, 'repo write lock must be released')

    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'done', 'pre-terminal task must remain untouched')
  })

  it('cancels a running execution that has no supervisor registry entry by killing and terminalizing it', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-no-registry-')
    const startedPath = join(cwd, 'started')
    scriptCounter += 1
    const orphanScript = join(cwd, `orphan-${scriptCounter}.mjs`)
    writeFileSync(orphanScript, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, 'started')
await new Promise(() => {})
`, 'utf-8')

    const orphanPid = spawn(process.execPath, [orphanScript], {
      detached: true,
      stdio: 'ignore',
    }).pid
    assert.ok(orphanPid, 'expected orphan child pid')
    await waitForFile(startedPath)

    const taskId = 'task_orphan_exec'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_orphan'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'orphan', 'running', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, orphanPid, orphanPid, now, now)

    const supervisor = makeSupervisor()
    await supervisor.cancelExecution(execId)

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'cancelled', 'orphan running execution must be terminalized as cancelled')

    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'cancelled', 'linked task must be cancelled')

    const activeCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM executions WHERE status IN ('queued', 'running', 'starting')`,
    ).get()?.c ?? 0
    assert.equal(activeCount, 0, 'no active execution should remain')

    let alive = true
    try {
      process.kill(orphanPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'orphan child process must be killed')
  })

  it('keeps an unregistered running execution active when the recorded PID kill fails', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cancel-kill-fail-')
    const taskId = 'task_cancel_kill_fail'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_cancel_kill_fail'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'orphan', 'running', 424242, 424242, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      killProcessTreeImpl: async () => {
        throw new Error('simulated kill failure')
      },
    })
    supervisors.push(supervisor)

    await assert.rejects(
      supervisor.cancelExecution(execId),
      (error: unknown) => error instanceof ExecutionTerminationFailure
        && error.executionId === execId
        && error.phase === 'kill',
      'a kill failure must surface as a structured cancellation failure',
    )

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active when the PID cannot be controlled')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const cancelled = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
    ).get(execId)?.c ?? 0
    assert.equal(cancelled, 0, 'no terminal cancelled event may be inserted')
  })

  it('keeps an unregistered running execution active when the recorded PID remains live after kill', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cancel-live-')
    const taskId = 'task_cancel_live'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_cancel_live'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'orphan', 'running', 434343, 434343, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      // The kill resolves, but the liveness probe reports the PID still live.
      killProcessTreeImpl: async () => {},
      isProcessLiveImpl: () => true,
    })
    supervisors.push(supervisor)

    await assert.rejects(
      supervisor.cancelExecution(execId),
      (error: unknown) => error instanceof ExecutionTerminationFailure
        && error.executionId === execId
        && error.phase === 'verify',
      'a PID that remains live must surface as a structured cancellation failure',
    )

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active while the PID is still live')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const cancelled = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
    ).get(execId)?.c ?? 0
    assert.equal(cancelled, 0, 'no terminal cancelled event may be inserted')
  })

  it('kills a live persisted parent/child tree using persisted PID data on a fresh registry', {
    // macOS keeps the deliberately detached child in its own process group, so
    // the persisted parent group cannot deterministically terminate it.
    skip: process.platform === 'darwin' ? 'known macOS detached-process-group limitation' : false,
  }, async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-tree-')
    const startedPath = join(cwd, 'started')
    const childPidPath = join(cwd, 'child-pid')

    // A long-running child that the parent keeps alive so the tree is a real target.
    scriptCounter += 1
    const childScript = join(cwd, `tree-child-${scriptCounter}.mjs`)
    writeFileSync(childScript, `setInterval(() => {}, 1000)\n`, 'utf-8')

    // The parent is test-owned (detached, new process group) and spawns the child into its group.
    scriptCounter += 1
    const parentScript = join(cwd, `tree-parent-${scriptCounter}.mjs`)
    writeFileSync(parentScript, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
writeFileSync(${JSON.stringify(startedPath)}, 'started')
setInterval(() => {}, 1000)
`, 'utf-8')

    const parent = spawn(process.execPath, [parentScript], { detached: true, stdio: 'ignore' })
    const rootPid = parent.pid
    assert.ok(rootPid, 'expected test-owned root parent pid')
    await waitForFile(startedPath)
    // Register PIDs immediately so cleanup is guaranteed even if an assertion below fails.
    const trackedPids = [rootPid]
    const childPid = Number(readFileSync(childPidPath, 'utf-8').trim())
    assert.ok(childPid, 'expected test-owned child pid')
    trackedPids.push(childPid)

    const execId = 'exec_startup_tree'
    const taskId = 'task_startup_tree'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'tree', 'running', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, rootPid, rootPid, now, now)

    try {
      // Fresh supervisor: its in-memory registry has no entry for this execution, so it
      // must rely entirely on the persisted PID/pgid to locate and kill the tree.
      const supervisor = makeSupervisor()
      await supervisor.markInterruptedOnStartup()

      const execRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM executions WHERE id = ?`,
      ).get(execId)
      assert.ok(execRow, 'expected execution row')
      assert.equal(execRow.status, 'interrupted', 'persisted running row must be interrupted on startup')

      let rootAlive = true
      try {
        process.kill(rootPid, 0)
      } catch {
        rootAlive = false
      }
      assert.equal(rootAlive, false, 'known root parent process must be killed')

      let childAlive = true
      try {
        process.kill(childPid, 0)
      } catch {
        childAlive = false
      }
      assert.equal(childAlive, false, 'known child process must be killed via the persisted process group')
    } finally {
      for (const pid of trackedPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone; nothing to clean up
        }
      }
    }
  })

  it('treats an already-absent persisted PID as interrupted without failing startup', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-exited-')

    // A test-owned process that exits before it is seeded as a persisted PID.
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const exitedPid = exited.pid
    assert.ok(exitedPid, 'expected test-owned exited child pid')
    await new Promise<void>((resolve) => exited.on('exit', () => resolve()))

    let alive = true
    try {
      process.kill(exitedPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'test-owned process must already be exited before seeding')

    const execId = 'exec_startup_exited'
    const taskId = 'task_startup_exited'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'exited', 'starting', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, exitedPid, exitedPid, now, now)

    // markInterruptedOnStartup must resolve even though the persisted PID is already gone,
    // and it must still mark the row interrupted.
    const supervisor = makeSupervisor()
    await supervisor.markInterruptedOnStartup()

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'interrupted', 'already-absent starting row must be interrupted idempotently')
  })

  it('keeps a stale execution active on startup when its recorded PID kill fails', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-kill-fail-')
    const taskId = 'task_startup_kill_fail'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_startup_kill_fail'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'stale', 'running', 454545, 454545, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      killProcessTreeImpl: async () => {
        throw new Error('simulated startup kill failure')
      },
    })
    supervisors.push(supervisor)

    const failures = await supervisor.markInterruptedOnStartup()
    assert.equal(failures.length, 1, 'the kill failure must be surfaced')
    assert.equal(failures[0].executionId, execId)
    assert.equal(failures[0].action, 'startup-interrupt')
    assert.equal(failures[0].phase, 'kill')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active when the PID cannot be controlled')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const eventCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ?`,
    ).get(execId)?.c ?? 0
    assert.equal(eventCount, 0, 'no terminal event may be inserted for an uncontrolled process')
  })

  it('keeps a stale execution active on startup when its recorded PID remains live after kill', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-live-')
    const taskId = 'task_startup_live'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_startup_live'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'stale', 'running', 464646, 464646, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      // The kill resolves, but the liveness probe reports the PID still live.
      killProcessTreeImpl: async () => {},
      isProcessLiveImpl: () => true,
    })
    supervisors.push(supervisor)

    const failures = await supervisor.markInterruptedOnStartup()
    assert.equal(failures.length, 1, 'the still-live process must be surfaced')
    assert.equal(failures[0].executionId, execId)
    assert.equal(failures[0].action, 'startup-interrupt')
    assert.equal(failures[0].phase, 'verify')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active while the PID is still live')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const eventCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ?`,
    ).get(execId)?.c ?? 0
    assert.equal(eventCount, 0, 'no terminal event may be inserted for an uncontrolled process')
  })

  it('startExecution persists one dispatch snapshot row per attempt keyed by each execution', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-dispatch-')
    const taskId = 'task_dispatch_snapshots'
    const now = new Date().toISOString()
    // A running task row so attachExecution succeeds for both attempts.
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const supervisor = makeSupervisor()

    const snapshotA: TaskResolvedDispatch = {
      requested_agent_runtime: 'forge/test',
      profile: 'test',
      client: 'claude',
      provider: 'anthropic',
      model: 'model-a',
      model_id: 'model-a-id',
      mode: 'native',
      speed: { effective_tps: 12, source: 'local_31d', sample_count: 3, checked_at: now, expected_tps_met: true },
      intelligence: 'high',
      reference_pricing: {
        input_usd_per_million: 1,
        output_usd_per_million: 2,
        cached_input_usd_per_million: 0.5,
        cache_write_input_usd_per_million: 0.25,
        source: 'catalog',
        checked_at: now,
      },
      // Automatic attempt: carries the privacy-safe routing decision that must
      // be persisted verbatim as JSON text.
      auto_routing: {
        snapshot_id: 'snap-a',
        selected_rank: 0,
        supply_class: 'standard',
        quota_tier: 'healthy',
        quota_coverage_complete: true,
        quota_headroom_trusted: true,
        reference_output_usd_per_million: 3,
        routing_output_usd_per_million: 2.5,
        effective_cap_usd_per_million: 4,
        score: 0.95,
        reasons: ['lowest reference output price'],
      },
    }
    const snapshotB: TaskResolvedDispatch = {
      requested_agent_runtime: 'forge/test',
      profile: 'test',
      client: 'codex',
      provider: 'openai',
      model: 'model-b',
      model_id: 'model-b-id',
      mode: 'gateway',
      speed: { effective_tps: 24, source: 'catalog_default', sample_count: 7, checked_at: now, expected_tps_met: false, degradation_reason: 'low samples' },
      intelligence: 'medium',
      reference_pricing: {
        input_usd_per_million: 3,
        output_usd_per_million: 20,
        cached_input_usd_per_million: 1.5,
        cache_write_input_usd_per_million: 0.75,
        source: 'catalog',
        checked_at: now,
      },
    }

    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_finished', { status: 'done', exit_code: 0, summary: 'a' }),
    ])

    const handleA = await supervisor.startExecution({
      profile: 'test',
      cwd,
      prompt: 'attempt A',
      taskId,
      dispatchSnapshot: snapshotA,
    })
    // Re-point the fake Forge output for the second attempt.
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_finished', { status: 'done', exit_code: 0, summary: 'b' }),
    ])
    const handleB = await supervisor.startExecution({
      profile: 'test',
      cwd,
      prompt: 'attempt B',
      taskId,
      dispatchSnapshot: snapshotB,
    })

    // The snapshot INSERT happens synchronously inside startExecution before
    // launch, so both rows exist even before the executions complete.
    const rows = db.prepare<unknown[], { execution_id: string; model: string; reference_pricing_output: number; auto_routing: string | null }>(
      `SELECT execution_id, model, reference_pricing_output, auto_routing
       FROM task_run_attempt_dispatch WHERE task_run_id = ?`,
    ).all(taskId)
    assert.equal(rows.length, 2, 'two attempts must create two task_run_attempt_dispatch rows')

    const byExecution = new Map(rows.map((row) => [row.execution_id, row]))
    const rowA = byExecution.get(handleA.executionId)
    const rowB = byExecution.get(handleB.executionId)
    assert.ok(rowA, 'attempt A must have its own dispatch snapshot row')
    assert.ok(rowB, 'attempt B must have its own dispatch snapshot row')
    assert.equal(rowA.execution_id, handleA.executionId)
    assert.equal(rowB.execution_id, handleB.executionId)
    assert.equal(rowA.model, 'model-a', 'first attempt snapshot keeps its canonical model')
    assert.equal(rowB.model, 'model-b', 'second attempt snapshot keeps its canonical model')
    assert.equal(rowA.reference_pricing_output, 2, 'first attempt keeps its own output price')
    assert.equal(rowB.reference_pricing_output, 20, 'second attempt keeps its own output price')
    assert.equal(
      rowA.auto_routing,
      JSON.stringify(snapshotA.auto_routing),
      'automatic attempt must persist its routing decision as exact JSON text',
    )
    assert.equal(rowB.auto_routing, null, 'explicit/legacy attempt without a decision persists SQL NULL')

    // Let both executions complete so their child processes are reaped.
    await handleA.wait()
    await handleB.wait()
  })
})

function installLongRunningFakeForge(dir: string, startedPath: string): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-long-${scriptCounter}.mjs`)
  writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, 'started')
setInterval(() => {}, 1000)
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installFakeForgeLines(dir: string, events: Array<Record<string, unknown>>): void {
  installFakeForgeOutput(dir, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

function installFakeForgeOutput(dir: string, output: string): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-${scriptCounter}.mjs`)
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function forgeStreamEvent(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_test',
    seq,
    type,
    timestamp: '2026-06-19T00:00:00.000Z',
    data,
  }
}

// ── Execution lifecycle over a fake exec service ──────────────────────
//
// The supervisor resolves `provider/model:client` through the catalog and
// launches through its ExecService. These tests inject both, so the lifecycle
// is exercised without a real client process.

interface FakeRun {
  prompt: string
  /** Emit the terminal result and a clean exit. */
  finish(output?: string): void
  cancelled: boolean
}

function makeFakeExec(): { service: ExecService; runs: FakeRun[] } {
  const runs: FakeRun[] = []
  let pid = 900_000
  const service = {
    async start(request: { prompt: string }) {
      const queue: AgentEvent[] = []
      let wake: (() => void) | undefined
      let closed = false
      const push = (event: AgentEvent): void => {
        queue.push(event)
        wake?.()
      }
      const run: FakeRun = {
        prompt: request.prompt,
        cancelled: false,
        finish(output = 'ok') {
          push({ type: 'output', record: { type: 'run_finished', status: 'done', output } })
          push({ type: 'exit', exitCode: 0, signal: null })
        },
      }
      runs.push(run)
      const events: AsyncIterable<AgentEvent> = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            const event = queue.shift()
            if (event === undefined) {
              await new Promise<void>((resolve) => { wake = resolve })
              continue
            }
            if (event.type === 'exit') closed = true
            yield event
          }
        },
      }
      return {
        events,
        result: new Promise(() => undefined),
        async cancel() {
          run.cancelled = true
          push({ type: 'exit', exitCode: null, signal: 'SIGTERM' })
        },
        diagnostics: { pid: (pid += 1) },
      }
    },
    async close() {},
  }
  return { service: service as unknown as ExecService, runs }
}

function makeFakeSupervisor(): { supervisor: AgentExecutionSupervisor; runs: FakeRun[] } {
  const catalog = new Catalog()
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true })
  catalog.registerProvider({
    convertReasoningEffort: (_model, effort) => ({ reasoning_effort: effort }),
    id: 'p',
    displayName: 'P',
    credentialResolver: 'managed',
    models: [{ id: 'm', displayName: 'M', intelligence: 'mid', speed: 100, pricing: [0.5, 1, 2], reasoningEfforts: ['none'] }],
    reasoningEffortMappings: { m: { codebuddy: { none: { effort: 'none' } } } },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  })
  const resolveRun = catalog.resolveRun.bind(catalog)
  catalog.resolveRun = (client, provider, model, effort = 'none') => resolveRun(client, provider, model, effort)
  const { service, runs } = makeFakeExec()
  const supervisor = new AgentExecutionSupervisor({
    db,
    repoWriteLocks: new RepoWriteLocks(),
    catalog,
    execService: service,
    killProcessTreeImpl: async () => {},
    isProcessLiveImpl: () => false,
  })
  supervisors.push(supervisor)
  return { supervisor, runs }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time')
    await sleep(5)
  }
}

describe('AgentExecutionSupervisor lifecycle', { concurrency: false }, () => {
  const PROFILE = 'p/m:cb'
  const dispatchSnapshot: TaskResolvedDispatch = { requested_agent_runtime: '', profile: PROFILE, client: 'codebuddy', provider: 'p', model: 'm', model_id: 'p/m', mode: 'gateway', protocol: 'openai_chat', reasoningEffort: 'none', intelligence: 'mid', speed: { effective_tps: 100, source: 'catalog_default', sample_count: 0, expected_tps_met: true }, reference_pricing: { input_usd_per_million: 1, output_usd_per_million: 2, cached_input_usd_per_million: 0.5, source: 'catalog' } }

  it('runs a resolved target to done and returns its final output', async () => {
    const cwd = makeTempDir('wy-supervisor-run-')
    const { supervisor, runs } = makeFakeSupervisor()
    const handle = await supervisor.startExecution({ profile: PROFILE, dispatchSnapshot, cwd, prompt: 'do it' })
    await waitFor(() => runs.length === 1)
    runs[0]!.finish('final answer')
    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'final answer')
  })

  it('fails an execution whose profile names no resolvable client', async () => {
    const cwd = makeTempDir('wy-supervisor-unresolved-')
    const { supervisor, runs } = makeFakeSupervisor()
    const handle = await supervisor.startExecution({ profile: 'test', cwd, prompt: 'do it' })
    const result = await handle.wait()
    assert.equal(result.status, 'failed')
    assert.equal(runs.length, 0)
  })

  it('queues a second same-repo writer until the first one finishes', async () => {
    const cwd = makeTempDir('wy-supervisor-lock-')
    const { supervisor, runs } = makeFakeSupervisor()
    const first = await supervisor.startExecution({ profile: PROFILE, dispatchSnapshot, cwd, prompt: 'first writer' })
    await waitFor(() => runs.length === 1)
    const second = await supervisor.startExecution({ profile: PROFILE, dispatchSnapshot, cwd, prompt: 'second writer' })
    await sleep(40)
    assert.deepEqual(runs.map((run) => run.prompt), ['first writer'])

    runs[0]!.finish()
    assert.equal((await first.wait()).status, 'done')
    await waitFor(() => runs.length === 2)
    runs[1]!.finish()
    assert.equal((await second.wait()).status, 'done')
  })

  it('runs same-repo writers concurrently when their write paths differ', async () => {
    const cwd = makeTempDir('wy-supervisor-scoped-lock-')
    const { supervisor, runs } = makeFakeSupervisor()
    const first = await supervisor.startExecution({
      profile: PROFILE, dispatchSnapshot, cwd, prompt: 'first writer', writePaths: [join(cwd, 'src/a.ts')],
    })
    const second = await supervisor.startExecution({
      profile: PROFILE, dispatchSnapshot, cwd, prompt: 'second writer', writePaths: [join(cwd, 'src/b.ts')],
    })
    await waitFor(() => runs.length === 2)
    runs[1]!.finish()
    assert.equal((await second.wait()).status, 'done')
    runs[0]!.finish()
    assert.equal((await first.wait()).status, 'done')
  })

  it('cancels a running execution and releases its repo lock to the next writer', async () => {
    const cwd = makeTempDir('wy-supervisor-cancel-')
    const { supervisor, runs } = makeFakeSupervisor()
    const first = await supervisor.startExecution({ profile: PROFILE, dispatchSnapshot, cwd, prompt: 'first writer' })
    await waitFor(() => runs.length === 1)
    const second = await supervisor.startExecution({ profile: PROFILE, dispatchSnapshot, cwd, prompt: 'second writer' })

    await first.cancel()
    assert.equal((await first.wait()).status, 'cancelled')
    assert.equal(runs[0]!.cancelled, true)

    await waitFor(() => runs.length === 2)
    runs[1]!.finish()
    assert.equal((await second.wait()).status, 'done')
  })
})
