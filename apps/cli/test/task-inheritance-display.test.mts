import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { taskListEffectiveId } from '../src/commands/task.mts'
import { field, servicePayload, taskListRows } from '../src/shared.mts'

test('task list keeps the actual id and appends an English inherited marker', () => {
  // A non-inherited row is unchanged.
  assert.equal(
    taskListEffectiveId({ name: 'echo', project: 'app', source: 'project' }),
    'echo',
  )
  // An inherited row appends a readable English marker without rewriting the id.
  assert.equal(
    taskListEffectiveId({ name: 'echo', project: 'app', source: 'project', inheritanceChain: [{ source: 'builtin', path: '(builtin)' }] }),
    'echo (inherited)',
  )
  // A missing name falls back to the id, and the marker still preserves it.
  assert.equal(
    taskListEffectiveId({ id: 'project:app:echo', inheritanceChain: [{ source: 'builtin', path: '(builtin)' }] }),
    'project:app:echo (inherited)',
  )
})

test('inherited list rows retain effective project and source for the human row', () => {
  const rows = taskListRows({
    tasks: [{ name: 'echo', project: 'app', source: 'project', description: 'Echo.', inheritanceChain: [{ source: 'builtin', path: '(builtin)' }] }],
  })
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(field(row, ['project']), 'app')
  assert.equal(field(row, ['source']), 'project')
  assert.equal(field(row, ['description']), 'Echo.')
  assert.equal(taskListEffectiveId(row), 'echo (inherited)')
})

test('describe metadata passes through unchanged, including the inheritance chain', () => {
  const detail = {
    name: 'echo',
    source: 'project',
    project: 'app',
    inheritanceChain: [
      { source: 'builtin', path: '/tasks/shell/echo.task.ts' },
      { source: 'project', project: 'app', path: '/projects/app/echo.task.ts' },
    ],
  }
  const payload = servicePayload(detail)
  // The exact object is forwarded without reshaping.
  assert.equal(payload.value, detail)
  assert.deepEqual(payload.value, detail)

  // handleTaskDescribe forwards the raw protocol result through servicePayload
  // and never rewrites or strips the inheritance metadata.
  const source = readFileSync(new URL('../src/commands/task.mts', import.meta.url), 'utf8')
  const start = source.indexOf('export async function handleTaskDescribe')
  const end = source.indexOf('export async function handleTaskRun')
  assert.ok(start >= 0 && end > start, 'handleTaskDescribe must be present')
  const body = source.slice(start, end)
  assert.match(body, /writeServicePayload\(servicePayload\(await client\.task\.definition\.describe\(/)
  assert.doesNotMatch(body, /inheritanceChain|inherited/u)
})
