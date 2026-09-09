import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  ProtocolError,
} from '../../lib/protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcMessage,
  parseMethodParams,
  parseMethodResult,
} from '../../lib/protocol/validate.mts'
import {
  methodRegistry,
} from '../../lib/protocol/registry.mts'
import {
  STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
} from '../../lib/task-timeouts.mts'

const expectedMethods = [
  'activity.snapshot',
  'daemon.drain',
  'daemon.freeze',
  'daemon.shutdown',
  'daemon.status',
  'daemon.thaw',
  'health.ping',
  'event.list',
  'gateway.connection',
  'client.configuration.snapshot',
  'client.configuration.plan',
  'client.configuration.apply',
  'client.configuration.plan-restore',
  'client.configuration.restore',
  'provider.list',
  'provider.configure',
  'runtime.alias.snapshot',
  'runtime.alias.put',
  'runtime.alias.remove',
  'stats.today',
  'stats.summary',
  'task.definition.list',
  'task.definition.describe',
  'task.settings.snapshot',
  'task.settings.save',
  'task.run.create',
  'task.run.list',
  'task.run.status',
  'task.run.output',
  'task.run.wait',
  'task.run.cancel',
  'task.run.events',
  'project.list',
  'project.describe',
  'project.status',
  'project.pull',
  'project.push',
  'project.commitLog',
  'project.worktree.list',
  'project.worktree.create',
  'project.worktree.remove',
  'project.worktree.merge',
  'message.send',
  'taskgraph.create',
  'taskgraph.patch',
  'taskgraph.status',
  'taskgraph.events',
  'taskgraph.signal',
  'taskgraph.slip',
  'taskgraph.node.inspect',
  'taskgraph.inspect',
  'taskgraph.list',
  'taskgraph.wait',
  'workspace.doc.list',
  'workspace.doc.read',
  'workspace.doc.create',
  'workspace.doc.update',
]

function assertProtocolError(error: unknown, code: number): void {
  assert(error instanceof ProtocolError)
  assert.equal(error.code, code)
}

function listMtsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return listMtsFiles(path)
    return path.endsWith('.mts') ? [path] : []
  })
}

