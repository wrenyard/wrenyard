import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PARSE_ERROR } from '../../lib/protocol/errors.mts'
import {
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcMessage,
  parseMethodParams,
} from '../../lib/protocol/validate.mts'

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

    // Automatic mode with dispatch constraints round-trips too.
    const automaticLayer = {
      mode: 'automatic',
      timeout_ms: 120_000,
      automatic: {
        expected_tps: 30,
        intelligence_min: 'mid',
        intelligence_expected: 'high',
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
})
