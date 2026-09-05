import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePositiveIntegerFlag, requireNoPositionals, requireSinglePositional } from '../lib/client/cli/helpers.mts'
import {
  errorMessage,
} from '../lib/client/cli/shared.mts'
import { readFileSync } from 'node:fs'
import { INVALID_PARAMS, ProtocolError } from '../lib/protocol/errors.mts'

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

test('CLI task run waits for the terminal result without status polling or follow-up hints', () => {
  const taskSource = readFileSync(new URL('../lib/client/cli/commands/task.mts', import.meta.url), 'utf8')
  const sharedSource = readFileSync(new URL('../lib/client/cli/shared.mts', import.meta.url), 'utf8')

  // handleTaskRun invokes client.task.run.wait after creating the run.
  const runStart = taskSource.indexOf('export async function handleTaskRun')
  const runEnd = taskSource.indexOf('export async function handleTaskCancel')
  assert.ok(runStart >= 0 && runEnd > runStart, 'handleTaskRun must be present in the task command')
  const runBody = taskSource.slice(runStart, runEnd)
  const createIndex = runBody.indexOf('client.task.run.create')
  const waitIndex = runBody.indexOf('client.task.run.wait')
  assert.ok(createIndex >= 0, 'handleTaskRun must create the task run')
  assert.ok(waitIndex > createIndex, 'handleTaskRun must wait on the server after creating the run')

  // It prints the terminal result.
  assert.ok(runBody.includes('writeServicePayload(result)'), 'handleTaskRun must print the terminal result')

  // No leftover client-side 100ms status polling inside handleTaskRun.
  assert.ok(!runBody.includes('task.run.status'), 'handleTaskRun must not poll task status')

  // Neither file defines/references the removed polling helper, polling, or follow-up hint.
  assert.ok(!sharedSource.includes('waitForTaskCompletionViaIpc'), 'shared must not define waitForTaskCompletionViaIpc')
  assert.ok(!taskSource.includes('waitForTaskCompletionViaIpc'), 'task command must not reference waitForTaskCompletionViaIpc')
  assert.ok(!taskSource.includes('Use wrenyard task output'), 'task run must not emit the follow-up output hint')
  assert.ok(!taskSource.includes('to fetch the task result'), 'task run must not reference fetching the result')
})