describe('lib/protocol JSON-RPC contract', () => {
  it('accepts a valid JSON-RPC request', () => {
    const message = parseJsonRpcMessage({
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 'request-1',
    })

    assert.deepEqual(message, {
      jsonrpc: '2.0',
      method: 'health.ping',
      params: {},
      id: 'request-1',
    })
  })

  it('accepts a notification without id', () => {
    const message = parseJsonRpcMessage({
      jsonrpc: '2.0',
      method: 'message.send',
      params: { to: 'relay', text: 'hello' },
    })

    assert.equal(message.method, 'message.send')
    assert.equal('id' in message, false)
  })

  it('rejects scalar JSON-RPC params values', () => {
    for (const params of ['bad', 3]) {
      assert.throws(
        () => parseJsonRpcMessage({
          jsonrpc: '2.0',
          method: 'health.ping',
          params,
          id: 'request-1',
        }),
        (error) => {
          assertProtocolError(error, INVALID_REQUEST.code)
          return true
        },
      )
    }
  })

  it('parses task.run.create params', () => {
    const params = parseMethodParams('task.run.create', {
      task_id: 'commit',
      project: 'foreman',
      worktree: 'wt-1',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
    })

    assert.deepEqual(params, {
      task_id: 'commit',
      project: 'foreman',
      worktree: 'wt-1',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
    })
  })

  it('rejects task.run.create params without task_id', () => {
    assert.throws(
      () => parseMethodParams('task.run.create', { project: 'foreman' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('accepts a valid invocation_settings layer on task.run.create params', () => {
    const invocation_settings = {
      mode: 'explicit',
      explicit_runtime: { kind: 'alias', name: 'prod' },
      timeout_ms: 42_000,
      automatic: { expected_tps: 20, minimum_tps: 10, intelligence_min: 'high' },
    }
    assert.deepEqual(parseMethodParams('task.run.create', {
      task_id: 'commit',
      project: 'foreman',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
      invocation_settings,
    }), {
      task_id: 'commit',
      project: 'foreman',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
      invocation_settings,
    })

    // An inline exact target reference round-trips too.
    const targetLayer = {
      mode: 'explicit',
      explicit_runtime: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' },
    }
    assert.deepEqual(parseMethodParams('task.run.create', {
      task_id: 'commit',
      project: 'foreman',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
      invocation_settings: targetLayer,
    }), {
      task_id: 'commit',
      project: 'foreman',
      input: { changes_to_commit: { 'src/x.ts': 'all' } },
      invocation_settings: targetLayer,
    })

    // Automatic mode with dispatch constraints round-trips too; the automatic
    // preferred_runtime stays a resolved client/provider/model triple.
    const automaticLayer = {
      mode: 'automatic',
      timeout_ms: 120_000,
      automatic: {
        expected_tps: 30,
        intelligence_min: 'mid',
        intelligence_max: 'premium',
        preferred_runtime: { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' },
      },
    }
    assert.deepEqual(parseMethodParams('task.run.create', {
      task_id: 'commit',
      project: 'foreman',
      invocation_settings: automaticLayer,
    }), {
      task_id: 'commit',
      project: 'foreman',
      invocation_settings: automaticLayer,
    })
  })

  it('rejects malformed mode, explicit_runtime, and timeout_ms in invocation_settings', () => {
    const base = { task_id: 'commit', project: 'foreman', input: {} }
    const malformedLayers: unknown[] = [
      { mode: 'manual' },
      // A copied client/provider/model triple is never a valid selection.
      { mode: 'explicit', explicit_runtime: { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' } },
      { mode: 'explicit', explicit_runtime: 'codex' },
      { mode: 'explicit', explicit_runtime: { kind: 'alias' } },
      { mode: 'explicit', explicit_runtime: { kind: 'alias', name: '' } },
      { mode: 'explicit', explicit_runtime: { kind: 'alias', name: 'prod', extra: 1 } },
      { mode: 'explicit', explicit_runtime: { kind: 'target' } },
      { mode: 'explicit', explicit_runtime: { kind: 'target', target: '' } },
      { mode: 'explicit', explicit_runtime: { kind: 'target', target: 'openai/x', extra: true } },
      { mode: 'explicit', explicit_runtime: { kind: 'profile', name: 'fast' } },
      { timeout_ms: 0 },
      { timeout_ms: -5 },
      { timeout_ms: '42000' },
      { mode: 'automatic', automatic: { intelligence_min: 'extreme' } },
    ]
    for (const invocation_settings of malformedLayers) {
      assert.throws(
        () => parseMethodParams('task.run.create', { ...base, invocation_settings }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
  })

  it('parses task definition/query/cancel params', () => {
    assert.deepEqual(parseMethodParams('task.definition.list', { project: 'workspace' }), { project: 'workspace' })
    assert.deepEqual(parseMethodParams('task.definition.describe', { task_id: 'commit', project: 'workspace' }), {
      task_id: 'commit',
      project: 'workspace',
    })
    assert.deepEqual(parseMethodParams('task.run.list', {}), {})
    assert.deepEqual(parseMethodParams('task.run.status', { task_run_id: 'task_1234' }), { task_run_id: 'task_1234' })
    assert.deepEqual(parseMethodParams('task.run.output', { task_run_id: 'task_1234' }), { task_run_id: 'task_1234' })
    assert.deepEqual(parseMethodParams('task.run.cancel', { task_run_id: 'task_1234' }), { task_run_id: 'task_1234' })
  })

  it('parses message command params', () => {
    assert.deepEqual(parseMethodParams('daemon.shutdown', { reason: 'test stop' }), { reason: 'test stop' })
    assert.deepEqual(parseMethodParams('daemon.shutdown', {}), {})

    assert.deepEqual(parseMethodParams('message.send', {
      to: 'relay',
      text: 'hello',
      sender: { role: 'codex' },
    }), {
      to: 'relay',
      text: 'hello',
      sender: { role: 'codex' },
    })

  })

  it('parses project command params', () => {
    assert.deepEqual(parseMethodParams('project.list', {}), {})
    assert.deepEqual(parseMethodParams('project.describe', { project: 'foreman' }), { project: 'foreman' })
    assert.deepEqual(parseMethodParams('project.status', { project: 'foreman' }), { project: 'foreman' })
    assert.deepEqual(parseMethodParams('project.status', {}), {})
    assert.deepEqual(parseMethodParams('project.pull', { project: 'foreman' }), { project: 'foreman' })
    assert.deepEqual(parseMethodParams('project.push', { project: 'foreman' }), { project: 'foreman' })
    assert.deepEqual(parseMethodParams('project.push', { worktree_id: 'deadbeef' }), { worktree_id: 'deadbeef' })
    assert.deepEqual(parseMethodParams('project.worktree.list', { project: 'foreman' }), { project: 'foreman' })
    assert.deepEqual(parseMethodParams('project.worktree.create', {
      project: 'foreman',
      worktree_id: 'deadbeef',
      branch: 'wrenyard/deadbeef',
    }), {
      project: 'foreman',
      worktree_id: 'deadbeef',
      branch: 'wrenyard/deadbeef',
    })
    assert.deepEqual(parseMethodParams('project.worktree.remove', { worktree_id: 'deadbeef' }), { worktree_id: 'deadbeef' })
    assert.deepEqual(parseMethodParams('project.worktree.merge', { project: 'foreman', worktree_id: 'deadbeef' }), {
      project: 'foreman',
      worktree_id: 'deadbeef',
    })
  })

  it('validates daemon control methods and status snapshots', () => {
    // freeze
    assert.deepEqual(parseMethodParams('daemon.freeze', {}), {})
    assert.deepEqual(parseMethodResult('daemon.freeze', {
      ok: true,
      frozen: true,
      accepting: false,
      activeTasks: ['task_1'],
      activeTaskCount: 1,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    }), {
      ok: true,
      frozen: true,
      accepting: false,
      activeTasks: ['task_1'],
      activeTaskCount: 1,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    })

    // thaw
    assert.deepEqual(parseMethodParams('daemon.thaw', {}), {})
    assert.deepEqual(parseMethodResult('daemon.thaw', {
      ok: true,
      frozen: false,
      accepting: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    }), {
      ok: true,
      frozen: false,
      accepting: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    })

    // drain
    assert.deepEqual(parseMethodParams('daemon.drain', { timeout_ms: 15000 }), { timeout_ms: 15000 })
    assert.deepEqual(parseMethodParams('daemon.drain', {}), {})
    assert.deepEqual(parseMethodResult('daemon.drain', {
      drained: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    }), {
      drained: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
    })

    assert.deepEqual(parseMethodResult('daemon.drain', {
      drained: false,
      activeTasks: ['task_1'],
      activeTaskCount: 1,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: ['exec_1'],
      activeExecutionCount: 1,
    }), {
      drained: false,
      activeTasks: ['task_1'],
      activeTaskCount: 1,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: ['exec_1'],
      activeExecutionCount: 1,
    })

    // status
    assert.deepEqual(parseMethodParams('daemon.status', {}), {})
    assert.deepEqual(parseMethodResult('daemon.status', {
      ok: true,
      mode: 'accepting',
      frozen: false,
      accepting: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
      active_task_count: 0,
      active_workflow_count: 0,
      active_execution_count: 0,
      recovery_required: false,
    }), {
      ok: true,
      mode: 'accepting',
      frozen: false,
      accepting: true,
      activeTasks: [],
      activeTaskCount: 0,
      activeWorkflows: [],
      activeWorkflowCount: 0,
      activeExecutions: [],
      activeExecutionCount: 0,
      active_task_count: 0,
      active_workflow_count: 0,
      active_execution_count: 0,
      recovery_required: false,
    })
  })

  it('validates planned_restart daemon.status and health.ping snapshots and rejects invalid plan values', () => {
    const plannedStatus = {
      ok: true,
      mode: 'planned_restart',
      frozen: true,
      accepting: false,
      activeTasks: ['task_1'],
      activeTaskCount: 1,
      activeWorkflows: ['wf_1'],
      activeWorkflowCount: 1,
      activeExecutions: ['exec_1'],
      activeExecutionCount: 1,
      active_task_count: 1,
      active_workflow_count: 1,
      active_execution_count: 1,
      recovery_required: true,
      operation_id: 'op_abc',
      kind: 'update',
      phase: 'draining',
    }
    assert.deepEqual(parseMethodResult('daemon.status', plannedStatus), plannedStatus)

    const plannedHealth = {
      ok: true,
      uptimeMs: 7000,
      dispatch: {
        mode: 'planned_restart',
        frozen: true,
        accepting: false,
        activeTaskCount: 2,
        activeWorkflowCount: 0,
        activeExecutionCount: 1,
        active_task_count: 2,
        active_workflow_count: 0,
        active_execution_count: 1,
        recovery_required: true,
        operation_id: 'op_xyz',
        kind: 'restart',
        phase: 'updating',
      },
    }
    assert.deepEqual(parseMethodResult('health.ping', plannedHealth), plannedHealth)

    // invalid mode (daemon.status)
    assert.throws(
      () => parseMethodResult('daemon.status', {
        ...plannedStatus,
        mode: 'weird',
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // invalid kind
    assert.throws(
      () => parseMethodResult('daemon.status', {
        ...plannedStatus,
        kind: 'other',
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // invalid phase
    assert.throws(
      () => parseMethodResult('daemon.status', {
        ...plannedStatus,
        phase: 'idle',
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // negative active count
    assert.throws(
      () => parseMethodResult('daemon.status', {
        ...plannedStatus,
        active_task_count: -1,
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // non-boolean recovery_required
    assert.throws(
      () => parseMethodResult('daemon.status', {
        ...plannedStatus,
        recovery_required: 'yes',
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('rejects invalid drain timeout values', () => {
    assert.throws(
      () => parseMethodParams('daemon.drain', { timeout_ms: 0 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('daemon.drain', { timeout_ms: -1 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('accepts backwards-compatible health payload with optional dispatch', () => {
    assert.deepEqual(parseMethodResult('health.ping', {
      ok: true,
      uptimeMs: 5000,
    }), {
      ok: true,
      uptimeMs: 5000,
    })
    assert.deepEqual(parseMethodResult('health.ping', {
      ok: true,
      uptimeMs: 5000,
      dispatch: {
        frozen: false,
        accepting: true,
        activeTaskCount: 0,
        activeWorkflowCount: 0,
        activeExecutionCount: 0,
      },
    }), {
      ok: true,
      uptimeMs: 5000,
      dispatch: {
        frozen: false,
        accepting: true,
        activeTaskCount: 0,
        activeWorkflowCount: 0,
        activeExecutionCount: 0,
      },
    })
  })

  it('validates task service-shaped results', () => {
    assert.deepEqual(parseMethodResult('daemon.shutdown', {
      ok: true,
      shutting_down: true,
      reason: 'foreman daemon stop',
    }), {
      ok: true,
      shutting_down: true,
      reason: 'foreman daemon stop',
    })

    assert.deepEqual(parseMethodResult('task.run.create', {
      id: 'task_1234',
      task_run_id: 'task_1234',
      hint: 'Use task_status with id "task_1234" for status.',
    }), {
      id: 'task_1234',
      task_run_id: 'task_1234',
      hint: 'Use task_status with id "task_1234" for status.',
    })

    assert.deepEqual(parseMethodResult('task.run.list', {
      tasks: ['task_1234'],
      count: 1,
    }), {
      tasks: ['task_1234'],
      count: 1,
    })

    assert.deepEqual(parseMethodResult('task.definition.list', [{
      name: 'commit',
      source: 'workspace',
      effectiveTimeoutMs: STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: 'task_execution',
    }]), [{
      name: 'commit',
      source: 'workspace',
      effectiveTimeoutMs: STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: 'task_execution',
    }])

    const enrichedGatewayResult = {
      openaiChatBaseUrl: 'http://127.0.0.1:4000/v1',
      openaiResponsesBaseUrl: 'http://127.0.0.1:4000/v1',
      anthropicBaseUrl: 'http://127.0.0.1:4000',
      token: 'gateway-token',
      models: [{
        id: 'claude-sonnet-4-5',
        publicId: 'claude-sonnet-4-5',
        provider: 'anthropic',
        displayName: 'Claude Sonnet 4.5',
        contextWindow: 200000,
        maxTokens: 8192,
        taskOnly: false,
        family: 'claude',
        claudeTier: 'sonnet',
        supports1MContext: true,
        intelligence: 'frontier',
        maxOutputTokens: 8192,
        capabilities: ['text', 'image'],
        reasoningEffort: 'high',
        speed: {
          tps: 40,
          source: 'catalog',
          checkedAt: '2026-09-05T00:00:00.000Z',
          conservative: true,
          basis: 'rolling benchmark',
        },
        pricing: {
          inputUsdPerMillion: 3,
          cachedInputUsdPerMillion: 0.3,
          outputUsdPerMillion: 15,
          source: 'catalog',
          checkedAt: '2026-09-05T00:00:00.000Z',
        },
      }],
    }
    assert.deepEqual(parseMethodResult('gateway.connection', enrichedGatewayResult), enrichedGatewayResult)

    const dispatchSummary = {
      name: 'dispatch-task',
      source: 'workspace',
      displayName: '调度任务',
      dispatch: {
        expectedTps: 20,
        minimumTps: 10,
        intelligenceMin: 'high',
        intelligenceMax: 'premium',
        maxOutputUsdPerMillion: 5,
        requiredCapabilities: ['text'],
        excludeModelIds: ['model-old'],
        excludeProfileIds: ['profile-old'],
        excludeClientIds: ['client-old'],
        excludeProviderIds: ['provider-old'],
        preferredRuntime: { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' },
      },
    }
    assert.deepEqual(parseMethodResult('task.definition.list', [dispatchSummary]), [dispatchSummary])
    assert.throws(
      () => parseMethodResult('task.definition.list', [{
        ...dispatchSummary,
        dispatch: { ...dispatchSummary.dispatch, unsupported: true },
      }]),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    assert.deepEqual(parseMethodResult('task.definition.describe', {
      name: 'commit',
      source: 'workspace',
      displayName: 'Commit task',
      path: '/tmp/commit.task.ts',
      permission: 'readonly',
      timeoutMs: 7200000,
      effectiveTimeoutMs: 7200000,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: 'task_execution',
    }), {
      name: 'commit',
      source: 'workspace',
      displayName: 'Commit task',
      path: '/tmp/commit.task.ts',
      permission: 'readonly',
      timeoutMs: 7200000,
      effectiveTimeoutMs: 7200000,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: 'task_execution',
    })

    assert.deepEqual(parseMethodResult('task.run.status', {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      has_output: true,
      usage: { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false },
    }), {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      has_output: true,
      usage: { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false },
    })

    const minimalUsage = { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false }

    assert.deepEqual(parseMethodResult('task.run.output', {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
      usage: { ...minimalUsage },
    }), {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
      usage: { ...minimalUsage },
    })

    // task.run.wait shares the exact same enriched OutputResult envelope.
    assert.deepEqual(parseMethodResult('task.run.wait', {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
      usage: { ...minimalUsage },
    }), {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
      usage: { ...minimalUsage },
    })

    // status / output / wait reject results missing the required task_id or usage.
    const statusNoTaskId = {
      task_run_id: 'task_1234',
      status: 'done',
      has_output: true,
      usage: { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false },
    }
    const statusNoUsage = {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      has_output: true,
    }
    const outputNoTaskId = {
      task_run_id: 'task_1234',
      status: 'done',
      output: { result: 'ok' },
      usage: { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false },
    }
    const outputNoUsage = {
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
    }
    for (const [method, missingTaskId, missingUsage] of [
      ['task.run.status', statusNoTaskId, statusNoUsage],
      ['task.run.output', outputNoTaskId, outputNoUsage],
      ['task.run.wait', outputNoTaskId, outputNoUsage],
    ] as const) {
      assert.throws(
        () => parseMethodResult(method, missingTaskId),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
      assert.throws(
        () => parseMethodResult(method, missingUsage),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    assert.deepEqual(parseMethodResult('task.run.cancel', {
      ok: false,
      task_run_id: 'task_1234',
      status: 'done',
    }), {
      ok: false,
      task_run_id: 'task_1234',
      status: 'done',
    })

    assert.deepEqual(parseMethodResult('message.send', {
      accepted: true,
      message_id: 'msg_1234',
      delivery: { ok: true },
    }), {
      accepted: true,
      message_id: 'msg_1234',
      delivery: { ok: true },
    })

    assert.deepEqual(parseMethodResult('project.list', [{
      name: 'foreman',
      path: '/tmp/foreman',
      displayName: 'Foreman 平台',
      gitRemote: 'https://example.test/foreman.git',
    }, {
      name: 'legacy',
      path: '/tmp/legacy',
      gitRemote: 'https://example.test/legacy.git',
    }]), [{
      name: 'foreman',
      path: '/tmp/foreman',
      displayName: 'Foreman 平台',
      gitRemote: 'https://example.test/foreman.git',
    }, {
      name: 'legacy',
      path: '/tmp/legacy',
      gitRemote: 'https://example.test/legacy.git',
    }])

    assert.deepEqual(parseMethodResult('project.describe', {
      name: 'foreman',
      path: '/tmp/foreman',
      displayName: 'Foreman 平台',
    }), {
      name: 'foreman',
      path: '/tmp/foreman',
      displayName: 'Foreman 平台',
    })

    assert.deepEqual(parseMethodResult('project.status', {
      name: 'foreman',
      path: '/tmp/foreman',
      worktrees: [{ id: 'deadbeef', path: '/tmp/wt', branch: 'wrenyard/deadbeef', clean: true }],
    }), {
      name: 'foreman',
      path: '/tmp/foreman',
      worktrees: [{ id: 'deadbeef', path: '/tmp/wt', branch: 'wrenyard/deadbeef', clean: true }],
    })

    assert.deepEqual(parseMethodResult('project.status', [{
      name: 'foreman',
      path: '/tmp/foreman',
      worktree_count: 1,
    }]), [{
      name: 'foreman',
      path: '/tmp/foreman',
      worktree_count: 1,
    }])

    assert.deepEqual(parseMethodResult('project.pull', {
      project: 'foreman',
      path: '/tmp/foreman',
      branch: 'main',
      remote: 'origin',
      pulled: true,
      summary: 'Pulled foreman branch main from origin.',
    }), {
      project: 'foreman',
      path: '/tmp/foreman',
      branch: 'main',
      remote: 'origin',
      pulled: true,
      summary: 'Pulled foreman branch main from origin.',
    })

    assert.deepEqual(parseMethodResult('project.push', {
      project: 'foreman',
      path: '/tmp/foreman',
      branch: 'main',
      remote: 'origin',
      pushed: true,
      summary: 'Pushed foreman branch main to origin.',
    }), {
      project: 'foreman',
      path: '/tmp/foreman',
      branch: 'main',
      remote: 'origin',
      pushed: true,
      summary: 'Pushed foreman branch main to origin.',
    })

    assert.deepEqual(parseMethodResult('project.worktree.create', {
      project: 'foreman',
      worktree_id: 'deadbeef',
      path: '/tmp/wt',
      branch: 'wrenyard/deadbeef',
    }), {
      project: 'foreman',
      worktree_id: 'deadbeef',
      path: '/tmp/wt',
      branch: 'wrenyard/deadbeef',
    })

    assert.deepEqual(parseMethodResult('project.worktree.remove', {
      project: 'foreman',
      worktree_id: 'deadbeef',
      path: '/tmp/wt',
      removed: true,
    }), {
      project: 'foreman',
      worktree_id: 'deadbeef',
      path: '/tmp/wt',
      removed: true,
    })

    assert.deepEqual(parseMethodResult('project.worktree.merge', {
      project: 'foreman',
      worktree_id: 'deadbeef',
      merged: true,
      removed: true,
    }), {
      project: 'foreman',
      worktree_id: 'deadbeef',
      merged: true,
      removed: true,
    })
  })

  it('accepts provider_override as a permitted resolved speed source', () => {
    const usage = { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false }
    const dispatchWithSpeedSource = (source: string) => ({
      task_run_id: 'task_1234',
      task_id: 'commit',
      status: 'done',
      output: { result: 'ok' },
      resolved: {
        requested_agent_runtime: 'agent',
        profile: 'default',
        client: 'claude',
        provider: 'anthropic',
        model: 'sonnet',
        model_id: 'claude-sonnet-4',
        mode: 'native',
        speed: {
          effective_tps: 30,
          source,
          sample_count: 10,
          checked_at: '2026-01-01T00:00:00.000Z',
          expected_tps_met: true,
        },
        intelligence: 'mid',
        reference_pricing: {
          source: 'catalog',
          checked_at: '2026-01-01T00:00:00.000Z',
        },
      },
      usage,
    })
    // Every permitted resolved speed source round-trips through the wire schema.
    for (const source of ['local_31d', 'provider_override', 'catalog_default']) {
      const result = dispatchWithSpeedSource(source)
      assert.deepEqual(parseMethodResult('task.run.wait', result), result)
    }
    // Unknown sources stay rejected; existing validation is unchanged.
    assert.throws(
      () => parseMethodResult('task.run.wait', dispatchWithSpeedSource('unknown_source')),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('validates taskgraph.wait params and result shapes', () => {
    assert.deepEqual(parseMethodParams('taskgraph.wait', {
      taskgraph_id: 'tg_test',
      timeout_ms: 5000,
    }), {
      taskgraph_id: 'tg_test',
      timeout_ms: 5000,
    })
    assert.deepEqual(parseMethodParams('taskgraph.wait', { taskgraph_id: 'tg_test' }), { taskgraph_id: 'tg_test' })
    assert.throws(
      () => parseMethodParams('taskgraph.wait', {}),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('taskgraph.wait', { taskgraph_id: 'tg_test', timeout_ms: 0 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.deepEqual(parseMethodResult('taskgraph.wait', {
      taskgraph_id: 'tg_test',
      state: 'done',
      reason: 'done',
      structure_revision: 1,
      latest_seq: 5,
      node_counts: { planned: 0, running: 0, waiting: 0, done: 3, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: [] },
      terminal: { outcome: 'done', end_output: { status: 'ok' } },
    }), {
      taskgraph_id: 'tg_test',
      state: 'done',
      reason: 'done',
      structure_revision: 1,
      latest_seq: 5,
      node_counts: { planned: 0, running: 0, waiting: 0, done: 3, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: [] },
      terminal: { outcome: 'done', end_output: { status: 'ok' } },
    })
    assert.deepEqual(parseMethodResult('taskgraph.wait', {
      taskgraph_id: 'tg_test',
      state: 'running',
      reason: 'waiting',
      structure_revision: 1,
      latest_seq: 2,
      node_counts: { planned: 1, running: 0, waiting: 1, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: ['approval'] },
      checkpoint_node_id: 'approval',
    }), {
      taskgraph_id: 'tg_test',
      state: 'running',
      reason: 'waiting',
      structure_revision: 1,
      latest_seq: 2,
      node_counts: { planned: 1, running: 0, waiting: 1, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: ['approval'] },
      checkpoint_node_id: 'approval',
    })
  })

  it('validates activity.snapshot params and result shapes', () => {
    assert.deepEqual(parseMethodParams('activity.snapshot', {}), {})
    assert.deepEqual(parseMethodParams('activity.snapshot', {
      tracked_taskgraph_ids: ['tg_1', 'tg_2'],
    }), {
      tracked_taskgraph_ids: ['tg_1', 'tg_2'],
    })
    // Duplicates pass schema validation; dedup is enforced by the projection.
    assert.deepEqual(parseMethodParams('activity.snapshot', { tracked_taskgraph_ids: ['tg_1', 'tg_1'] }), {
      tracked_taskgraph_ids: ['tg_1', 'tg_1'],
    })
    assert.throws(
      () => parseMethodParams('activity.snapshot', { tracked_taskgraph_ids: [''] }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('activity.snapshot', { tracked_taskgraph_ids: Array.from({ length: 129 }, (_, i) => `tg_${i}`) }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    const result = {
      schema_version: 'foreman.activity.snapshot.v1',
      sampled_at: '2026-08-05T00:00:00.000Z',
      tasks: [{
        task_run_id: 'task_1',
        status: 'running',
        task_id: 'build',
        project: 'p1',
        worktree: true,
        requested_agent_runtime: 'claude',
        resolved_profile: 'fast',
        created_at: '2026-08-05T00:00:00.000Z',
        updated_at: '2026-08-05T00:00:00.000Z',
        taskgraph_id: 'tg_1',
        node_id: 'main',
      }],
      taskgraphs: [{
        taskgraph_id: 'tg_1',
        state: 'running',
        title: 'Blueprint A',
        project: 'p1',
        on_node_failure: 'pause',
        cancel_requested: false,
        structure_revision: 2,
        latest_seq: 3,
        node_counts: { planned: 0, running: 1, waiting: 1, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['main'], waiting: ['wait'] },
        nodes: [{
          node_id: 'main',
          state: 'running',
          task_run_id: 'task_1',
          task_status: 'running',
          task_id: 'build',
          task_category: { id: 'build', display_label: 'Build' },
          display_label: 'Build',
          description: 'compile',
          requested_agent_runtime: 'claude',
          resolved_profile: 'fast',
          tool_call_count: 7,
          tps: 500,
          runtime_ms: 120000,
        }],
      }],
    }
    assert.deepEqual(parseMethodResult('activity.snapshot', result), result)

    // Terminal graph shape with terminal_reason and no node list leaks.
    const terminalResult = {
      schema_version: 'foreman.activity.snapshot.v1',
      sampled_at: '2026-08-05T00:00:00.000Z',
      tasks: [],
      taskgraphs: [{
        taskgraph_id: 'tg_done',
        state: 'done',
        on_node_failure: 'pause',
        cancel_requested: false,
        structure_revision: 3,
        latest_seq: 5,
        terminal_reason: 'success',
        node_counts: { planned: 0, running: 0, waiting: 0, done: 2, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
        nodes: [],
      }],
    }
    assert.deepEqual(parseMethodResult('activity.snapshot', terminalResult), terminalResult)

    // Non-negative integer runtime_ms values are accepted.
    assert.deepEqual(parseMethodResult('activity.snapshot', {
      ...result,
      taskgraphs: [{
        ...result.taskgraphs[0],
        nodes: [{ ...result.taskgraphs[0].nodes[0], runtime_ms: 0 }],
      }],
    }), {
      ...result,
      taskgraphs: [{
        ...result.taskgraphs[0],
        nodes: [{ ...result.taskgraphs[0].nodes[0], runtime_ms: 0 }],
      }],
    })

    // Negative, fractional, and non-numeric runtime_ms values are rejected.
    for (const invalidRuntimeMs of [-1, 1.5, '120', true]) {
      assert.throws(
        () => parseMethodResult('activity.snapshot', {
          ...result,
          taskgraphs: [{
            ...result.taskgraphs[0],
            nodes: [{ ...result.taskgraphs[0].nodes[0], runtime_ms: invalidRuntimeMs }],
          }],
        }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // The schema stays closed: runtime_ms is only a node field, never a task field.
    assert.throws(
      () => parseMethodResult('activity.snapshot', {
        ...result,
        tasks: [{ ...result.tasks[0], runtime_ms: 5 }],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Forbidden extra fields are rejected (whitelist enforcement).
    assert.throws(
      () => parseMethodResult('activity.snapshot', { ...result, prompt: 'secret' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodResult('activity.snapshot', {
        ...result,
        taskgraphs: [{
          ...result.taskgraphs[0],
          nodes: [{ node_id: 'main', state: 'running', raw_result: 'secret' }],
        }],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('validates task.settings.snapshot/save params and result shapes', () => {
    // Snapshot params: optional project only.
    assert.deepEqual(parseMethodParams('task.settings.snapshot', {}), {})
    assert.deepEqual(parseMethodParams('task.settings.snapshot', { project: 'workspace' }), { project: 'workspace' })

    // Save params: field-level reset and structural explicit references are accepted.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task',
      task_id: 'commit',
      expected_revision: 'rev-1',
      patch: { timeout_ms: null },
    }), {
      scope: 'task',
      task_id: 'commit',
      expected_revision: 'rev-1',
      patch: { timeout_ms: null },
    })
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task',
      task_id: 'commit',
      project: 'workspace',
      expected_revision: 'rev-1',
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'alias', name: 'prod' },
      },
    }), {
      scope: 'task',
      task_id: 'commit',
      project: 'workspace',
      expected_revision: 'rev-1',
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'alias', name: 'prod' },
      },
    })
    // An inline exact target reference round-trips through save as well.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task',
      task_id: 'commit',
      expected_revision: 'rev-1',
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' },
      },
    }), {
      scope: 'task',
      task_id: 'commit',
      expected_revision: 'rev-1',
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' },
      },
    })
    // Null resets the explicit reference back to automatic at the selected layer.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1', patch: { explicit_runtime: null },
    }), {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1', patch: { explicit_runtime: null },
    })
    // Nested null deletes only that automatic field at the selected layer.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1',
      patch: { automatic: { expected_tps: null, intelligence_min: null } },
    }), {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1',
      patch: { automatic: { expected_tps: null, intelligence_min: null } },
    })

    // Missing required fields are rejected.
    assert.throws(
      () => parseMethodParams('task.settings.save', { scope: 'task', task_id: 'commit', patch: {} }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('task.settings.save', { scope: 'task', task_id: 'commit', expected_revision: 'rev-1' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('task.settings.save', { task_id: 'commit', expected_revision: 'rev-1', patch: {} }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    // explicit_runtime must be a strict alias or inline target reference; a
    // copied selection triple, bare scalar, empty reference, unknown kind, or
    // mixed/extra key is rejected.
    const badExplicitRuntime: unknown[] = [
      3,
      {},
      { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' },
      { kind: 'alias' },
      { kind: 'alias', name: '' },
      { kind: 'alias', name: 'prod', target: 'openai/gpt-5.6-sol:codex' },
      { kind: 'alias', name: 'prod', extra: true },
      { kind: 'target' },
      { kind: 'target', target: '' },
      { kind: 'target', target: 'openai/gpt-5.6-sol:codex', name: 'prod' },
      { kind: 'policy', name: 'fast' },
      { kind: 'alias', name: 'prod', client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' },
    ]
    for (const explicit_runtime of badExplicitRuntime) {
      assert.throws(
        () => parseMethodParams('task.settings.save', {
          scope: 'task', task_id: 'commit', expected_revision: 'rev-1',
          patch: { mode: 'explicit', explicit_runtime },
        }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
    // Blank expected_revision is rejected.
    assert.throws(
      () => parseMethodParams('task.settings.save', {
        scope: 'task', task_id: 'commit', expected_revision: '', patch: { timeout_ms: null },
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Snapshot rows carry no definition runtime pin and no generated runtime
    // choices; combobox suggestions come from the snapshot-level aliases.
    const snapshotResult = {
      config_path: '/tmp/wrenyard/config.json',
      revision: 'rev-1',
      project: 'workspace',
      user_global: { max_auto_output_usd_per_million: 0 },
      aliases: [
        { name: 'web', target: 'openai/gpt-5.6-sol:codex' },
        { name: 'prod', target: 'anthropic-api/claude-sonnet-5:cc' },
      ],
      rows: [{
        identity: 'project:workspace:commit',
        name: 'commit',
        display_name: 'Commit helper',
        project: 'workspace',
        project_display_name: 'Workspace 平台',
        builtin: {
          identity: 'project:workspace:commit',
          name: 'commit',
          project: 'workspace',
          source: 'workspace',
          prompt_template: 'dynamic',
          instruction_template: [
            { kind: 'text', source: 'task.instructions[0]', text: 'Stage and commit the reviewed changes only.' },
            { kind: 'placeholder', source: 'task.instructions[1]', label: '运行时填入任务输入' },
            { kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' },
          ],
          timeout_ms: 900000,
          dispatch: { expected_tps: 20, minimum_tps: 10 },
        },
        user_task: {},
        effective: {
          mode: { value: 'automatic', source: 'builtin' },
          explicit_runtime: { value: null, source: 'system' },
          timeout_ms: { value: 900000, source: 'builtin' },
          max_auto_output_usd_per_million: { value: 0, source: 'user_global' },
          automatic: {
            expected_tps: { value: 20, source: 'builtin' },
            minimum_tps: { value: 10, source: 'builtin' },
            intelligence_min: { value: null, source: 'system' },
            intelligence_max: { value: null, source: 'system' },
            max_output_usd_per_million: { value: null, source: 'system' },
            required_capabilities: { value: null, source: 'system' },
            exclude_model_ids: { value: null, source: 'system' },
            exclude_profile_ids: { value: null, source: 'system' },
            exclude_client_ids: { value: null, source: 'system' },
            exclude_provider_ids: { value: null, source: 'system' },
            preferred_runtime: { value: null, source: 'system' },
          },
        },
        issues: [],
      }],
    }
    assert.deepEqual(parseMethodResult('task.settings.snapshot', snapshotResult), snapshotResult)
    assert.deepEqual(parseMethodResult('task.settings.save', snapshotResult), snapshotResult)

    // A positive global auto reference-price cap round-trips on the snapshot
    // user_global layer and effective row with its user_global source.
    const positiveCapResult = {
      ...snapshotResult,
      user_global: { max_auto_output_usd_per_million: 25 },
      rows: [{
        ...snapshotResult.rows[0],
        effective: {
          ...snapshotResult.rows[0].effective,
          max_auto_output_usd_per_million: { value: 25, source: 'user_global' },
        },
      }],
    }
    assert.deepEqual(parseMethodResult('task.settings.snapshot', positiveCapResult), positiveCapResult)
    assert.deepEqual(parseMethodResult('task.settings.save', positiveCapResult), positiveCapResult)

    // Negative or non-number cap values are rejected wherever the field appears.
    for (const badUserGlobal of [
      { max_auto_output_usd_per_million: -1 },
      { max_auto_output_usd_per_million: '5' },
    ]) {
      assert.throws(
        () => parseMethodResult('task.settings.snapshot', { ...snapshotResult, user_global: badUserGlobal }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // Global save patches accept 0, positive values, and an explicit null clear.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: 0 },
    }), {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: 0 },
    })
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: 12 },
    }), {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: 12 },
    })
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: null },
    }), {
      scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: null },
    })
    // The task-scope patch schema accepts the field (task-scope rejection is a
    // service-level guard), so a 0 cap also round-trips there.
    assert.deepEqual(parseMethodParams('task.settings.save', {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1',
      patch: { max_auto_output_usd_per_million: 0 },
    }), {
      scope: 'task', task_id: 'commit', expected_revision: 'rev-1',
      patch: { max_auto_output_usd_per_million: 0 },
    })
    assert.throws(
      () => parseMethodParams('task.settings.save', {
        scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: -1 },
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('task.settings.save', {
        scope: 'global', expected_revision: 'rev-1', patch: { max_auto_output_usd_per_million: '5' },
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // A persisted user-task override round-trips with its source.
    const overriddenResult = {
      ...snapshotResult,
      rows: [{
        ...snapshotResult.rows[0],
        user_task: { timeout_ms: 120000 },
        effective: {
          ...snapshotResult.rows[0].effective,
          timeout_ms: { value: 120000, source: 'user_task' },
        },
      }],
    }
    assert.deepEqual(parseMethodResult('task.settings.snapshot', overriddenResult), overriddenResult)

    // An explicit-mode row stores a structural reference and exposes its
    // canonical target, resolved dispatch, and readiness — never a copied
    // selection triple.
    const explicitResult = {
      ...snapshotResult,
      rows: [{
        ...snapshotResult.rows[0],
        user_task: {
          mode: 'explicit',
          explicit_runtime: { kind: 'alias', name: 'prod' },
        },
        effective: {
          ...snapshotResult.rows[0].effective,
          mode: { value: 'explicit', source: 'user_task' },
          explicit_runtime: { value: { kind: 'alias', name: 'prod' }, source: 'user_task' },
        },
        explicit: {
          reference: { kind: 'alias', name: 'prod' },
          resolved_target: 'anthropic-api/claude-sonnet-5:cc',
          resolved: null,
          readiness: {
            runtime: 'anthropic-api/claude-sonnet-5:cc',
            client: 'cc',
            provider: 'anthropic-api',
            model: 'claude-sonnet-5',
            daemon: 'accepting',
            provider_credential: 'available',
            provider_live: 'available',
            quota: 'available',
            available: true,
            issues: [],
          },
        },
      }],
    }
    assert.deepEqual(parseMethodResult('task.settings.snapshot', explicitResult), explicitResult)

    // An explicit inline target reference round-trips through an explicit row.
    const inlineTargetResult = {
      ...snapshotResult,
      rows: [{
        ...snapshotResult.rows[0],
        user_task: {
          mode: 'explicit',
          explicit_runtime: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' },
        },
        effective: {
          ...snapshotResult.rows[0].effective,
          mode: { value: 'explicit', source: 'user_task' },
          explicit_runtime: { value: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' }, source: 'user_task' },
        },
        explicit: {
          reference: { kind: 'target', target: 'openai/gpt-5.6-sol:codex' },
          resolved_target: null,
          resolved: null,
          readiness: null,
        },
      }],
    }
    assert.deepEqual(parseMethodResult('task.settings.snapshot', inlineTargetResult), inlineTargetResult)

    // The snapshot-level aliases list is the combobox input and stays closed.
    assert.throws(
      () => parseMethodResult('task.settings.snapshot', {
        ...snapshotResult,
        aliases: [{ name: 'prod' }],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodResult('task.settings.snapshot', {
        ...snapshotResult,
        aliases: [{ name: 'prod', target: 'openai/gpt-5.6-sol:codex', canonical: true }],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Result must describe config_path/revision/aliases/global layer and rows.
    assert.throws(
      () => parseMethodResult('task.settings.snapshot', {
        config_path: '/tmp/wrenyard/config.json',
        revision: 'rev-1',
        user_global: {},
        aliases: [],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodResult('task.settings.snapshot', {
        config_path: '/tmp/wrenyard/config.json',
        revision: 'rev-1',
        aliases: [],
        rows: [],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // An explicit row must expose the structural reference with its exact
    // resolution; stale selection-triple or picker shapes never appear.
    const malformedExplicitRows: unknown[] = [
      { resolved_target: null, resolved: null, readiness: null },
      { reference: { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna' }, resolved_target: null, resolved: null, readiness: null },
      { reference: { kind: 'alias' }, resolved_target: null, resolved: null, readiness: null },
      { reference: { kind: 'alias', name: 'prod' } },
      { reference: { kind: 'alias', name: 'prod' }, resolved_target: 'anthropic-api/claude-sonnet-5:cc', resolved: {}, readiness: null },
    ]
    for (const explicit of malformedExplicitRows) {
      assert.throws(
        () => parseMethodResult('task.settings.snapshot', {
          ...snapshotResult,
          rows: [{
            ...snapshotResult.rows[0],
            explicit,
          }],
        }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // Rows expose the authoritative display labels alongside the exact id/name.
    const labeledResult = parseMethodResult('task.settings.snapshot', snapshotResult) as {
      rows: Array<{ display_name: string; project_display_name?: string }>
    }
    assert.equal(labeledResult.rows[0]!.display_name, 'Commit helper')
    assert.equal(labeledResult.rows[0]!.project_display_name, 'Workspace 平台')

    // A backwards-compatible task definition payload without displayName stays valid.
    assert.deepEqual(parseMethodResult('task.definition.list', [{ name: 'legacy-task', source: 'workspace' }]), [
      { name: 'legacy-task', source: 'workspace' },
    ])

    // Malformed instruction-template segments fail validation.
    const malformedTemplates: unknown[] = [
      // text kind requires the verbatim text field.
      { kind: 'text', source: 'task.instructions[0]' },
      // placeholder kind requires a stable label.
      { kind: 'placeholder', source: 'task.instructions[1]' },
      // unknown kinds are rejected.
      { kind: 'function', source: 'task.instructions[0]', text: 'x' },
      // kind/text or kind/label mismatches are rejected.
      { kind: 'text', source: 'task.instructions[0]', label: 'nope' },
      { kind: 'placeholder', source: 'task.instructions[1]', text: 'nope' },
    ]
    for (const instruction_template of malformedTemplates) {
      assert.throws(
        () => parseMethodResult('task.settings.snapshot', {
          ...snapshotResult,
          rows: [{
            ...snapshotResult.rows[0],
            builtin: { ...snapshotResult.rows[0].builtin, instruction_template: [instruction_template] },
          }],
        }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
  })

  it('validates runtime.alias snapshot/put/remove params and result shapes', () => {
    // Snapshot takes no params and stays closed to extra fields.
    assert.deepEqual(parseMethodParams('runtime.alias.snapshot', {}), {})
    assert.throws(
      () => parseMethodParams('runtime.alias.snapshot', { filter: 'prod' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Valid put/remove params require the alias name plus the CAS revision.
    const validTarget = 'anthropic-api/claude-sonnet-5:cc'
    assert.deepEqual(parseMethodParams('runtime.alias.put', {
      name: 'prod',
      target: validTarget,
      expected_revision: 2,
    }), {
      name: 'prod',
      target: validTarget,
      expected_revision: 2,
    })
    assert.deepEqual(parseMethodParams('runtime.alias.remove', {
      name: 'prod',
      expected_revision: 2,
    }), {
      name: 'prod',
      expected_revision: 2,
    })

    // Missing expected_revision is rejected for both mutating methods.
    for (const [method, params] of [
      ['runtime.alias.put', { name: 'prod', target: validTarget }],
      ['runtime.alias.remove', { name: 'prod' }],
    ] as const) {
      assert.throws(
        () => parseMethodParams(method, params),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // Malformed alias/target types and revisions are rejected.
    const goodTarget = 'openai/gpt-5.6-sol:codex'
    for (const params of [
      { name: 42, target: goodTarget, expected_revision: 0 },
      { name: '', target: goodTarget, expected_revision: 0 },
      { name: 'Prod', target: goodTarget, expected_revision: 0 },
      { name: 'has/slash', target: goodTarget, expected_revision: 0 },
      { name: 'prod', target: 42, expected_revision: 0 },
      { name: 'prod', target: '', expected_revision: 0 },
      { name: 'prod', target: goodTarget, expected_revision: -1 },
      { name: 'prod', target: goodTarget, expected_revision: 1.5 },
      { name: 'prod', target: goodTarget, expected_revision: '0' },
    ]) {
      assert.throws(
        () => parseMethodParams('runtime.alias.put', params),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
    // Extra properties are rejected on mutating params.
    assert.throws(
      () => parseMethodParams('runtime.alias.put', {
        name: 'prod', target: goodTarget, expected_revision: 0, owner: 'me',
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('runtime.alias.remove', {
        name: 'prod', expected_revision: 0, force: true,
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // All three methods share the same closed snapshot result envelope.
    const snapshotResult = {
      config_path: '/tmp/wrenyard/runtime/config.json',
      revision: 3,
      aliases: [
        { name: 'web', target: 'openai/gpt-5.6-sol:codex' },
        { name: 'prod', target: 'anthropic-api/claude-sonnet-5:cc' },
      ],
      issues: [
        { name: 'broken', value: 'not-valid-run-syntax', message: 'unrecognized run syntax' },
        { name: 'typed', value: 42, message: 'alias target must be a string' },
      ],
    }
    assert.deepEqual(parseMethodResult('runtime.alias.snapshot', snapshotResult), snapshotResult)
    assert.deepEqual(parseMethodResult('runtime.alias.put', snapshotResult), snapshotResult)
    assert.deepEqual(parseMethodResult('runtime.alias.remove', snapshotResult), snapshotResult)

    // value is optional, and a malformed persisted '' alias name still
    // projects as a valid issue entry.
    assert.deepEqual(parseMethodResult('runtime.alias.snapshot', {
      ...snapshotResult,
      issues: [
        { name: 'typed', message: 'alias target must be a string' },
        { name: '', message: 'alias name must not be empty' },
      ],
    }), {
      ...snapshotResult,
      issues: [
        { name: 'typed', message: 'alias target must be a string' },
        { name: '', message: 'alias name must not be empty' },
      ],
    })

    // Malformed result entries are rejected rather than coerced.
    const malformedResults: unknown[] = [
      { ...snapshotResult, revision: undefined },
      { ...snapshotResult, credentials: { token: 'secret' } },
      { ...snapshotResult, aliases: [{ name: 'prod' }] },
      { ...snapshotResult, aliases: [{ name: 'prod', target: goodTarget, canonical: true }] },
      { ...snapshotResult, aliases: [{ name: 7, target: goodTarget }] },
      { ...snapshotResult, issues: [{ name: 'broken', value: 'x' }] },
      { ...snapshotResult, issues: [{ name: 'broken', value: { nested: 1 }, message: 'm' }] },
      { ...snapshotResult, issues: [{ name: 'broken', value: 42, message: '' }] },
    ]
    for (const malformed of malformedResults) {
      assert.throws(
        () => parseMethodResult('runtime.alias.snapshot', malformed),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
  })

  it('does not register the legacy prompt-shaped task.create method', () => {
    assert.throws(
      () => parseMethodParams('task.create', { prompt: 'old draft' }),
      (error) => {
        assertProtocolError(error, METHOD_NOT_FOUND.code)
        return true
      },
    )
  })

  it('rejects unknown methods with method-not-found semantics', () => {
    assert.throws(
      () => parseMethodParams('unknown.method', {}),
      (error) => {
        assertProtocolError(error, METHOD_NOT_FOUND.code)
        return true
      },
    )
  })

  it('creates a JSON-RPC success response', () => {
    assert.deepEqual(createSuccessResponse(7, { ok: true }), {
      jsonrpc: '2.0',
      result: { ok: true },
      id: 7,
    })
  })

  it('creates a JSON-RPC error response', () => {
    assert.deepEqual(createErrorResponse(null, PARSE_ERROR), {
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error',
      },
      id: null,
    })
  })

  it('registers every expected Foreman protocol method', () => {
    assert.deepEqual(Object.keys(methodRegistry).sort(), expectedMethods.sort())
  })

  it('validates stats.summary params and result schema', () => {
    // Default params with no args
    assert.deepEqual(parseMethodParams('stats.summary', {}), {})

    // Valid days and limit
    assert.deepEqual(parseMethodParams('stats.summary', { days: 7, limit: 20 }), { days: 7, limit: 20 })
    assert.deepEqual(parseMethodParams('stats.summary', { days: 1 }), { days: 1 })
    assert.deepEqual(parseMethodParams('stats.summary', { days: 365 }), { days: 365 })
    assert.deepEqual(parseMethodParams('stats.summary', { limit: 50 }), { limit: 50 })

    // Invalid days range
    assert.throws(
      () => parseMethodParams('stats.summary', { days: 0 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('stats.summary', { days: 367 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Invalid limit range
    assert.throws(
      () => parseMethodParams('stats.summary', { limit: 0 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodParams('stats.summary', { limit: 51 }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Non-integer values
    assert.throws(
      () => parseMethodParams('stats.summary', { days: '7' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Valid result with reshaped contract
    assert.deepEqual(parseMethodResult('stats.summary', {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-19',
        startAt: '2026-07-19T00:00:00.000Z',
        endAt: '2026-07-20T00:00:00.000Z',
        dispatchCount: 5,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        outcomes: { done: 3, failed: 1, cancelled: 0 },
      },
      byProfile: [{ profile: 'coding', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      byTask: [{ taskName: 'commit', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      daily: [{ dayKey: '2026-07-19', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, outcomes: { done: 2, failed: 0, cancelled: 0 } }],
    }), {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-19',
        startAt: '2026-07-19T00:00:00.000Z',
        endAt: '2026-07-20T00:00:00.000Z',
        dispatchCount: 5,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        outcomes: { done: 3, failed: 1, cancelled: 0 },
      },
      byProfile: [{ profile: 'coding', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      byTask: [{ taskName: 'commit', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      daily: [{ dayKey: '2026-07-19', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, outcomes: { done: 2, failed: 0, cancelled: 0 } }],
    })

    // Invalid result missing required fields
    assert.throws(
      () => parseMethodResult('stats.summary', { source: 'sqlite', today: {}, byProfile: [], byTask: [], daily: [] }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Invalid negative counts in result
    assert.throws(
      () => parseMethodResult('stats.summary', {
        source: 'sqlite',
        today: {
          dayKey: '2026-07-19',
          startAt: '2026-07-19T00:00:00.000Z',
          endAt: '2026-07-20T00:00:00.000Z',
          dispatchCount: -1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          outcomes: { done: 0, failed: 0, cancelled: 0 },
        },
        byProfile: [],
        byTask: [],
        daily: [],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // Valid optional task duration fields in the additive result
    const durationAwareResult = {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-19',
        startAt: '2026-07-19T00:00:00.000Z',
        endAt: '2026-07-20T00:00:00.000Z',
        dispatchCount: 5,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        outcomes: { done: 3, failed: 1, cancelled: 0 },
      },
      byProfile: [{ profile: 'coding', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      byTask: [{ taskName: 'commit', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }],
      daily: [{ dayKey: '2026-07-19', dispatchCount: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, outcomes: { done: 2, failed: 0, cancelled: 0 } }],
      totalTaskDurationMs: 7200000,
      byTaskDuration: [
        { taskName: 'commit', durationMs: 7200000 },
        { taskName: 'review', durationMs: 3600000 },
      ],
    }
    assert.deepEqual(parseMethodResult('stats.summary', durationAwareResult), durationAwareResult)

    // Legacy payloads without the duration fields still validate
    const legacySummary = {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-19',
        startAt: '2026-07-19T00:00:00.000Z',
        endAt: '2026-07-20T00:00:00.000Z',
        dispatchCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        outcomes: { done: 0, failed: 0, cancelled: 0 },
      },
      byProfile: [],
      byTask: [],
      daily: [],
    }
    assert.deepEqual(parseMethodResult('stats.summary', legacySummary), legacySummary)

    // Reject negative, fractional, or malformed duration values
    for (const bad of [
      { ...legacySummary, totalTaskDurationMs: -1 },
      { ...legacySummary, totalTaskDurationMs: 1.5 },
      { ...legacySummary, totalTaskDurationMs: '7200000' },
      { ...legacySummary, byTaskDuration: [{ taskName: 'commit', durationMs: -5 }] },
      { ...legacySummary, byTaskDuration: [{ taskName: 'commit', durationMs: 1.5 }] },
      { ...legacySummary, byTaskDuration: [{ taskName: 'commit' }] },
      { ...legacySummary, byTaskDuration: [{ durationMs: 10 }] },
      { ...legacySummary, byTaskDuration: { taskName: 'commit', durationMs: 10 } },
    ]) {
      assert.throws(
        () => parseMethodResult('stats.summary', bad),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // Additive recent-run ledger rows may carry authoritative project context.
    const ledgerUsage = { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false }
    const projectLedgerResult = {
      ...legacySummary,
      recentRuns: [
        { task_run_id: 'run-1', task: 'commit', project: 'workspace', source: 'project', status: 'done', created_at: '2026-07-19T10:00:00.000Z', usage: ledgerUsage },
        { task_run_id: 'run-2', task: 'edit', source: 'builtin', status: 'failed', created_at: '2026-07-19T09:00:00.000Z', usage: ledgerUsage },
      ],
    }
    assert.deepEqual(parseMethodResult('stats.summary', projectLedgerResult), projectLedgerResult)

    // Rows without a project stay valid for legacy control planes.
    assert.deepEqual(parseMethodResult('stats.summary', {
      ...legacySummary,
      recentRuns: [
        { task_run_id: 'run-3', task: 'legacy', source: 'unknown', status: 'done', created_at: '2026-07-19T08:00:00.000Z', usage: ledgerUsage },
      ],
    }), {
      ...legacySummary,
      recentRuns: [
        { task_run_id: 'run-3', task: 'legacy', source: 'unknown', status: 'done', created_at: '2026-07-19T08:00:00.000Z', usage: ledgerUsage },
      ],
    })

    // Malformed project context is rejected rather than coerced.
    assert.throws(
      () => parseMethodResult('stats.summary', {
        ...legacySummary,
        recentRuns: [
          { task_run_id: 'run-4', task: 'commit', project: 3, source: 'project', status: 'done', created_at: '2026-07-19T07:00:00.000Z', usage: ledgerUsage },
        ],
      }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )

    // The additive legacy resolved_profile scalar round-trips in its exact
    // nonblank stored form alongside the existing optional fields.
    const legacyProfileLedger = {
      ...legacySummary,
      recentRuns: [
        { task_run_id: 'run-legacy', task: 'legacy', source: 'unknown', status: 'done', created_at: '2026-07-19T06:00:00.000Z', resolved_profile: 'legacy-clean', usage: ledgerUsage },
        { task_run_id: 'run-modern', task: 'edit', source: 'builtin', status: 'done', created_at: '2026-07-19T06:30:00.000Z', resolved_profile: 'cb-dsf', usage: ledgerUsage },
      ],
    }
    assert.deepEqual(parseMethodResult('stats.summary', legacyProfileLedger), legacyProfileLedger)

    // Malformed resolved_profile (non-string, empty, or null) is rejected
    // rather than coerced, mirroring the project-context guard.
    for (const badProfile of [3, '', null]) {
      assert.throws(
        () => parseMethodResult('stats.summary', {
          ...legacySummary,
          recentRuns: [
            { task_run_id: 'run-bad-profile', task: 'commit', source: 'project', status: 'done', created_at: '2026-07-19T05:00:00.000Z', resolved_profile: badProfile, usage: ledgerUsage },
          ],
        }),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }
  })

  it('accepts paired recent-run display names and a strict complete auto_routing decision, rejecting malformed ones', () => {
    const baseResult = {
      source: 'sqlite',
      today: {
        dayKey: '2026-07-19',
        startAt: '2026-07-19T00:00:00.000Z',
        endAt: '2026-07-20T00:00:00.000Z',
        dispatchCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        outcomes: { done: 0, failed: 0, cancelled: 0 },
      },
      byProfile: [],
      byTask: [],
      daily: [],
    }
    const ledgerUsage = { completeness: 'unavailable', attempt_count: 0, usage_event_count: 0, reference_cost_complete: false }
    const resolvedBase = {
      requested_agent_runtime: 'forge/codebuddy',
      profile: 'auto',
      client: 'codebuddy',
      provider: 'codebuddy',
      model: 'deepseek-v4-flash',
      model_id: 'codebuddy/deepseek-v4-flash',
      mode: 'native',
      speed: { effective_tps: 45, source: 'catalog_default', sample_count: 7, checked_at: '2026-07-19T00:00:00.000Z', expected_tps_met: true },
      intelligence: 'mid',
      reference_pricing: { input_usd_per_million: 0.2, output_usd_per_million: 1.2, source: 'catalog', checked_at: '2026-07-19T00:00:00.000Z' },
    }
    const decision = {
      snapshot_id: 'snap-1',
      selected_rank: 1,
      supply_class: 'confirmed_free',
      quota_tier: 'healthy',
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 1.5,
      routing_output_usd_per_million: 1.25,
      effective_cap_usd_per_million: 1.6,
      score: 9.5,
      reasons: ['rank-1'],
    }
    const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      task_run_id: 'run-1',
      task: 'commit',
      source: 'builtin',
      status: 'done',
      created_at: '2026-07-19T10:00:00.000Z',
      usage: ledgerUsage,
      ...overrides,
    })
    const summary = (recentRuns: unknown[]): Record<string, unknown> => ({ ...baseResult, recentRuns })

    // Both additive additions absent remains valid (backwards compatible).
    const plainRow = row({})
    assert.deepEqual(parseMethodResult('stats.summary', summary([plainRow])), summary([plainRow]))

    // Paired display-name strings round-trip.
    const labeledRow = row({ provider_display_name: 'CodeBuddy', model_display_name: 'DeepSeek V4 Flash' })
    assert.deepEqual(parseMethodResult('stats.summary', summary([labeledRow])), summary([labeledRow]))

    // A complete safe auto_routing decision inside `resolved` round-trips.
    const decisionRow = row({ resolved: { ...resolvedBase, auto_routing: decision } })
    assert.deepEqual(parseMethodResult('stats.summary', summary([decisionRow])), summary([decisionRow]))

    // Paired display names together with a full resolved decision stay valid.
    const fullRow = row({
      provider_display_name: 'CodeBuddy',
      model_display_name: 'DeepSeek V4 Flash',
      resolved: { ...resolvedBase, auto_routing: decision },
    })
    assert.deepEqual(parseMethodResult('stats.summary', summary([fullRow])), summary([fullRow]))

    // Malformed auto_routing decisions are rejected: extra fields, missing
    // required fields, wrong enums, and non-string reasons.
    const decisionMissingReasons = {
      snapshot_id: 'snap-1',
      selected_rank: 1,
      supply_class: 'confirmed_free',
      quota_tier: 'healthy',
      quota_coverage_complete: true,
      quota_headroom_trusted: true,
      reference_output_usd_per_million: 1.5,
      routing_output_usd_per_million: 1.25,
      effective_cap_usd_per_million: 1.6,
      score: 9.5,
    }
    const badDecisions: unknown[] = [
      { ...decision, tampered: true },
      decisionMissingReasons,
      { ...decision, supply_class: 'premium' },
      { ...decision, quota_tier: 'exhausted' },
      { ...decision, score: '9.5' },
      { ...decision, reasons: [1] },
      { ...decision, reasons: 'rank-1' },
    ]
    for (const auto_routing of badDecisions) {
      assert.throws(
        () => parseMethodResult('stats.summary', summary([row({ resolved: { ...resolvedBase, auto_routing } })])),
        (error) => {
          assertProtocolError(error, INVALID_PARAMS.code)
          return true
        },
      )
    }

    // Extra resolved-level decision fields and non-string display names fail.
    assert.throws(
      () => parseMethodResult('stats.summary', summary([row({ resolved: { ...resolvedBase, auto_routing: { ...decision, supplier_hint: 'x' } } })])),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodResult('stats.summary', summary([row({ provider_display_name: 3, model_display_name: 'DeepSeek V4 Flash' })])),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
    assert.throws(
      () => parseMethodResult('stats.summary', summary([row({ provider_display_name: 'CodeBuddy', model_display_name: false })])),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('keeps lib/protocol free of runtime imports', () => {
    const protocolRoot = join(process.cwd(), 'lib', 'protocol')
    const forbiddenSpecifiers = [
      'node:fs',
      'node:path',
      'node:process',
    ]
    const forbiddenRuntimePath = /(^|\/|\\)(client|server|core|db|executor|notify|config)(\/|\\|\.mts$)/

    for (const file of listMtsFiles(protocolRoot)) {
      const source = readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/\b(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      for (const specifier of importSpecifiers) {
        const crossesProtocolBoundary = specifier.startsWith('../') || specifier.startsWith('..\\')
        assert(
          !forbiddenSpecifiers.includes(specifier)
            && !(crossesProtocolBoundary && forbiddenRuntimePath.test(specifier)),
          `${file} imports forbidden runtime dependency ${specifier}`,
        )
      }
    }
  })
})
