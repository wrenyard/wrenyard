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
  TASK_TIMEOUT_SCOPE,
} from '../../lib/task-timeouts.mts'

const expectedMethods = [
  'agent.compact',
  'agent.graph.review',
  'agent.list',
  'agent.model.list',
  'agent.model.set',
  'agent.sync',
  'activity.snapshot',
  'daemon.drain',
  'daemon.freeze',
  'daemon.shutdown',
  'daemon.status',
  'daemon.thaw',
  'health.ping',
  'event.list',
  'fwa.list',
  'fwa.assign',
  'fwa.status',
  'fwa.transcript',
  'stats.today',
  'stats.summary',
  'task.definition.list',
  'task.definition.describe',
  'task.run.create',
  'task.run.list',
  'task.run.status',
  'task.run.output',
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
  'pet.status',
  'pet.start',
  'pet.stop',
  'pet.restart',
  'pm.ticket.create',
  'pm.ticket.get',
  'pm.ticket.list',
  'pm.ticket.update',
  'pm.ticket.delete',
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
      timeoutScope: TASK_TIMEOUT_SCOPE,
    }]), [{
      name: 'commit',
      source: 'workspace',
      effectiveTimeoutMs: STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: TASK_TIMEOUT_SCOPE,
    }])

    assert.deepEqual(parseMethodResult('task.definition.describe', {
      name: 'commit',
      source: 'workspace',
      path: '/tmp/commit.task.ts',
      permission: 'readonly',
      timeoutMs: 7200000,
      effectiveTimeoutMs: 7200000,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: TASK_TIMEOUT_SCOPE,
    }), {
      name: 'commit',
      source: 'workspace',
      path: '/tmp/commit.task.ts',
      permission: 'readonly',
      timeoutMs: 7200000,
      effectiveTimeoutMs: 7200000,
      structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
      timeoutScope: TASK_TIMEOUT_SCOPE,
    })

    assert.deepEqual(parseMethodResult('task.run.status', {
      task_run_id: 'task_1234',
      status: 'done',
      has_output: true,
    }), {
      task_run_id: 'task_1234',
      status: 'done',
      has_output: true,
    })

    assert.deepEqual(parseMethodResult('task.run.output', {
      task_run_id: 'task_1234',
      status: 'done',
      output: { result: 'ok' },
    }), {
      task_run_id: 'task_1234',
      status: 'done',
      output: { result: 'ok' },
    })

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
      gitRemote: 'https://example.test/foreman.git',
    }]), [{
      name: 'foreman',
      path: '/tmp/foreman',
      gitRemote: 'https://example.test/foreman.git',
    }])

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

  it('parses pm.ticket.create params with main kind (with assignee)', () => {
    const params = parseMethodParams('pm.ticket.create', {
      kind: 'main',
      project_id: 'foreman',
      title: 'Fix login bug',
      description: 'Users cannot log in',
      assignee: { session_id: 'sess_abc' },
    })
    assert.deepEqual(params, {
      kind: 'main',
      project_id: 'foreman',
      title: 'Fix login bug',
      description: 'Users cannot log in',
      assignee: { session_id: 'sess_abc' },
    })
  })

  it('parses pm.ticket.create params with sub kind', () => {
    const params = parseMethodParams('pm.ticket.create', {
      kind: 'sub',
      project_id: 'foreman',
      title: 'Sub task',
      parent_id: 'pm_abc',
    })
    assert.deepEqual(params, {
      kind: 'sub',
      project_id: 'foreman',
      title: 'Sub task',
      parent_id: 'pm_abc',
    })
  })

  it('parses pm.ticket.list params', () => {
    const params = parseMethodParams('pm.ticket.list', {
      project_id: 'foreman',
      status: 'todo',
    })
    assert.deepEqual(params, {
      project_id: 'foreman',
      status: 'todo',
    })
  })

  it('rejects pm.ticket.list without project_id', () => {
    assert.throws(
      () => parseMethodParams('pm.ticket.list', {}),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('parses pm.ticket.update params with edit action', () => {
    const params = parseMethodParams('pm.ticket.update', {
      id: 'pm_abc',
      action: 'edit',
      title: 'Updated title',
      description: null,
    })
    assert.deepEqual(params, {
      id: 'pm_abc',
      action: 'edit',
      title: 'Updated title',
      description: null,
    })
  })

  it('parses pm.ticket.update params with set_status action', () => {
    const params = parseMethodParams('pm.ticket.update', {
      id: 'pm_abc',
      action: 'set_status',
      status: 'in_progress',
    })
    assert.deepEqual(params, {
      id: 'pm_abc',
      action: 'set_status',
      status: 'in_progress',
    })
  })

  it('rejects pm.ticket.update without action', () => {
    assert.throws(
      () => parseMethodParams('pm.ticket.update', { id: 'pm_abc' }),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('parses pm.ticket.delete params', () => {
    const params = parseMethodParams('pm.ticket.delete', { id: 'pm_abc' })
    assert.deepEqual(params, { id: 'pm_abc' })
  })

  it('rejects pm.ticket.get without id', () => {
    assert.throws(
      () => parseMethodParams('pm.ticket.get', {}),
      (error) => {
        assertProtocolError(error, INVALID_PARAMS.code)
        return true
      },
    )
  })

  it('validates pm.ticket result shapes', () => {
    assert.deepEqual(parseMethodResult('pm.ticket.create', {
      ticket: {
        id: 'pm_abc',
        kind: 'main',
        project_id: 'foreman',
        title: 'Fix login',
        status: 'todo',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      },
    }), {
      ticket: {
        id: 'pm_abc',
        kind: 'main',
        project_id: 'foreman',
        title: 'Fix login',
        status: 'todo',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      },
    })
    assert.deepEqual(parseMethodResult('pm.ticket.list', {
      tickets: [],
      count: 0,
    }), { tickets: [], count: 0 })
    assert.deepEqual(parseMethodResult('pm.ticket.delete', {
      deleted: true,
      id: 'pm_abc',
    }), { deleted: true, id: 'pm_abc' })
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

  it('validates pet lifecycle control params and status results', () => {
    assert.deepEqual(parseMethodParams('pet.start', {}), {})
    assert.deepEqual(parseMethodResult('pet.status', {
      state: 'running',
      enabled: true,
      running: true,
      transport: 'ipc-jsonrpc',
      command: 'npm',
      args: ['start'],
      cwd: '/tmp/foreman-pet',
    }), {
      state: 'running',
      enabled: true,
      running: true,
      transport: 'ipc-jsonrpc',
      command: 'npm',
      args: ['start'],
      cwd: '/tmp/foreman-pet',
    })
    assert.deepEqual(parseMethodResult('pet.stop', {
      ok: true,
      status: {
        state: 'stopped',
        enabled: false,
        running: false,
        transport: 'ipc-jsonrpc',
        command: 'npm',
        args: ['start'],
        cwd: '/tmp/foreman-pet',
      },
    }), {
      ok: true,
      status: {
        state: 'stopped',
        enabled: false,
        running: false,
        transport: 'ipc-jsonrpc',
        command: 'npm',
        args: ['start'],
        cwd: '/tmp/foreman-pet',
      },
    })
  })

  it('validates stats.summary params and result schema', () => {
    // Default params with no args
    assert.deepEqual(parseMethodParams('stats.summary', {}), {})

    // Valid days and limit
    assert.deepEqual(parseMethodParams('stats.summary', { days: 7, limit: 20 }), { days: 7, limit: 20 })
    assert.deepEqual(parseMethodParams('stats.summary', { days: 1 }), { days: 1 })
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
      () => parseMethodParams('stats.summary', { days: 32 }),
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
