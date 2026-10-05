/**
 * Trusted-document settlement regressions for the real daemon session host.
 *
 * These tests create the REAL `createDaemonSessionHost` over a real temp
 * workspace (the trusted builtin `doc` identity is discovered from the actual
 * standard library) and inject the REAL `AgentExecutionHost` seam through
 * `setAgentExecutionHost`. Task admission is a narrow structural fake cast to
 * the existing `TaskService` surface — no new production export, test-only
 * port, paid model, native client, or network call is used.
 *
 * The host must settle a trusted document run by cancelling an aborted
 * queued/running run exactly once and awaiting the existing native execution
 * promise, never by polling. Deferred promises gate completion so no wall-clock
 * sleep is required. Every assertion is observable through the public host API.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createDaemonSessionHost } from '../../lib/daemon/services/session-host.mts'
import { setAgentExecutionHost } from '../../lib/core/operations/primitives/agent.mts'
import type { AgentExecutionHost } from '../../lib/core/operations/types.mts'
import type { TaskService } from '../../lib/core/task/service.mts'
import { resetRegistry } from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'

type Host = ReturnType<typeof createDaemonSessionHost>

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush pending microtasks without a wall-clock sleep. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

let root: string
let workspaceRoot: string
let stateRoot: string
let waitExecutionCalls: string[]
let waitExecutionImpl: (executionId: string) => Promise<unknown>

beforeEach(() => {
  resetRegistry()
  invalidateProjectCache()
  root = mkdtempSync(join(tmpdir(), 'wy-doc-settlement-'))
  workspaceRoot = join(root, 'ws')
  stateRoot = join(root, 'state')
  mkdirSync(workspaceRoot, { recursive: true })
  waitExecutionCalls = []
  waitExecutionImpl = async () => ({})
  setAgentExecutionHost({
    startExecution: async () => {
      throw new Error('startExecution is not used by this test')
    },
    waitExecution: (executionId: string) => {
      waitExecutionCalls.push(executionId)
      return waitExecutionImpl(executionId)
    },
    getExecution: () => undefined,
    cancelExecution: async () => undefined,
  } as unknown as AgentExecutionHost)
})

afterEach(() => {
  setAgentExecutionHost(undefined)
  resetRegistry()
  invalidateProjectCache()
  rmSync(root, { recursive: true, force: true })
})

interface FakeTaskServiceOptions {
  wait: (taskRunId: string, signal: AbortSignal | undefined) => Promise<Record<string, unknown>>
  status?: (taskRunId: string) => Record<string, unknown> | null
  cancel?: (taskRunId: string) => Promise<Record<string, unknown>>
}

interface FakeTaskService {
  service: TaskService
  statusCalls: () => number
  waitCalls: () => number
}

function makeTaskService(options: FakeTaskServiceOptions): FakeTaskService {
  let statusCalls = 0
  let waitCalls = 0
  const service = {
    async run() {
      return { id: 'run-1', task_run_id: 'run-1', hint: 'ok' }
    },
    async wait(taskRunId: string, _timeoutMs?: number, signal?: AbortSignal) {
      waitCalls += 1
      return options.wait(taskRunId, signal)
    },
    status(taskRunId: string) {
      statusCalls += 1
      return options.status ? options.status(taskRunId) : null
    },
    async cancel(taskRunId: string) {
      return options.cancel ? options.cancel(taskRunId) : {}
    },
  }
  return {
    service: service as unknown as TaskService,
    statusCalls: () => statusCalls,
    waitCalls: () => waitCalls,
  }
}

function makeHost(options: FakeTaskServiceOptions): { host: Host; fake: FakeTaskService } {
  const fake = makeTaskService(options)
  const host = createDaemonSessionHost({
    workspaceRoot,
    stateRoot,
    resolveInferenceProvider: () => undefined,
    gateway: async () => {
      throw new Error('gateway must not be used by this test')
    },
    taskService: fake.service,
  })
  return { host, fake }
}

/** Admit a real trusted builtin `doc` run (identity discovered from the library). */
async function admitDoc(host: Host): Promise<string> {
  const { taskRunId } = await host.createTaskRun({
    task: 'doc',
    project: 'alpha',
    input: {
      targetProject: 'alpha',
      category: 'spec',
      targetPath: 'projects/alpha/docs/specs/x.md',
      intent: 'write',
      conversation: 'full conversation',
    },
  })
  return taskRunId
}

