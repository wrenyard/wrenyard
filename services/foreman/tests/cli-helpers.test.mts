import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePositiveIntegerFlag, requireNoPositionals, requireSinglePositional } from '../lib/client/cli/helpers.mts'
import {
  type IpcForemanClient,
  errorMessage,
  waitForTaskCompletionViaIpc,
} from '../lib/client/cli/shared.mts'
import { INVALID_PARAMS, ProtocolError } from '../lib/protocol/errors.mts'

function smallDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

test('parsePositiveIntegerFlag accepts missing and positive integer values', () => {
  assert.equal(parsePositiveIntegerFlag(undefined, '--lines', 80), 80)
  assert.equal(parsePositiveIntegerFlag('1', '--lines', 80), 1)
  assert.equal(parsePositiveIntegerFlag('120', '--lines', 80), 120)
})

test('parsePositiveIntegerFlag rejects invalid positive integer values', () => {
  assert.throws(() => parsePositiveIntegerFlag('', '--lines', 80), /--lines must be a positive integer/u)
  assert.throws(() => parsePositiveIntegerFlag('0', '--lines', 80), /--lines must be a positive integer/u)
  assert.throws(() => parsePositiveIntegerFlag('abc', '--lines', 80), /--lines must be a positive integer/u)
  assert.throws(() => parsePositiveIntegerFlag('1.5', '--lines', 80), /--lines must be a positive integer/u)
  assert.throws(() => parsePositiveIntegerFlag('-1', '--lines', 80), /--lines must be a positive integer/u)
})

test('requireSinglePositional accepts exactly one positional argument', () => {
  assert.equal(requireSinglePositional(['task_run_123'], 'wrenyard task status <task_run_id>'), 'task_run_123')
})

test('requireSinglePositional rejects missing or extra positional arguments', () => {
  assert.throws(
    () => requireSinglePositional([], 'wrenyard task status <task_run_id>'),
    /Usage: wrenyard task status <task_run_id>/u,
  )
  assert.throws(
    () => requireSinglePositional(['task_run_123', 'extra'], 'wrenyard task status <task_run_id>'),
    /Unexpected positional argument: extra/u,
  )
})

test('requireNoPositionals rejects unexpected positional arguments', () => {
  requireNoPositionals([], 'wrenyard status')
  assert.throws(
    () => requireNoPositionals(['extra'], 'wrenyard status'),
    /Unexpected positional argument: extra/u,
  )
})

test('errorMessage appends structured ProtocolError validation paths', () => {
  const error = new ProtocolError(INVALID_PARAMS, {
    method: 'taskgraph.create',
    details: ['/graph/nodes/n1/name must be a string', '/graph/nodes/n1/deps must be an array'],
  })
  assert.equal(
    errorMessage(error),
    'Invalid params: /graph/nodes/n1/name must be a string; /graph/nodes/n1/deps must be an array',
  )
})

test('errorMessage keeps multiple deterministic validation paths in order', () => {
  const error = new ProtocolError(INVALID_PARAMS, {
    method: 'taskgraph.create',
    details: ['/graph/nodes/n1/input/0/source must be a string', '/graph/nodes/n2/name is required'],
  })
  const message = errorMessage(error)
  assert.ok(message.startsWith('Invalid params: '))
  assert.ok(message.indexOf('/graph/nodes/n1/input/0/source must be a string')
    < message.indexOf('/graph/nodes/n2/name is required'))
})

test('errorMessage leaves a ProtocolError without details unchanged', () => {
  const bare = new ProtocolError(INVALID_PARAMS)
  assert.equal(errorMessage(bare), 'Invalid params')
  const noDetails = new ProtocolError(INVALID_PARAMS, { method: 'taskgraph.create' })
  assert.equal(errorMessage(noDetails), 'Invalid params')
})

test('errorMessage ignores malformed or non-array protocol details', () => {
  const nonArray = new ProtocolError(INVALID_PARAMS, { method: 'taskgraph.create', details: 'nope' })
  assert.equal(errorMessage(nonArray), 'Invalid params')
  const objectDetails = new ProtocolError(INVALID_PARAMS, {
    method: 'taskgraph.create',
    details: { secret: 'do-not-print' },
  })
  assert.equal(errorMessage(objectDetails), 'Invalid params')
  const mixed = new ProtocolError(INVALID_PARAMS, {
    method: 'taskgraph.create',
    details: ['/graph/nodes/n1/name must be a string', { nested: true }, 42],
  })
  assert.equal(
    errorMessage(mixed),
    'Invalid params: /graph/nodes/n1/name must be a string',
  )
})

test('errorMessage preserves the ordinary Error message path', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('raw string'), 'raw string')
  assert.equal(errorMessage(null), 'null')
})

test('waitForTaskCompletionViaIpc keeps polling through nonterminal task statuses', { timeout: 2_000 }, async () => {
  const statuses = [
    { status: 'queued', task_run_id: 'task-run-1' },
    { status: 'running', task_run_id: 'task-run-1' },
    { status: 'done', task_run_id: 'task-run-1', has_output: true },
  ]
  let statusCalls = 0
  let currentTime = 0
  const originalDateNow = Date.now
  Date.now = () => currentTime
  const client = {
    task: {
      run: {
        status: async ({ task_run_id }: { task_run_id: string }) => {
          assert.equal(task_run_id, 'task-run-1')
          if (statusCalls >= statuses.length) throw new Error('status called beyond supplied sequence')
          const status = statuses[statusCalls++]
          if (statusCalls === 2) currentTime = 30_001
          await smallDelay()
          return status
        },
      },
    },
  } as unknown as IpcForemanClient

  try {
    const status = await waitForTaskCompletionViaIpc(client, 'task-run-1')

    assert.deepEqual(status, statuses[2])
    assert.equal(statusCalls, 3)
  } finally {
    Date.now = originalDateNow
  }
})
