import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTaskPromptTemplate,
  withTaskPromptTemplates,
  getTaskPromptTemplates,
  type TaskPromptTemplate,
} from '../../lib/core/task/prompt-template.mts'

test('renderTaskPromptTemplate interpolates values between fragments', () => {
  const template: TaskPromptTemplate = {
    strings: ['Hello ', ', you are ', ' years old.'],
    label: 'greeting',
  }
  const result = renderTaskPromptTemplate(template, ['Ada', '36'])
  assert.equal(result, 'Hello Ada, you are 36 years old.')
})

test('renderTaskPromptTemplate handles undefined and null values', () => {
  const template: TaskPromptTemplate = { strings: ['a', 'b', 'c'] }
  const result = renderTaskPromptTemplate(template, [undefined, null])
  assert.equal(result, 'aundefinedbnullc')
})

test('renderTaskPromptTemplate handles Unicode values and fragments', () => {
  const template: TaskPromptTemplate = { strings: ['日本語', '→', '🌟'] }
  const result = renderTaskPromptTemplate(template, ['漢字', 'é'])
  assert.equal(result, '日本語漢字→é🌟')
})

test('renderTaskPromptTemplate preserves embedded markdown', () => {
  const template: TaskPromptTemplate = {
    strings: ['## Title\n\nRun `', '` with _', '_ emphasis.\n'],
    label: 'md',
  }
  const result = renderTaskPromptTemplate(template, ['ls -la', 'code'])
  assert.equal(result, '## Title\n\nRun `ls -la` with _code_ emphasis.\n')
})

test('renderTaskPromptTemplate handles empty fragments and values', () => {
  const template: TaskPromptTemplate = { strings: ['', '', ''] }
  const result = renderTaskPromptTemplate(template, ['', ''])
  assert.equal(result, '')
})

test('renderTaskPromptTemplate throws on arity mismatch (too few values)', () => {
  const template: TaskPromptTemplate = { strings: ['x', 'y', 'z'] }
  assert.throws(() => renderTaskPromptTemplate(template, ['only-one']), /Task prompt template arity mismatch/)
})

test('renderTaskPromptTemplate throws on arity mismatch (too many values)', () => {
  const template: TaskPromptTemplate = { strings: ['x', 'y'] }
  assert.throws(() => renderTaskPromptTemplate(template, ['a', 'b', 'c']), /Task prompt template arity mismatch/)
})

test('withTaskPromptTemplates returns the same callable and attaches static metadata', () => {
  let called = false
  const callback = (input: string): string => {
    called = true
    return input.toUpperCase()
  }
  const templates: TaskPromptTemplate[] = [{ strings: ['prefix ', ''], label: 'p' }]
  const wrapped = withTaskPromptTemplates(callback, templates)
  assert.equal(typeof wrapped, 'function')
  assert.deepEqual(getTaskPromptTemplates(wrapped), templates)
  assert.equal(called, false)
  assert.equal(wrapped('hi'), 'HI')
  assert.equal(called, true)
})

test('getTaskPromptTemplates returns [] for an unknown dynamic function', () => {
  const noop = () => 0
  assert.deepEqual(getTaskPromptTemplates(noop), [])
})

test('getTaskPromptTemplates returns [] for a non-function value', () => {
  assert.deepEqual(getTaskPromptTemplates(null), [])
  assert.deepEqual(getTaskPromptTemplates({}), [])
})

test('withTaskPromptTemplates preserves an async callback unchanged and callable', async () => {
  const asyncCallback = async (n: number): Promise<number> => n * 2
  const templates: TaskPromptTemplate[] = [{ strings: ['v=', ''], label: 'async' }]
  const wrapped = withTaskPromptTemplates(asyncCallback, templates)
  assert.equal(typeof wrapped, 'function')
  assert.deepEqual(getTaskPromptTemplates(wrapped), templates)
  assert.equal(await wrapped(21), 42)
})

test('all active builtins expose actual task body fragments without prompt execution', async () => {
  const { BUILTIN_TASKS } = await import('../../lib/standard/index.mts')
  const { taskInstructionTemplate } = await import('../../lib/daemon/services/task-settings-service.mts')
  for (const { name, definition } of BUILTIN_TASKS) {
    if (definition.config.scheduling === 'legacy') continue
    const templates = getTaskPromptTemplates(definition.config.prompt)
    assert.ok(templates.length > 0, `${name} has declared static templates`)
    const segments = taskInstructionTemplate(definition.config)
    assert.ok(segments.some((segment) => segment.kind === 'text' && segment.source.startsWith('task.prompt[')), name)
    for (const template of templates) assert.equal(template.labels?.length, template.strings.length - 1, name)
  }
})

test('settings preview never invokes an input-dependent callback and retains fallback for custom prompts', async () => {
  const { taskInstructionTemplate } = await import('../../lib/daemon/services/task-settings-service.mts')
  const callback = () => { throw new Error('preview must not execute') }
  const template = { strings: ['## Task\n', '\n## Steps\nRead the target.'], labels: ['目标输入'] }
  assert.deepEqual(taskInstructionTemplate({ prompt: callback }), [
    { kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' },
  ])
  const preview = taskInstructionTemplate({ prompt: withTaskPromptTemplates(callback, [template]) })
  assert.deepEqual(preview.map((segment) => segment.kind), ['text', 'placeholder', 'text'])
  assert.ok(preview.some((segment) => segment.kind === 'placeholder' && segment.label === '目标输入'))
})
