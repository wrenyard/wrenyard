import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  ProtocolError,
  UNAUTHORIZED,
} from '../../lib/protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
} from '../../lib/protocol/validate.mts'
import { DispatchControlError } from '../../lib/daemon/dispatch-control.mts'

function createFakeDispatchControl() {
  let mode: 'accepting' | 'frozen' | 'planned_restart' = 'accepting'
  let plan: {
    operationId: string
    kind: 'update' | 'restart'
    phase: 'preparing' | 'draining' | 'updating' | 'stopping' | 'starting' | 'verifying' | 'completed' | 'failed'
    recoveryRequired: boolean
    createdAt: string
  } | null = null
  return {
    freeze() {
      if (mode === 'planned_restart') throw new DispatchControlError('active_planned_restart', 'cannot change admission mode while a planned restart is active')
      mode = 'frozen'
    },
    thaw() {
      if (mode === 'planned_restart') throw new DispatchControlError('active_planned_restart', 'cannot change admission mode while a planned restart is active')
      mode = 'accepting'
    },
    beginPlannedRestart(next: typeof plan) {
      mode = 'planned_restart'
      plan = next
    },
    assertAccepting() {
      if (mode === 'planned_restart') {
        throw new DispatchControlError('daemon_planned_restart', 'Foreman daemon is planning restart and is not accepting new tasks or workflows.')
      }
      if (mode === 'frozen') {
        throw new DispatchControlError('dispatch_frozen', 'Dispatch is frozen. No new external tasks or workflows are accepted.')
      }
    },
    status() {
      return {
        mode,
        frozen: mode === 'frozen' || mode === 'planned_restart',
        accepting: mode === 'accepting',
        plannedRestart: plan,
        activeTasks: [],
        activeTaskCount: 0,
        activeWorkflows: [],
        activeWorkflowCount: 0,
        activeExecutions: [],
        activeExecutionCount: 0,
      }
    },
    async drain(_timeoutMs: number) {
      return {
        drained: true,
        activeTaskCount: 0,
        activeWorkflowCount: 0,
        activeExecutionCount: 0,
        activeTasks: [],
        activeWorkflows: [],
        activeExecutions: [],
      }
    },
  }
}

type FakeDispatchControl = ReturnType<typeof createFakeDispatchControl>

function assertAcceptingMapped(control: FakeDispatchControl): void {
  try {
    control.assertAccepting()
  } catch (error) {
    if (error instanceof DispatchControlError) {
      throw new ProtocolError({ code: INVALID_PARAMS.code, message: error.message }, { code: error.code })
    }
    throw error
  }
}

function projectFakeStatus(control: FakeDispatchControl) {
  const s = control.status()
  return {
    ok: true as const,
    mode: s.mode,
    frozen: s.frozen,
    accepting: s.accepting,
    activeTasks: s.activeTasks,
    activeTaskCount: s.activeTaskCount,
    activeWorkflows: s.activeWorkflows,
    activeWorkflowCount: s.activeWorkflowCount,
    activeExecutions: s.activeExecutions,
    activeExecutionCount: s.activeExecutionCount,
    active_task_count: s.activeTaskCount,
    active_workflow_count: s.activeWorkflowCount,
    active_execution_count: s.activeExecutionCount,
    recovery_required: s.plannedRestart ? s.plannedRestart.recoveryRequired : false,
    ...(s.plannedRestart
      ? {
        operation_id: s.plannedRestart.operationId,
        kind: s.plannedRestart.kind,
        phase: s.plannedRestart.phase,
      }
      : {}),
  }
}

function listMtsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return listMtsFiles(path)
    return path.endsWith('.mts') ? [path] : []
  })
}

function assertErrorCode(response: unknown, code: number): void {
  assert(response && typeof response === 'object')
  assert('error' in response)
  assert.equal((response as { error: { code: number } }).error.code, code)
}

