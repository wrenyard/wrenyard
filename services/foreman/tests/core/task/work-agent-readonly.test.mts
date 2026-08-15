/**
 * Tests for the Work-agent task_run readonly enforcement.
 *
 * The Work agent is a front-desk dispatcher: task_run from the Work caller
 * (identified by the internal delegation admission descriptor whose address is
 * 'foreman-work') may only run tasks whose definition permission is
 * 'readonly'. Write-permission tasks must be rejected with guidance to
 * dispatch via pm.ticket.create + fwa.assign. All other callers are
 * unaffected.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, initDb } from '../../../lib/db/connection.mts'
import { discoverTasks } from '../../../lib/workspace/task-loader.mts'
import { resetRegistry } from '../../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../../lib/core/project/loader.mts'
import { setTaskWorkflowRunHost } from '../../../lib/core/operations/primitives/runner.mts'
import type { TaskWorkflowRunHost } from '../../../lib/core/operations/types.mts'
import { TaskService, TaskServiceError } from '../../../lib/core/task/service.mts'
import { FOREMAN_WORK_ADDRESS } from '../../../lib/message/address.mts'

// ─── Helpers ───────────────────────────────────────────────────────────

const fakeHost: TaskWorkflowRunHost = {
  async startTaskRun() {
    return { id: 'fake_run_1', task_run_id: 'fake_run_1', hint: 'fake accepted' }
  },
  async cancelTaskRun() {
    return { ok: true }
  },
}

const workAdmission = {
  address: FOREMAN_WORK_ADDRESS,
  turn_seq: 1,
  delegation_id: 'del_test_001',
  tool_name: 'task_run',
  input: {},
}

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const projectDir = join(dir, 'projects', 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'app.fmproj'),
    `name: app\ndescription: Test application\nhosts:\n  ${osHostname()}: ${JSON.stringify(projectDir)}\n`,
    'utf-8',
  )
  writeFileSync(
    join(projectDir, 'read-task.task.ts'),
    `export default defineTask({
  agentRuntime: 'forge/fast',
  permission: 'readonly',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.string(),
  prompt: () => 'read-only work',
})
`,
    'utf-8',
  )
  writeFileSync(
    join(projectDir, 'write-task.task.ts'),
    `export default defineTask({
  agentRuntime: 'forge/fast',
  permission: 'edit',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.string(),
  prompt: () => 'write work',
})
`,
    'utf-8',
  )
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  closeDb()
  initDb(':memory:')
  resetRegistry()
  invalidateProjectCache()
})

afterEach(() => {
  setTaskWorkflowRunHost(undefined)
  resetRegistry()
  invalidateProjectCache()
  closeDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

// ─── Tests ─────────────────────────────────────────────────────────────

describe('work agent task_run readonly enforcement', () => {
  it('rejects a write-permission task from the Work caller with dispatch guidance', async () => {
    const workspace = makeTempDir('foreman-work-readonly-')
    await discoverTasks(workspace)
    const service = new TaskService({ workspaceRoot: workspace })

    await assert.rejects(
      () => service.run({
        taskId: 'write-task',
        project: 'app',
        input: {},
        delegationAdmission: workAdmission,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TaskServiceError, `expected TaskServiceError, got ${String(error)}`)
        assert.equal(error.code, 'work_agent_readonly_only')
        assert.match(error.message, /pm\.ticket\.create/)
        assert.match(error.message, /fwa\.assign/)
        return true
      },
      'write tasks from the Work caller must be rejected with dispatch guidance',
    )
  })

  it('accepts a readonly task from the Work caller normally', async () => {
    const workspace = makeTempDir('foreman-work-readonly-')
    await discoverTasks(workspace)
    setTaskWorkflowRunHost(fakeHost)
    const service = new TaskService({ workspaceRoot: workspace })

    const result = await service.run({
      taskId: 'read-task',
      project: 'app',
      input: {},
      delegationAdmission: workAdmission,
    })
    assert.ok('task_run_id' in result)
    assert.equal(result.task_run_id, 'fake_run_1')
  })

  it('does not restrict a non-Work caller running a write-permission task', async () => {
    const workspace = makeTempDir('foreman-work-readonly-')
    await discoverTasks(workspace)
    setTaskWorkflowRunHost(fakeHost)
    const service = new TaskService({ workspaceRoot: workspace })

    // No delegation admission descriptor → caller is not the Work agent
    const result = await service.run({
      taskId: 'write-task',
      project: 'app',
      input: {},
    })
    assert.ok('task_run_id' in result)
    assert.equal(result.task_run_id, 'fake_run_1')
  })

  it('does not restrict a delegated call from another agent address', async () => {
    const workspace = makeTempDir('foreman-work-readonly-')
    await discoverTasks(workspace)
    setTaskWorkflowRunHost(fakeHost)
    const service = new TaskService({ workspaceRoot: workspace })

    const result = await service.run({
      taskId: 'write-task',
      project: 'app',
      input: {},
      delegationAdmission: { ...workAdmission, address: 'fwa-session-1' },
    })
    assert.ok('task_run_id' in result)
    assert.equal(result.task_run_id, 'fake_run_1')
  })
})