describe('trusted document native settlement', () => {
  it('gates the host wait on the existing native execution promise', async () => {
    const gate = deferred<void>()
    waitExecutionImpl = () => gate.promise
    const { host } = makeHost({
      wait: async () => ({ status: 'done', output: 'doc written', _meta: { execution_id: 'exec-1' } }),
      status: () => ({ status: 'done', _meta: { execution_id: 'exec-1' } }),
    })
    const taskRunId = await admitDoc(host)

    let settled = false
    const pending = host.waitTaskRun(taskRunId, new AbortController().signal).then((result) => {
      settled = true
      return result
    })
    await flush()
    assert.equal(settled, false, 'the host wait must stay pending while the native execution is unsettled')
    assert.deepEqual(waitExecutionCalls, ['exec-1'])

    gate.resolve()
    const result = await pending
    assert.equal(settled, true)
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'doc written')
  })

  it('cancels an aborted queued/running trusted run exactly once before fencing', async () => {
    let cancelCalls = 0
    const { host } = makeHost({
      wait: async () => ({ status: 'running', output: '' }),
      status: () => ({ status: 'running', _meta: { execution_id: 'exec-2' } }),
      cancel: async () => {
        cancelCalls += 1
        return {}
      },
    })
    const taskRunId = await admitDoc(host)
    const controller = new AbortController()
    controller.abort()

    await host.waitTaskRun(taskRunId, controller.signal)
    assert.equal(cancelCalls, 1, 'an aborted non-terminal run is cancelled once')
    assert.deepEqual(waitExecutionCalls, ['exec-2'])
  })

  it('never re-cancels an already terminal trusted run', async () => {
    let cancelCalls = 0
    const { host } = makeHost({
      wait: async () => ({ status: 'done', output: 'ok' }),
      status: () => ({ status: 'done', _meta: { execution_id: 'exec-3' } }),
      cancel: async () => {
        cancelCalls += 1
        return {}
      },
    })
    const taskRunId = await admitDoc(host)
    const controller = new AbortController()
    controller.abort()

    await host.waitTaskRun(taskRunId, controller.signal)
    assert.equal(cancelCalls, 0, 'a terminal run is never re-cancelled')
  })

  it('does not read status or fence the native execution for an ordinary task', async () => {
    const { host, fake } = makeHost({
      wait: async () => ({ status: 'done', output: 'ok' }),
      status: () => {
        throw new Error('status must not be read for an ordinary task')
      },
    })
    const { taskRunId } = await host.createTaskRun({ task: 'edit', project: 'alpha', input: {} })

    const result = await host.waitTaskRun(taskRunId, new AbortController().signal)
    assert.equal(result.status, 'done')
    assert.equal(fake.statusCalls(), 0)
    assert.deepEqual(waitExecutionCalls, [])
  })

  it('propagates a native fence rejection when the task wait itself succeeded', async () => {
    waitExecutionImpl = async () => {
      throw new Error('native fence failed')
    }
    const { host } = makeHost({
      wait: async () => ({ status: 'done', output: 'ok', _meta: { execution_id: 'exec-4' } }),
      status: () => ({ status: 'done', _meta: { execution_id: 'exec-4' } }),
    })
    const taskRunId = await admitDoc(host)
    await assert.rejects(
      () => host.waitTaskRun(taskRunId, new AbortController().signal),
      /native fence failed/,
    )
  })

  it('preserves the original wait rejection when both the wait and the fence reject', async () => {
    waitExecutionImpl = async () => {
      throw new Error('native fence failed')
    }
    const { host } = makeHost({
      wait: async () => {
        throw new Error('task wait failed')
      },
      status: () => ({ status: 'done', _meta: { execution_id: 'exec-5' } }),
    })
    const taskRunId = await admitDoc(host)
    await assert.rejects(
      () => host.waitTaskRun(taskRunId, new AbortController().signal),
      /task wait failed/,
    )
  })

  it('clears the trusted-run record so a repeated wait is not re-fenced', async () => {
    const { host, fake } = makeHost({
      wait: async () => ({ status: 'done', output: 'ok', _meta: { execution_id: 'exec-6' } }),
      status: () => ({ status: 'done', _meta: { execution_id: 'exec-6' } }),
    })
    const taskRunId = await admitDoc(host)

    await host.waitTaskRun(taskRunId, new AbortController().signal)
    assert.equal(fake.statusCalls(), 1)
    assert.deepEqual(waitExecutionCalls, ['exec-6'])

    await host.waitTaskRun(taskRunId, new AbortController().signal)
    assert.equal(fake.statusCalls(), 1, 'the second wait must not re-read the run status')
    assert.deepEqual(waitExecutionCalls, ['exec-6'], 'the second wait must not re-fence the native execution')
    assert.equal(fake.waitCalls(), 2)
  })
})