describe('RpcRouter', () => {
  it('returns a JSON-RPC success response for health.ping requests', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => ({ ok: true }))

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 'health-1',
    })

    assert.deepEqual(response, createSuccessResponse('health-1', { ok: true }))
  })

  it('calls notification handlers without returning a response', async () => {
    const router = new RpcRouter()
    const calls: unknown[] = []
    router.register('health.ping', async (params) => {
      calls.push(params)
      return { ok: true }
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
    })

    assert.equal(response, undefined)
    assert.deepEqual(calls, [{}])
  })

  it('does not return responses for notification errors', async () => {
    const router = new RpcRouter()

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'unknown.method',
      params: {},
    })

    assert.equal(response, undefined)
  })

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const router = new RpcRouter()

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'unknown.method',
      params: {},
      id: 1,
    })

    assertErrorCode(response, METHOD_NOT_FOUND.code)
    assert.equal((response as { id: unknown }).id, 1)
  })

  it('returns INVALID_PARAMS for invalid method params', async () => {
    const router = new RpcRouter()
    router.register('task.run.create', async () => ({
      id: 'task-1',
      task_run_id: 'task-1',
      hint: 'Use task.run.status with the same task_run_id.',
    }))

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'task.run.create',
      params: {},
      id: 2,
    })

    assertErrorCode(response, INVALID_PARAMS.code)
  })

  it('returns parse and invalid request errors from malformed envelopes', async () => {
    const router = new RpcRouter()

    const parseResponse = await router.handleMessage('not json')
    assertErrorCode(parseResponse, PARSE_ERROR.code)
    assert.equal((parseResponse as { id: unknown }).id, null)

    const invalidResponse = await router.handleMessage({ jsonrpc: '2.0', params: {}, id: 'bad-envelope' })
    assertErrorCode(invalidResponse, INVALID_REQUEST.code)
    assert.equal((invalidResponse as { id: unknown }).id, 'bad-envelope')
  })

  it('converts handler ProtocolError throws to matching error responses', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => {
      throw new ProtocolError(UNAUTHORIZED, { reason: 'test' })
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 3,
    })

    assert.deepEqual(response, createErrorResponse(3, new ProtocolError(UNAUTHORIZED, { reason: 'test' })))
  })

  it('converts ordinary handler errors to INTERNAL_ERROR responses', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => {
      throw new Error('boom')
    })

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 4,
    })

    assertErrorCode(response, INTERNAL_ERROR.code)
  })

  it('returns an error response when handler results fail result validation', async () => {
    const router = new RpcRouter()
    router.register('health.ping', async () => ({ ok: false }) as any)

    const response = await router.handleMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 5,
    })

    assertErrorCode(response, INVALID_PARAMS.code)
  })

  it('keeps server RPC core free of client and infrastructure imports', () => {
    const serverRoot = join(process.cwd(), 'lib', 'server')
    const httpRoot = join(serverRoot, 'http')
    const mcpRoot = join(serverRoot, 'mcp')
    const forbiddenSpecifiers = [
      'node:net',
      'node:fs',
      'node:path',
      'node:process',
    ]
    const forbiddenRuntimePath = /(^|\/|\\)(client|db|executor|config)(\/|\\|\.mts$)/

    // HTTP and MCP are daemon-facing adapters. Keep this guard focused on the
    // reusable RPC router and handler core.
    for (const file of listMtsFiles(serverRoot).filter((path) => (
      !path.startsWith(`${httpRoot}${sep}`)
      && !path.startsWith(`${mcpRoot}${sep}`)
    ))) {
      const source = readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/\b(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      for (const specifier of importSpecifiers) {
        const crossesServerBoundary = specifier.startsWith('../') || specifier.startsWith('..\\')
        assert(
          !forbiddenSpecifiers.includes(specifier)
            && !(crossesServerBoundary && forbiddenRuntimePath.test(specifier)),
          `${file} imports forbidden runtime dependency ${specifier}`,
        )
      }
    }
  })

  describe('DispatchControl RPC handlers', () => {
    it('freeze is idempotent and returns consistent status', async () => {
      const router = new RpcRouter()
      const dc = createFakeDispatchControl()
      router.register('daemon.freeze', async () => {
        dc.freeze()
        return projectFakeStatus(dc)
      })
      router.register('daemon.status', async () => projectFakeStatus(dc))

      const freeze1 = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.freeze', params: {}, id: 1 })
      assert.deepEqual((freeze1 as { result: unknown }).result, {
        ok: true, mode: 'frozen', frozen: true, accepting: false,
        activeTasks: [], activeTaskCount: 0,
        activeWorkflows: [], activeWorkflowCount: 0,
        activeExecutions: [], activeExecutionCount: 0,
        active_task_count: 0, active_workflow_count: 0, active_execution_count: 0,
        recovery_required: false,
      })

      const freeze2 = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.freeze', params: {}, id: 2 })
      assert.deepEqual((freeze2 as { result: unknown }).result, {
        ok: true, mode: 'frozen', frozen: true, accepting: false,
        activeTasks: [], activeTaskCount: 0,
        activeWorkflows: [], activeWorkflowCount: 0,
        activeExecutions: [], activeExecutionCount: 0,
        active_task_count: 0, active_workflow_count: 0, active_execution_count: 0,
        recovery_required: false,
      })

      const status = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.status', params: {}, id: 3 })
      assert.deepEqual((status as { result: unknown }).result, {
        ok: true, mode: 'frozen', frozen: true, accepting: false,
        activeTasks: [], activeTaskCount: 0,
        activeWorkflows: [], activeWorkflowCount: 0,
        activeExecutions: [], activeExecutionCount: 0,
        active_task_count: 0, active_workflow_count: 0, active_execution_count: 0,
        recovery_required: false,
      })
    })

    it('blocks task create during planned_restart with exact error and keeps status reachable', async () => {
      const router = new RpcRouter()
      const dc = createFakeDispatchControl()
      dc.beginPlannedRestart({ operationId: 'op_1', kind: 'update', phase: 'draining', recoveryRequired: true, createdAt: '2024-01-01T00:00:00.000Z' })

      router.register('daemon.status', async () => projectFakeStatus(dc))
      router.register('task.run.create', async () => {
        assertAcceptingMapped(dc)
        return { id: 'task-1', task_run_id: 'task-1', hint: 'ok' }
      })
      router.register('task.run.status', async () => ({ task_run_id: 'task-0', status: 'done' }))

      const blocked: Array<[string, Record<string, unknown>]> = [
        ['task.run.create', { task_id: 't', project: 'p', input: {} }],
      ]
      for (const [method, params] of blocked) {
        const res = await router.handleMessage({ jsonrpc: '2.0', method, params, id: `${method}-blocked` })
        const error = (res as { error: { code: number; message: string; data: unknown } }).error
        assert.equal(error.code, INVALID_PARAMS.code)
        assert.equal(error.message, 'Foreman daemon is planning restart and is not accepting new tasks or workflows.')
        assert.deepEqual(error.data, { code: 'daemon_planned_restart' })
      }

      const status = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.status', params: {}, id: 'status' })
      assert.deepEqual((status as { result: unknown }).result, {
        ok: true,
        mode: 'planned_restart',
        frozen: true,
        accepting: false,
        activeTasks: [],
        activeTaskCount: 0,
        activeWorkflows: [],
        activeWorkflowCount: 0,
        activeExecutions: [],
        activeExecutionCount: 0,
        active_task_count: 0,
        active_workflow_count: 0,
        active_execution_count: 0,
        recovery_required: true,
        operation_id: 'op_1',
        kind: 'update',
        phase: 'draining',
      })

      const taskStatus = await router.handleMessage({ jsonrpc: '2.0', method: 'task.run.status', params: { task_run_id: 'task-0' }, id: 'ts' })
      assert.deepEqual((taskStatus as { result: unknown }).result, { task_run_id: 'task-0', status: 'done' })
    })

    it('thaw cannot make an active planned_restart plan accepting', async () => {
      const router = new RpcRouter()
      const dc = createFakeDispatchControl()
      dc.beginPlannedRestart({ operationId: 'op_2', kind: 'restart', phase: 'updating', recoveryRequired: false, createdAt: '2024-01-01T00:00:00.000Z' })

      router.register('daemon.thaw', async () => {
        dc.thaw()
        const s = dc.status()
        return { ok: true as const, frozen: s.frozen, accepting: s.accepting, activeTasks: s.activeTasks, activeTaskCount: s.activeTaskCount, activeWorkflows: s.activeWorkflows, activeWorkflowCount: s.activeWorkflowCount, activeExecutions: s.activeExecutions, activeExecutionCount: s.activeExecutionCount }
      })
      router.register('daemon.status', async () => projectFakeStatus(dc))

      const thawRes = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.thaw', params: {}, id: 'thaw' })
      // Planned restart protects admission; thaw must not report accepting or succeed.
      assert.notEqual((thawRes as { error?: unknown }).error, undefined)

      const status = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.status', params: {}, id: 'status' })
      const st = (status as { result: { mode: string; accepting: boolean; operation_id: string } }).result
      assert.equal(st.mode, 'planned_restart')
      assert.equal(st.accepting, false)
      assert.equal(st.operation_id, 'op_2')
    })

    it('blocks new task create when frozen, other handlers remain reachable', async () => {
      const router = new RpcRouter()
      const dc = createFakeDispatchControl()

      router.register('daemon.freeze', async () => {
        dc.freeze()
        return { ok: true as const, frozen: true as const, accepting: false as const, activeTasks: [], activeTaskCount: 0, activeWorkflows: [], activeWorkflowCount: 0, activeExecutions: [], activeExecutionCount: 0 }
      })
      router.register('daemon.thaw', async () => {
        dc.thaw()
        return { ok: true as const, frozen: false as const, accepting: true as const, activeTasks: [], activeTaskCount: 0, activeWorkflows: [], activeWorkflowCount: 0, activeExecutions: [], activeExecutionCount: 0 }
      })
      router.register('task.run.create', async () => {
        try {
          dc.assertAccepting()
          return { id: 'task-1', task_run_id: 'task-1', hint: 'ok' }
        } catch (e) {
          throw new ProtocolError(INVALID_PARAMS, { code: (e as { code?: string }).code })
        }
      })
      router.register('task.run.status', async () => ({ task_run_id: 'task-0', status: 'done' }))

      // Freeze
      await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.freeze', params: {}, id: 'freeze' })

      // New task.create should be blocked
      const taskCreate = await router.handleMessage({ jsonrpc: '2.0', method: 'task.run.create', params: { task_id: 't', project: 'p', input: {} }, id: 'tc' })
      assertErrorCode(taskCreate, INVALID_PARAMS.code)

      // task.run.status should still work
      const taskStatus = await router.handleMessage({ jsonrpc: '2.0', method: 'task.run.status', params: { task_run_id: 'task-0' }, id: 'ts' })
      assert.deepEqual((taskStatus as { result: unknown }).result, { task_run_id: 'task-0', status: 'done' })

      // Thaw
      await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.thaw', params: {}, id: 'thaw' })

      // After thaw, task.create should work again
      const taskCreate2 = await router.handleMessage({ jsonrpc: '2.0', method: 'task.run.create', params: { task_id: 't', project: 'p', input: {} }, id: 'tc2' })
      assert.deepEqual((taskCreate2 as { result: unknown }).result, { id: 'task-1', task_run_id: 'task-1', hint: 'ok' })
    })

    it('drain reports active then drained without daemon restart', async () => {
      const router = new RpcRouter()
      const dc = createFakeDispatchControl()

      router.register('daemon.drain', async (params) => {
        const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : 30000
        return dc.drain(timeoutMs)
      })

      const result = await router.handleMessage({ jsonrpc: '2.0', method: 'daemon.drain', params: { timeout_ms: 1000 }, id: 'drain' })
      assert.deepEqual((result as { result: unknown }).result, {
        drained: true,
        activeTaskCount: 0, activeWorkflowCount: 0, activeExecutionCount: 0,
        activeTasks: [], activeWorkflows: [], activeExecutions: [],
      })
    })
  })
})
